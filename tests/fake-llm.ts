import type { ModelAdapter } from '../src/model/adapter.js';
import type { ModelRequest, ModelResponse, ToolCall } from '../src/types.js';

export type FakeStep =
  | { kind: 'text'; content: string; reasoning?: string }
  | { kind: 'tool_calls'; content?: string | null; reasoning?: string; calls: { name: string; arguments: string; id?: string }[] }
  | { kind: 'length'; content: string }
  | { kind: 'empty' }
  | { kind: 'throw'; error: Error };

export class FakeLLM implements ModelAdapter {
  readonly requests: ModelRequest[] = [];
  private script: FakeStep[];

  constructor(script: FakeStep[]) {
    this.script = [...script];
  }

  get remaining(): number {
    return this.script.length;
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    this.requests.push(req);
    const step = this.script.shift();
    if (!step) {
      throw new Error('FakeLLM script exhausted');
    }
    switch (step.kind) {
      case 'text':
        return {
          content: step.content,
          reasoningContent: step.reasoning ?? null,
          toolCalls: [],
          finishReason: 'stop',
        };
      case 'tool_calls': {
        const toolCalls: ToolCall[] = step.calls.map((call, index) => ({
          id: call.id ?? `call_${index}`,
          name: call.name,
          arguments: call.arguments,
        }));
        return {
          content: step.content ?? null,
          reasoningContent: step.reasoning ?? null,
          toolCalls,
          finishReason: 'tool_calls',
        };
      }
      case 'length':
        return {
          content: step.content,
          reasoningContent: null,
          toolCalls: [],
          finishReason: 'length',
        };
      case 'empty':
        return {
          content: null,
          reasoningContent: null,
          toolCalls: [],
          finishReason: 'stop',
        };
      case 'throw':
        throw step.error;
    }
  }
}
