import type { ModelAdapter } from '../model/adapter.js';
import type { Session, ToolCall, ToolResult, ToolSchema } from '../types.js';
import { applyTitle, touchSession } from '../session/session.js';

export interface ToolExecutor {
  schemas(): ToolSchema[];
  execute(call: ToolCall, session: Session): Promise<ToolResult>;
}

export interface RuntimeOptions {
  system: string;
  maxSteps: number;
  maxTokens: number;
  tools?: ToolExecutor;
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

    let lastReasoning: string | null = null;

    for (let step = 1; step <= this.options.maxSteps; step += 1) {
      const response = await this.adapter.complete({
        system: this.options.system,
        messages: [...session.messages],
        tools: this.options.tools?.schemas() ?? [],
        thinking: session.thinking,
        maxTokens: this.options.maxTokens,
      });
      lastReasoning = response.reasoningContent;

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
          const result = await this.executeTool(call, session);
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
    return {
      content: notice,
      steps: this.options.maxSteps,
      finishReason: 'max_steps',
      reasoningContent: lastReasoning,
    };
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
}
