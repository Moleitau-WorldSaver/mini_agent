import { describe, expect, it } from 'vitest';
import { AgentRuntime } from '../../src/runtime/loop.js';
import { createSession } from '../../src/session/session.js';
import { FakeLLM } from '../fake-llm.js';

describe('AgentRuntime', () => {
  it('answers a direct question without calling tools', async () => {
    const fake = new FakeLLM([{ kind: 'text', content: '你好，我是 Agent。', reasoning: '简单问候' }]);
    const runtime = new AgentRuntime(fake, { system: 'SYS', maxSteps: 8, maxTokens: 1024 });
    const session = createSession({ id: 'w1', model: 'deepseek-flash', thinking: true });

    const result = await runtime.runTurn(session, '你好');

    expect(result).toMatchObject({
      content: '你好，我是 Agent。',
      steps: 1,
      finishReason: 'stop',
      reasoningContent: '简单问候',
    });
    expect(session.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(session.messages[1]).toMatchObject({
      role: 'assistant',
      content: '你好，我是 Agent。',
      reasoningContent: '简单问候',
      turnId: 'turn-1',
      step: 1,
    });
    expect(session.title).toBe('你好');

    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]).toMatchObject({
      system: 'SYS',
      tools: [],
      thinking: true,
      maxTokens: 1024,
    });
    expect(fake.requests[0]!.messages).toHaveLength(1);
    expect(fake.requests[0]!.messages[0]).toMatchObject({ role: 'user', content: '你好' });
  });
});
