import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../../src/tools/registry.js';
import { calculatorTool } from '../../src/tools/calculator.js';
import { createSession } from '../../src/session/session.js';
import type { ToolDefinition } from '../../src/types.js';

const session = createSession({ id: 't', model: 'deepseek-flash', thinking: true });
const registry = new ToolRegistry([calculatorTool]);

describe('ToolRegistry', () => {
  it('executes a valid tool call', async () => {
    const result = await registry.execute(
      { id: 'c1', name: 'calculator', arguments: '{"expression":"1+2"}' },
      session,
    );

    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toEqual({ expression: '1+2', value: 3 });
  });

  it('reports an unknown tool with the available tools', async () => {
    const result = await registry.execute({ id: 'c1', name: 'shell', arguments: '{}' }, session);

    expect(result.isError).toBe(true);
    expect(result.content).toContain('未知工具');
    expect(result.content).toContain('calculator');
  });

  it('reports arguments that are not valid JSON', async () => {
    const result = await registry.execute({ id: 'c1', name: 'calculator', arguments: '{"expression":' }, session);

    expect(result.isError).toBe(true);
    expect(result.content).toContain('JSON');
  });

  it('reports missing required arguments', async () => {
    const result = await registry.execute({ id: 'c1', name: 'calculator', arguments: '{}' }, session);

    expect(result.isError).toBe(true);
    expect(result.content).toContain('缺少必填参数');
  });

  it('reports wrong argument types', async () => {
    const result = await registry.execute(
      { id: 'c1', name: 'calculator', arguments: '{"expression":123}' },
      session,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('字符串');
  });

  it('reports arguments rejected by schema limits', async () => {
    const result = await registry.execute(
      { id: 'c1', name: 'calculator', arguments: JSON.stringify({ expression: 'x'.repeat(201) }) },
      session,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('长度不能超过');
  });

  it('catches tool exceptions', async () => {
    const boom: ToolDefinition = {
      name: 'boom',
      description: 'explodes',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      async execute() {
        throw new Error('boom!');
      },
    };
    const reg = new ToolRegistry([boom]);

    const result = await reg.execute({ id: 'c1', name: 'boom', arguments: '{}' }, session);

    expect(result.isError).toBe(true);
    expect(result.content).toContain('boom!');
  });

  it('rejects schemas with unsupported keywords at registration time', () => {
    const bad: ToolDefinition = {
      name: 'bad',
      description: '',
      parameters: { type: 'object', properties: { x: { type: 'string', pattern: 'x' } } },
      async execute() {
        return { content: '', isError: false };
      },
    };

    expect(() => new ToolRegistry([bad])).toThrow(/不支持的 schema 字段/);
  });
});
