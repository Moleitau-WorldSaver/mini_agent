import type { ModelAdapter } from '../model/adapter.js';
import type { ModelRequest, ModelResponse, Session, ToolCall, ToolResult, ToolSchema } from '../types.js';
import { applyTitle, touchSession } from '../session/session.js';
import { TurnCancelledError } from './errors.js';
import {
  buildSystemPrompt,
  compressionTriggered,
  countContextChars,
  estimateTokens,
  findCompressionCut,
  summarizeMessages,
} from './context.js';

export interface ToolExecutor {
  schemas(): ToolSchema[];
  execute(call: ToolCall, session: Session): Promise<ToolResult>;
}

export type TurnEndReason = 'final' | 'max_steps' | 'error' | 'length' | 'cancelled';

export type RuntimeEvent =
  | {
      type: 'llm';
      turnId: string;
      step: number;
      durationMs: number;
      request: { messageCount: number; toolCount: number; thinking: boolean; contextChars: number };
      response: ModelResponse;
    }
  | { type: 'tool'; turnId: string; step: number; durationMs: number; call: ToolCall; result: ToolResult }
  | {
      type: 'error';
      turnId: string;
      step: number;
      error: { name: string; message: string; status?: number; retryable?: boolean };
    }
  | { type: 'turn_end'; turnId: string; steps: number; reason: TurnEndReason }
  | { type: 'cancelled'; turnId: string; step: number }
  | {
      type: 'compression';
      turnId: string;
      step: number;
      removedMessages: number;
      keptMessages: number;
      summaryChars: number;
      durationMs: number;
      fallback: boolean;
      error?: string;
    };

export interface RuntimeOptions {
  system: string;
  maxSteps: number;
  maxTokens: number;
  tools?: ToolExecutor;
  contextTokens?: number;
  keepRecent?: number;
  compression?: boolean;
  onSessionUpdated?: (session: Session) => Promise<void> | void;
  onEvent?: (event: RuntimeEvent) => Promise<void> | void;
}

export interface TurnResult {
  content: string;
  steps: number;
  finishReason: string;
  reasoningContent: string | null;
}

export class AgentRuntime {
  private readonly adapter: ModelAdapter;
  private readonly options: RuntimeOptions;

  constructor(adapter: ModelAdapter, options: RuntimeOptions) {
    this.adapter = adapter;
    this.options = options;
  }

  async runTurn(session: Session, input: string, options: { signal?: AbortSignal } = {}): Promise<TurnResult> {
    const turnId = `turn-${++session.turnSeq}`;
    applyTitle(session, input);
    session.messages.push({ role: 'user', content: input, turnId });
    touchSession(session);
    await this.persist(session);

    let lastReasoning: string | null = null;
    let step = 0;

    try {
      for (step = 1; step <= this.options.maxSteps; step += 1) {
        if (options.signal?.aborted) {
          throw new TurnCancelledError();
        }
        if (this.options.compression !== false) {
          await this.compressIfNeeded(session, turnId, step);
        }

        const system = buildSystemPrompt(this.options.system, session.summary);
        const requestMessages = [...session.messages];
        const toolSchemas = this.options.tools?.schemas() ?? [];
        const startedAt = Date.now();

        const response = await this.callModel(
          {
            system,
            messages: requestMessages,
            tools: toolSchemas,
            thinking: session.thinking,
            maxTokens: this.options.maxTokens,
            signal: options.signal,
          },
          turnId,
          step,
        );
        lastReasoning = response.reasoningContent;

        await this.emit({
          type: 'llm',
          turnId,
          step,
          durationMs: Date.now() - startedAt,
          request: {
            messageCount: requestMessages.length,
            toolCount: toolSchemas.length,
            thinking: session.thinking,
            contextChars: countContextChars(system, requestMessages, toolSchemas),
          },
          response,
        });

        if (response.finishReason === 'length') {
          if (response.toolCalls.length > 0) {
            throw new Error('模型输出在工具调用中途被截断');
          }
          const partial = response.content ?? '';
          session.messages.push({
            role: 'assistant',
            content: partial,
            reasoningContent: response.reasoningContent,
            turnId,
            step,
          });
          touchSession(session);
          await this.persist(session);
          await this.emit({ type: 'turn_end', turnId, steps: step, reason: 'length' });
          const notice = partial
            ? `${partial}\n\n（输出达到长度上限，已截断）`
            : '（输出达到长度上限，已截断）';
          return { content: notice, steps: step, finishReason: 'length', reasoningContent: lastReasoning };
        }

        if (response.toolCalls.length > 0) {
          session.messages.push({
            role: 'assistant',
            content: response.content,
            reasoningContent: response.reasoningContent,
            toolCalls: response.toolCalls,
            turnId,
            step,
          });

          for (let callIndex = 0; callIndex < response.toolCalls.length; callIndex += 1) {
            if (options.signal?.aborted) {
              for (const pending of response.toolCalls.slice(callIndex)) {
                session.messages.push({
                  role: 'tool',
                  toolCallId: pending.id,
                  name: pending.name,
                  content: JSON.stringify({ error: '已取消' }),
                  isError: true,
                  turnId,
                  step,
                });
              }
              touchSession(session);
              await this.persist(session);
              throw new TurnCancelledError();
            }

            const call = response.toolCalls[callIndex]!;
            const toolStartedAt = Date.now();
            const result = await this.executeTool(call, session);
            await this.emit({
              type: 'tool',
              turnId,
              step,
              durationMs: Date.now() - toolStartedAt,
              call,
              result,
            });
            session.messages.push({
              role: 'tool',
              toolCallId: call.id,
              name: call.name,
              content: result.content,
              isError: result.isError,
              turnId,
              step,
            });
          }

          touchSession(session);
          await this.persist(session);
          continue;
        }

        const content = response.content ?? '';
        session.messages.push({
          role: 'assistant',
          content,
          reasoningContent: response.reasoningContent,
          turnId,
          step,
        });
        touchSession(session);
        await this.persist(session);
        await this.emit({ type: 'turn_end', turnId, steps: step, reason: 'final' });
        return { content, steps: step, finishReason: response.finishReason, reasoningContent: lastReasoning };
      }

      const notice = `（已达步数上限 ${this.options.maxSteps}，本轮停止。以上为已完成的进度。）`;
      session.messages.push({
        role: 'assistant',
        content: notice,
        reasoningContent: '',
        turnId,
        step: this.options.maxSteps,
      });
      touchSession(session);
      await this.persist(session);
      await this.emit({ type: 'turn_end', turnId, steps: this.options.maxSteps, reason: 'max_steps' });
      return {
        content: notice,
        steps: this.options.maxSteps,
        finishReason: 'max_steps',
        reasoningContent: lastReasoning,
      };
    } catch (error) {
      const cancelled = error instanceof TurnCancelledError || options.signal?.aborted === true;
      if (cancelled) {
        await this.emit({ type: 'cancelled', turnId, step: Math.max(step, 1) });
        await this.emit({ type: 'turn_end', turnId, steps: step, reason: 'cancelled' });
        throw error instanceof TurnCancelledError ? error : new TurnCancelledError();
      }

      const detail = error as { name?: string; message?: string; status?: number; retryable?: boolean };
      await this.emit({
        type: 'error',
        turnId,
        step: Math.max(step, 1),
        error: {
          name: detail.name ?? 'Error',
          message: detail.message ?? String(error),
          status: detail.status,
          retryable: detail.retryable,
        },
      });
      await this.emit({ type: 'turn_end', turnId, steps: step, reason: 'error' });
      throw error;
    }
  }

