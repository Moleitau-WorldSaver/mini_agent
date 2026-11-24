import { beforeEach, describe, expect, it } from 'vitest';
import { ToolRegistry } from '../../src/tools/registry.js';
import { todoTool } from '../../src/tools/todo.js';
import { createSession } from '../../src/session/session.js';
import type { Session, ToolResult } from '../../src/types.js';

let session: Session;
let registry: ToolRegistry;

beforeEach(() => {
  session = createSession({ id: 't', model: 'deepseek-flash', thinking: true });
  registry = new ToolRegistry([todoTool]);
});

function call(args: unknown): Promise<ToolResult> {
  return registry.execute({ id: 'c1', name: 'todo', arguments: JSON.stringify(args) }, session);
}

function body(result: ToolResult) {
  return JSON.parse(result.content) as {
    action?: string;
    item?: { id: string; content: string; done: boolean };
    items?: { id: string; content: string; done: boolean }[];
  };
}

describe('todo tool', () => {
  it('adds todos with generated ids', async () => {
    const first = await call({ action: 'add', content: '买牛奶' });
    expect(first.isError).toBe(false);
    expect(body(first).item).toMatchObject({ id: 't1', content: '买牛奶', done: false });

    const second = await call({ action: 'add', content: '洗车' });
    expect(body(second).item).toMatchObject({ id: 't2', content: '洗车' });
    expect(session.todos).toHaveLength(2);
  });

  it('lists the current todos', async () => {
    await call({ action: 'add', content: '买牛奶' });

    const result = await call({ action: 'list' });

    expect(result.isError).toBe(false);
    expect(body(result).items).toHaveLength(1);
    expect(body(result).items?.[0]?.content).toBe('买牛奶');
  });

  it('completes a todo by id', async () => {
    await call({ action: 'add', content: '买牛奶' });
    await call({ action: 'add', content: '洗车' });

    const result = await call({ action: 'complete', id: 't2' });

    expect(result.isError).toBe(false);
    expect(body(result).item).toMatchObject({ id: 't2', done: true });
    expect(session.todos[1]?.done).toBe(true);
  });

  it('rejects an unknown id and shows the current list', async () => {
    await call({ action: 'add', content: '买牛奶' });

    const result = await call({ action: 'complete', id: 't99' });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('未知待办');
    expect(result.content).toContain('t1');
  });

  it('requires content for add', async () => {
    const result = await call({ action: 'add' });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('content');
  });

  it('rejects an invalid action through the schema', async () => {
    const result = await call({ action: 'remove' });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('必须是');
  });
});
