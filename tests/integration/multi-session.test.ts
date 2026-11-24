import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/run.js';
import { loadConfig } from '../../src/config.js';
import { FakeLLM } from '../fake-llm.js';
import {
  captureIO,
  linesOf,
  makeTempDir,
  readJsonFile,
  removeDir,
  testConfig,
  todoCall,
} from '../helpers.js';

describe('multi-session management', () => {
  it('isolates history and todos between sessions', async () => {
    const dir = await makeTempDir();
    try {
      const add = new FakeLLM([
        { kind: 'tool_calls', calls: [todoCall({ action: 'add', content: '买牛奶' })] },
        { kind: 'text', content: '已记录' },
      ]);
      await runCli({
        argv: ['--session', 'w1'],
        config: testConfig(dir),
        system: 'SYS',
        createAdapter: () => add,
        lines: linesOf('记个待办买牛奶'),
        ...captureIO(),
      });

      const list = new FakeLLM([
        { kind: 'tool_calls', calls: [todoCall({ action: 'list' })] },
        { kind: 'text', content: '当前没有待办' },
      ]);
      await runCli({
        argv: ['--session', 'w2'],
        config: testConfig(dir),
        system: 'SYS',
        createAdapter: () => list,
        lines: linesOf('我有哪些待办？'),
        ...captureIO(),
      });

      expect(list.requests[0]!.messages).toHaveLength(1);

      const w2 = await readJsonFile<{
        todos: unknown[];
        messages: { role: string; content: string | null }[];
      }>(path.join(dir, 'sessions', 'w2.json'));
      expect(w2.todos).toHaveLength(0);
      const toolMessage = w2.messages.find((message) => message.role === 'tool');
      expect(JSON.parse(String(toolMessage?.content)).items).toEqual([]);

      const w1 = await readJsonFile<{ todos: { content: string }[] }>(path.join(dir, 'sessions', 'w1.json'));
      expect(w1.todos[0]?.content).toBe('买牛奶');
    } finally {
      await removeDir(dir);
    }
  });

  it('lists sessions without requiring an api key', async () => {
    const dir = await makeTempDir();
    try {
      for (const [id, question, answer] of [
        ['alpha', '第一个会话', 'A'],
        ['beta', '第二个会话', 'B'],
      ] as const) {
        const fake = new FakeLLM([{ kind: 'text', content: answer }]);
        await runCli({
          argv: ['--session', id],
          config: testConfig(dir),
          system: 'SYS',
          createAdapter: () => fake,
          lines: linesOf(question),
          ...captureIO(),
        });
      }

      const io = captureIO();
      const code = await runCli({
        argv: ['--list'],
        config: loadConfig({ MINI_AGENT_DATA_DIR: dir }),
        system: 'SYS',
        createAdapter: () => {
          throw new Error('adapter must not be created for --list');
        },
        ...io,
      });

      expect(code).toBe(0);
      const output = io.out.join('\n');
      expect(output).toContain('alpha');
      expect(output).toContain('第一个会话');
      expect(output).toContain('beta');
      expect(output).toContain('第二个会话');
    } finally {
      await removeDir(dir);
    }
  });

  it('switches with /switch and creates with /new', async () => {
    const dir = await makeTempDir();
    try {
      const seed = new FakeLLM([
        { kind: 'tool_calls', calls: [todoCall({ action: 'add', content: '买牛奶' })] },
        { kind: 'text', content: '已记录' },
      ]);
      await runCli({
        argv: ['--session', 'w1'],
        config: testConfig(dir),
        system: 'SYS',
        createAdapter: () => seed,
        lines: linesOf('记个待办买牛奶'),
        ...captureIO(),
      });

      const fake = new FakeLLM([
        { kind: 'text', content: 'w2 答复' },
        { kind: 'text', content: 'w3 答复' },
      ]);
      const io = captureIO();
      const code = await runCli({
        argv: ['--session', 'w1'],
        config: testConfig(dir),
        system: 'SYS',
        createAdapter: () => fake,
        lines: linesOf(
          '/switch w2',
          '你好',
          '/todos',
          '/switch w1',
          '/todos',
          '/new w3',
          '你好',
          '/exit',
        ),
        ...io,
      });

      expect(code).toBe(0);
      const output = io.out.join('\n');
      expect(output).toContain('w2 答复');
      expect(output).toContain('当前会话没有待办。');
      expect(output).toContain('[ ] 买牛奶');
      expect(output).toContain('w3 答复');

      expect(fake.requests).toHaveLength(2);
      expect(fake.requests[0]!.messages).toHaveLength(1);
      expect(fake.requests[1]!.messages).toHaveLength(1);
      expect(await readJsonFile<{ id: string }>(path.join(dir, 'sessions', 'w3.json'))).toMatchObject({
        id: 'w3',
      });
    } finally {
      await removeDir(dir);
    }
  });

  it('rejects an invalid id on /switch and stays in the current session', async () => {
    const dir = await makeTempDir();
    try {
      const fake = new FakeLLM([{ kind: 'text', content: '仍在 w1' }]);
      const io = captureIO();
      await runCli({
        argv: ['--session', 'w1'],
        config: testConfig(dir),
        system: 'SYS',
        createAdapter: () => fake,
        lines: linesOf('/switch ../x', '你好', '/exit'),
        ...io,
      });

      expect(io.err.join('\n')).toContain('会话 id 不合法');
      expect(io.out.join('\n')).toContain('仍在 w1');
      expect(fake.requests[0]!.messages).toHaveLength(1);
    } finally {
      await removeDir(dir);
    }
  });
});