  private async callModel(request: ModelRequest, turnId: string, step: number): Promise<ModelResponse> {
    let response = await this.adapter.complete(request);
    if (!isEmptyResponse(response)) {
      return response;
    }

    await this.emit({
      type: 'error',
      turnId,
      step,
      error: { name: 'EmptyResponse', message: '模型返回空响应，重试一次', retryable: true },
    });

    response = await this.adapter.complete(request);
    if (!isEmptyResponse(response)) {
      return response;
    }

    throw new Error('模型返回了空响应');
  }

  private async compressIfNeeded(session: Session, turnId: string, step: number): Promise<void> {
    const toolSchemas = this.options.tools?.schemas() ?? [];
    const system = buildSystemPrompt(this.options.system, session.summary);
    const tokens = estimateTokens(system, session.messages, toolSchemas);
    if (!compressionTriggered(tokens, session.messages.length, this.options.contextTokens ?? 32768)) {
      return;
    }

    const cut = findCompressionCut(session.messages, this.options.keepRecent ?? 8);
    if (cut <= 0) {
      return;
    }

    const removed = session.messages.slice(0, cut);
    const startedAt = Date.now();

    try {
      const summary = await summarizeMessages({
        adapter: this.adapter,
        oldSummary: session.summary,
        removed,
      });
      session.summary = summary;
      session.messages.splice(0, cut);
      touchSession(session);
      await this.persist(session);
      await this.emit({
        type: 'compression',
        turnId,
        step,
        removedMessages: cut,
        keptMessages: session.messages.length,
        summaryChars: summary.length,
        durationMs: Date.now() - startedAt,
        fallback: false,
      });
    } catch (error) {
      session.messages.splice(0, cut);
      touchSession(session);
      await this.persist(session);
      await this.emit({
        type: 'compression',
        turnId,
        step,
        removedMessages: cut,
        keptMessages: session.messages.length,
        summaryChars: session.summary?.length ?? 0,
        durationMs: Date.now() - startedAt,
        fallback: true,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async executeTool(call: ToolCall, session: Session): Promise<ToolResult> {
    if (!this.options.tools) {
      return {
        content: JSON.stringify({ error: `未知工具：${call.name}` }),
        isError: true,
      };
    }
    return this.options.tools.execute(call, session);
  }

  private async persist(session: Session): Promise<void> {
    if (this.options.onSessionUpdated) {
      await this.options.onSessionUpdated(session);
    }
  }

  private async emit(event: RuntimeEvent): Promise<void> {
    if (this.options.onEvent) {
      await this.options.onEvent(event);
    }
  }
}

function isEmptyResponse(response: ModelResponse): boolean {
  return response.toolCalls.length === 0 && (response.content === null || response.content.trim() === '');
}
