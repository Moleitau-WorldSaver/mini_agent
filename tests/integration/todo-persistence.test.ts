import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/run.js';
import { loadConfig } from '../../src/config.js';
import { FakeLLM } from '../fake-llm.js';
import { captureIO, linesOf, makeTempDir, readJsonFile, removeDir } from '../helpers.js';

function configFor(dir: string) {
  return loadConfig({ DEEPSEEK_API_KEY: 'secret-key-for-test', MINI_AGENT_DATA_DIR: dir });
}

function todoCall(args: unknown) {
  return { name: 'todo', arguments: JSON.stringify(args) };
}

describe('session todo persistence', () => {
  it('persists todos across runs, appends with an elided subject, and completes by id', async () => {
    const dir = await makeTempDir();
    try {
      const first = new FakeLLM([
        { kind: 'tool_calls', calls: [todoCall({ action: 'add', content: '买牛奶' })] },
        { kind: 'text', content: '已记录 t1' },
      ]);
      const io1 = captureIO();
      await runCli({
        argv: ['--session', 'w1'],
        config: configFor(dir),
        system: 'SYS',
        createAdapter: () => first,
        lines: linesOf('记个待办买牛奶'),
        ...io1,
      });
      expect(io1.out.join('\n')).toContain('已记录 t1');

      const list = new FakeLLM([
        { kind: 'tool_calls', calls: [todoCall({ action: 'list' })] },
        { kind: 'text', content: '你有 1 个待办：买牛奶' },
      ]);
      const io2 = captureIO();
      await runCli({
        argv: ['--session', 'w1'],
        config: configFor(dir),
        system: 'SYS',
        createAdapter: () => list,
        lines: linesOf('我有哪些待办？'),
        ...io2,
      });
      expect(io2.out.join('\n')).toContain('买牛奶');

      const third = new FakeLLM([
        { kind: 'tool_calls', calls: [todoCall({ action: 'add', content: '洗车' })] },
        { kind: 'text', content: '已追加 t2' },
      ]);
      await runCli({
        argv: ['--session', 'w1'],
        config: configFor(dir),
        system: 'SYS',
        createAdapter: () => third,
        lines: linesOf('再加一个，洗车'),
        ...captureIO(),
      });

      const complete = new FakeLLM([
        { kind: 'tool_calls', calls: [todoCall({ action: 'complete', id: 't1' })] },
        { kind: 'text', content: '已完成 t1' },
      ]);
      await runCli({
        argv: ['--session', 'w1'],
        config: configFor(dir),
        system: 'SYS',
        createAdapter: () => complete,
        lines: linesOf('把 t1 标成完成'),
        ...captureIO(),
      });

      const saved = await readJsonFile<{ todos: { id: string; content: string; done: boolean }[] }>(
        path.join(dir, 'sessions', 'w1.json'),
      );
      expect(saved.todos.map((todo) => `${todo.id}:${todo.content}:${todo.done}`)).toEqual([
        't1:买牛奶:true',
        't2:洗车:false',
      ]);

      const todosIO = captureIO();
      await runCli({
        argv: ['--session', 'w1'],
        config: configFor(dir),
        system: 'SYS',
        createAdapter: () => new FakeLLM([]),
        lines: linesOf('/todos', '/exit'),
        ...todosIO,
      });
      expect(todosIO.out.join('\n')).toContain('[x] 买牛奶');
      expect(todosIO.out.join('\n')).toContain('[ ] 洗车');
    } finally {
      await removeDir(dir);
    }
  });
});
