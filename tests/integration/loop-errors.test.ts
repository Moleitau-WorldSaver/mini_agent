import { describe, expect, it } from 'vitest';
import type { ModelAdapter } from '../../src/model/adapter.js';
import { AgentRuntime, type RuntimeEvent, type ToolExecutor } from '../../src/runtime/loop.js';
import { TurnCancelledError } from '../../src/runtime/errors.js';
import { createSession } from '../../src/session/session.js';
import type { ModelResponse } from '../../src/types.js';
import { FakeLLM } from '../fake-llm.js';

function session() {
  return createSession({ id: 't', model: 'deepseek-flash', thinking: true });
}

function runtimeWith(fake: ModelAdapter, events: RuntimeEvent[], tools?: ToolExecutor) {
  return new AgentRuntime(fake, {
    system: 'SYS',
    maxSteps: 8,
    maxTokens: 1024,
    tools,
    onEvent: (event) => {
      events.push(event);
    },
  });
}

describe('loop error handling', () => {
  it('retries an empty response once within the same step', async () => {
    const fake = new FakeLLM([{ kind: 'empty' }, { kind: 'text', content: '恢复' }]);
    const events: RuntimeEvent[] = [];
    const runtime = runtimeWith(fake, events);

    const result = await runtime.runTurn(session(), '问题');

    expect(result).toMatchObject({ content: '恢复', steps: 1 });
    expect(fake.requests).toHaveLength(2);
    expect(events.map((event) => event.type)).toEqual(['error', 'llm', 'turn_end']);
  });

  it('fails the turn when the retried response is still empty', async () => {
    const fake = new FakeLLM([{ kind: 'empty' }, { kind: 'empty' }]);
    const events: RuntimeEvent[] = [];
    const runtime = runtimeWith(fake, events);

    await expect(runtime.runTurn(session(), '问题')).rejects.toThrow('空响应');
    expect(events.filter((event) => event.type === 'error')).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({ type: 'turn_end', reason: 'error' });
  });

  it('returns partial content with a truncation notice on finish_reason=length', async () => {
    const fake = new FakeLLM([{ kind: 'length', content: '部分答案' }]);
    const events: RuntimeEvent[] = [];
    const runtime = runtimeWith(fake, events);
    const current = session();

    const result = await runtime.runTurn(current, '问题');

    expect(result.content).toContain('部分答案');
    expect(result.content).toContain('截断');
    expect(result.finishReason).toBe('length');
    expect(current.messages.at(-1)).toMatchObject({ role: 'assistant', content: '部分答案' });
    expect(events.at(-1)).toMatchObject({ type: 'turn_end', reason: 'length' });
  });

  it('treats a truncated tool call as a protocol error', async () => {
    const adapter: ModelAdapter = {
      async complete(): Promise<ModelResponse> {
        return {
          content: '半截',
          reasoningContent: null,
          toolCalls: [{ id: 'c1', name: 'calculator', arguments: '{}' }],
          finishReason: 'length',
        };
      },
    };
    const events: RuntimeEvent[] = [];
    const runtime = runtimeWith(adapter, events);

    await expect(runtime.runTurn(session(), '问题')).rejects.toThrow('截断');
    expect(events.at(-1)).toMatchObject({ type: 'turn_end', reason: 'error' });
  });

  it('cancels mid-batch and fills unexecuted tool results', async () => {
    const controller = new AbortController();
    const calls: { name: string; arguments: string }[] = [
      { name: 'calculator', arguments: '{"expression":"1+1"}' },
      { name: 'calculator', arguments: '{"expression":"2+2"}' },
      { name: 'calculator', arguments: '{"expression":"3+3"}' },
    ];
    const fake = new FakeLLM([{ kind: 'tool_calls', calls }]);
    const events: RuntimeEvent[] = [];
    let executions = 0;
    const executor: ToolExecutor = {
      schemas: () => [
        { name: 'calculator', description: '', parameters: { type: 'object', properties: {}, additionalProperties: false } },
      ],
      async execute() {
        executions += 1;
        controller.abort();
        return { content: '{"value":2}', isError: false };
      },
    };
    const runtime = runtimeWith(fake, events, executor);
    const current = session();

    await expect(
      runtime.runTurn(current, '算', { signal: controller.signal }),
    ).rejects.toBeInstanceOf(TurnCancelledError);

    expect(executions).toBe(1);
    const toolMessages = current.messages.filter((message) => message.role === 'tool');
    expect(toolMessages).toHaveLength(3);
    expect(toolMessages.filter((message) => message.isError)).toHaveLength(2);
    expect(toolMessages[1]?.content).toContain('已取消');
    expect(events.some((event) => event.type === 'cancelled')).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'turn_end', reason: 'cancelled' });
  });

  it('cancels during the model call', async () => {
    const controller = new AbortController();
    const adapter: ModelAdapter = {
      complete(req) {
        return new Promise((_, reject) => {
          req.signal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
          setTimeout(() => controller.abort(), 1);
        });
      },
    };
    const events: RuntimeEvent[] = [];
    const runtime = runtimeWith(adapter, events);

    await expect(
      runtime.runTurn(session(), '问题', { signal: controller.signal }),
    ).rejects.toBeInstanceOf(TurnCancelledError);

    expect(events.some((event) => event.type === 'cancelled')).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'turn_end', reason: 'cancelled' });
  });
});
