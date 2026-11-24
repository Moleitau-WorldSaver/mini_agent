import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../../src/tools/registry.js';
import { searchTool } from '../../src/tools/search.js';
import { weatherTool } from '../../src/tools/weather.js';
import { createSession } from '../../src/session/session.js';
import type { ToolDefinition } from '../../src/types.js';

const session = createSession({ id: 't', model: 'deepseek-flash', thinking: true });
const registry = new ToolRegistry([searchTool, weatherTool]);

function call(name: string, args: unknown) {
  return registry.execute({ id: 'c1', name, arguments: JSON.stringify(args) }, session);
}

function body(result: { content: string }) {
  return JSON.parse(result.content) as Record<string, unknown>;
}

describe('search (mock)', () => {
  it('returns matching fixtures', async () => {
    const result = await call('search', { query: '压缩' });

    expect(result.isError).toBe(false);
    const payload = body(result);
    expect(payload.total).toBe(1);
    expect((payload.results as { title: string }[])[0]?.title).toContain('压缩');
  });

  it('returns an empty list without an error when nothing matches', async () => {
    const result = await call('search', { query: '量子计算' });

    expect(result.isError).toBe(false);
    expect(body(result)).toMatchObject({ results: [], total: 0 });
  });

  it('defaults topK to 3', async () => {
    const result = await call('search', { query: 'agent' });

    expect((body(result).results as unknown[]).length).toBe(3);
    expect(body(result).total).toBe(4);
  });

  it('honours topK up to the schema maximum', async () => {
    const result = await call('search', { query: 'agent', topK: 5 });

    expect((body(result).results as unknown[]).length).toBe(4);
  });

  it('rejects topK outside the schema range', async () => {
    const result = await call('search', { query: 'agent', topK: 9 });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('不能大于');
  });
});

describe('weather (mock)', () => {
  it('returns celsius by default', async () => {
    const result = await call('weather', { city: '北京' });

    expect(result.isError).toBe(false);
    expect(body(result)).toEqual({ city: '北京', temperature: 26, unit: 'celsius' });
  });

  it('converts to fahrenheit', async () => {
    const result = await call('weather', { city: '上海', unit: 'fahrenheit' });

    expect(body(result)).toEqual({ city: '上海', temperature: 82, unit: 'fahrenheit' });
  });

  it('rejects an unknown city and lists the supported ones', async () => {
    const result = await call('weather', { city: '拉萨' });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('未知城市');
    expect(result.content).toContain('北京');
  });
});

describe('tool result truncation', () => {
  it('truncates results longer than 4000 characters with a marker', async () => {
    const big: ToolDefinition = {
      name: 'big',
      description: 'returns a large payload',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      async execute() {
        return { content: 'x'.repeat(5000), isError: false };
      },
    };
    const reg = new ToolRegistry([big]);

    const result = await reg.execute({ id: 'c1', name: 'big', arguments: '{}' }, session);

    expect(result.content).toContain('[truncated 1000 chars]');
    expect(result.content.length).toBeLessThan(4200);
  });
});
