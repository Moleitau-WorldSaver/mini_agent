import { describe, expect, it } from 'vitest';
import { AgentRuntime } from '../../src/runtime/loop.js';
import { createSession } from '../../src/session/session.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { calculatorTool } from '../../src/tools/calculator.js';
import { FakeLLM, type FakeStep } from '../fake-llm.js';

function setup(script: FakeStep[], maxSteps = 8) {
  const fake = new FakeLLM(script);
  const runtime = new AgentRuntime(fake, {
    system: 'SYS',
    maxSteps,
    maxTokens: 1024,
    tools: new ToolRegistry([calculatorTool]),
  });
  const session = createSession({ id: 't', model: 'deepseek-flash', thinking: true });
  return { fake, runtime, session };
}

describe('tool loop', () => {
  it('executes a tool and continues to the final answer', async () => {
    const { fake, runtime, session } = setup([
      { kind: 'tool_calls', reasoning: '需要计算', calls: [{ name: 'calculator', arguments: '{"expression":"1+2"}' }] },
      { kind: 'text', content: '结果是 3' },
    ]);

    const result = await runtime.runTurn(session, '1+2 等于几？');

    expect(result).toMatchObject({ content: '结果是 3', steps: 2 });
    expect(session.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(session.messages[2]).toMatchObject({ role: 'tool', name: 'calculator', isError: false });
    expect(JSON.parse(String(session.messages[2]!.content))).toEqual({ expression: '1+2', value: 3 });
    expect(fake.requests[1]!.messages).toHaveLength(3);
    expect(fake.requests[1]!.messages[1]).toMatchObject({ role: 'assistant', reasoningContent: '需要计算' });
  });

  it('executes a batch of tool calls as one step', async () => {
    const { fake, runtime, session } = setup([
      {
        kind: 'tool_calls',
        calls: [
          { name: 'calculator', arguments: '{"expression":"1+1"}' },
          { name: 'calculator', arguments: '{"expression":"2*2"}' },
        ],
      },
      { kind: 'text', content: '完成' },
    ]);

    const result = await runtime.runTurn(session, '算两个');

    expect(result.steps).toBe(2);
    expect(session.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'tool',
      'assistant',
    ]);
    expect(fake.requests[1]!.messages).toHaveLength(4);
  });

  it('stops at maxSteps and returns a synthetic notice', async () => {
    const script: FakeStep[] = Array.from({ length: 5 }, () => ({
      kind: 'tool_calls',
      calls: [{ name: 'calculator', arguments: '{"expression":"1+1"}' }],
    }));
    const { runtime, session } = setup(script, 3);

    const result = await runtime.runTurn(session, '一直算');

    expect(result.finishReason).toBe('max_steps');
    expect(result.content).toContain('步数上限');
    expect(session.messages.filter((message) => message.role === 'tool')).toHaveLength(3);
    expect(session.messages.filter((message) => message.role === 'assistant')).toHaveLength(4);
  });

  const errorCases = [
    { label: '未知工具', call: { name: 'nope', arguments: '{}' }, expected: '未知工具' },
    { label: '非法 JSON', call: { name: 'calculator', arguments: '{"expression":' }, expected: 'JSON' },
    { label: '缺必填参数', call: { name: 'calculator', arguments: '{}' }, expected: '缺少必填参数' },
    { label: '类型错误', call: { name: 'calculator', arguments: '{"expression":123}' }, expected: '字符串' },
    { label: '工具抛错', call: { name: 'calculator', arguments: '{"expression":"1/0"}' }, expected: '除零' },
  ];

  for (const testCase of errorCases) {
    it(`continues after a tool error: ${testCase.label}`, async () => {
      const { fake, runtime, session } = setup([
        { kind: 'tool_calls', calls: [testCase.call] },
        { kind: 'text', content: '已处理' },
      ]);

      const result = await runtime.runTurn(session, '试试');

      expect(result.content).toBe('已处理');
      const toolMessage = session.messages.find((message) => message.role === 'tool');
      expect(toolMessage).toMatchObject({ isError: true });
      expect(toolMessage?.content).toContain(testCase.expected);
      expect(fake.requests[1]!.messages.some((message) => message.role === 'tool' && message.isError)).toBe(true);
    });
  }

  it('emits llm, tool and turn_end events in order', async () => {
    const fake = new FakeLLM([
      { kind: 'tool_calls', calls: [{ name: 'calculator', arguments: '{"expression":"1+2"}' }] },
      { kind: 'text', content: '3' },
    ]);
    const events: string[] = [];
    const runtime = new AgentRuntime(fake, {
      system: 'SYS',
      maxSteps: 8,
      maxTokens: 1024,
      tools: new ToolRegistry([calculatorTool]),
      onEvent: (event) => {
        events.push(event.type);
      },
    });
    const session = createSession({ id: 't', model: 'deepseek-flash', thinking: true });

    await runtime.runTurn(session, '算');

    expect(events).toEqual(['llm', 'tool', 'llm', 'turn_end']);
  });
});
