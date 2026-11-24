import type { ModelAdapter } from '../model/adapter.js';
import type { ContextMessage, ModelResponse, Session, ToolCall, ToolResult, ToolSchema } from '../types.js';
import { applyTitle, touchSession } from '../session/session.js';

export interface ToolExecutor {
  schemas(): ToolSchema[];
  execute(call: ToolCall, session: Session): Promise<ToolResult>;
}

export type TurnEndReason = 'final' | 'max_steps' | 'error';

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
  | { type: 'turn_end'; turnId: string; steps: number; reason: TurnEndReason };

export interface RuntimeOptions {
  system: string;
  maxSteps: number;
  maxTokens: number;
  tools?: ToolExecutor;
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

  async runTurn(session: Session, input: string): Promise<TurnResult> {
    const turnId = `turn-${++session.turnSeq}`;
    applyTitle(session, input);
    session.messages.push({ role: 'user', content: input, turnId });
    touchSession(session);
    await this.persist(session);

    let lastReasoning: string | null = null;
    let step = 0;

    try {
      for (step = 1; step <= this.options.maxSteps; step += 1) {
        const requestMessages = [...session.messages];
        const toolSchemas = this.options.tools?.schemas() ?? [];
        const startedAt = Date.now();

        const response = await this.adapter.complete({
          system: this.options.system,
          messages: requestMessages,
          tools: toolSchemas,
          thinking: session.thinking,
          maxTokens: this.options.maxTokens,
        });
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
            contextChars: countContextChars(this.options.system, requestMessages, toolSchemas),
          },
          response,
        });

        if (response.toolCalls.length > 0) {
          session.messages.push({
            role: 'assistant',
            content: response.content,
            reasoningContent: response.reasoningContent,
            toolCalls: response.toolCalls,
            turnId,
            step,
          });

          for (const call of response.toolCalls) {
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

function countContextChars(system: string, messages: ContextMessage[], tools: ToolSchema[]): number {
  let total = system.length + tools.length * 200;
  for (const message of messages) {
    if (message.role === 'tool') {
      total += message.content.length;
    } else if (message.role === 'assistant') {
      total += message.content?.length ?? 0;
      total += message.reasoningContent?.length ?? 0;
      for (const call of message.toolCalls ?? []) {
        total += call.arguments.length;
      }
    } else {
      total += message.content.length;
    }
  }
  return total;
}
