import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/run.js';
import { TurnCancelledError } from '../../src/runtime/errors.js';
import { FakeLLM } from '../fake-llm.js';
import { captureIO, linesOf, makeTempDir, readJsonFile, readText, removeDir, testConfig } from '../helpers.js';

describe('REPL and session persistence', () => {
  it('persists a conversation and resumes it with history and reasoning', async () => {
    const dir = await makeTempDir();
    try {
      const first = new FakeLLM([
        { kind: 'text', content: '第一答', reasoning: '第一想' },
        { kind: 'text', content: '第二答', reasoning: '第二想' },
      ]);
      const io1 = captureIO();
      const code1 = await runCli({
        argv: ['--session', 'w1'],
        config: testConfig(dir),
        system: 'SYS',
        createAdapter: () => first,
        lines: linesOf('你好', '再见'),
        ...io1,
      });
      expect(code1).toBe(0);
      expect(io1.out.join('\n')).toContain('第一答');

      const sessionFile = path.join(dir, 'sessions', 'w1.json');
      const saved = await readJsonFile<{ title: string; messages: { role: string; reasoningContent?: string }[] }>(sessionFile);
      expect(saved.title).toBe('你好');
      expect(saved.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
      expect(saved.messages[1]?.reasoningContent).toBe('第一想');

      const second = new FakeLLM([{ kind: 'text', content: '第三答' }]);
      const io2 = captureIO();
      const code2 = await runCli({
        argv: ['--session', 'w1'],
        config: testConfig(dir),
        system: 'SYS',
        createAdapter: () => second,
        lines: linesOf('继续'),
        ...io2,
      });
      expect(code2).toBe(0);
      expect(second.requests[0]!.messages).toHaveLength(5);
      expect(second.requests[0]!.messages[1]).toMatchObject({ role: 'assistant', reasoningContent: '第一想' });
      expect((await readJsonFile<{ messages: unknown[] }>(sessionFile)).messages).toHaveLength(6);
    } finally {
      await removeDir(dir);
    }
  });

  it('writes trace records per step and never persists the api key', async () => {
    const dir = await makeTempDir();
    try {
      const fake = new FakeLLM([{ kind: 'text', content: '答复', reasoning: '思考' }]);
      const io = captureIO();
      await runCli({
        argv: ['--session', 'w2'],
        config: testConfig(dir),
        system: 'SYS',
        createAdapter: () => fake,
        lines: linesOf('问题'),
        ...io,
      });

      const traceRaw = await readText(path.join(dir, 'traces', 'w2.jsonl'));
      const records = traceRaw
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { kind: string; sessionId?: string; step?: number });
      expect(records.filter((record) => record.kind === 'llm')).toHaveLength(1);
      expect(records.filter((record) => record.kind === 'turn_end')).toHaveLength(1);
      expect(records[0]).toMatchObject({ sessionId: 'w2', step: 1, kind: 'llm' });

      const sessionRaw = await readText(path.join(dir, 'sessions', 'w2.json'));
      expect(`${sessionRaw}\n${traceRaw}`).not.toContain('secret-key-for-test');
    } finally {
      await removeDir(dir);
    }
  });

  it('keeps the thinking mode recorded in the session when the environment differs', async () => {
    const dir = await makeTempDir();
    try {
      const create = new FakeLLM([{ kind: 'text', content: '好' }]);
      await runCli({
        argv: ['--session', 'w3'],
        config: testConfig(dir),
        system: 'SYS',
        createAdapter: () => create,
        lines: linesOf('你好'),
        ...captureIO(),
      });

      const resume = new FakeLLM([{ kind: 'text', content: '继续' }]);
      const io = captureIO();
      const code = await runCli({
        argv: ['--session', 'w3'],
        config: testConfig(dir, { MINI_AGENT_THINKING: 'off' }),
        system: 'SYS',
        createAdapter: () => resume,
        lines: linesOf('继续'),
        ...io,
      });

      expect(code).toBe(0);
      expect(resume.requests[0]!.thinking).toBe(true);
      expect(io.err.join('\n')).toContain('思考模式');
    } finally {
      await removeDir(dir);
    }
  });

  it('rejects an invalid session id without creating a file', async () => {
    const dir = await makeTempDir();
    try {
      const io = captureIO();
      const code = await runCli({
        argv: ['--session', '../escape'],
        config: testConfig(dir),
        system: 'SYS',
        createAdapter: () => new FakeLLM([]),
        lines: linesOf(),
        ...io,
      });
      expect(code).toBe(2);
      expect(io.err.join('\n')).toContain('会话 id');
    } finally {
      await removeDir(dir);
    }
  });

  it('handles /help and /exit without calling the model', async () => {
    const dir = await makeTempDir();
    try {
      const fake = new FakeLLM([]);
      const io = captureIO();
      const code = await runCli({
        argv: ['--session', 'w4'],
        config: testConfig(dir),
        system: 'SYS',
        createAdapter: () => fake,
        lines: linesOf('/help', '/exit'),
        ...io,
      });
      expect(code).toBe(0);
      expect(io.out.join('\n')).toContain('/exit');
      expect(fake.requests).toHaveLength(0);
    } finally {
      await removeDir(dir);
    }
  });

  it('creates new sessions with thinking off when --no-think is passed', async () => {
    const dir = await makeTempDir();
    try {
      const fake = new FakeLLM([{ kind: 'text', content: '好' }]);
      await runCli({
        argv: ['--session', 'w6', '--no-think'],
        config: testConfig(dir),
        system: 'SYS',
        createAdapter: () => fake,
        lines: linesOf('你好'),
        ...captureIO(),
      });

      expect(fake.requests[0]!.thinking).toBe(false);
      const saved = await readJsonFile<{ thinking: boolean }>(path.join(dir, 'sessions', 'w6.json'));
      expect(saved.thinking).toBe(false);
    } finally {
      await removeDir(dir);
    }
  });

  it('reports a cancelled turn, keeps the REPL alive, and traces cancellation', async () => {
    const dir = await makeTempDir();
    try {
      const fake = new FakeLLM([
        { kind: 'throw', error: new TurnCancelledError() },
        { kind: 'text', content: '继续成功' },
      ]);
      const io = captureIO();

      const code = await runCli({
        argv: ['--session', 'w5'],
        config: testConfig(dir),
        system: 'SYS',
        createAdapter: () => fake,
        lines: linesOf('问题', '继续'),
        ...io,
      });

      expect(code).toBe(0);
      expect(io.err.join('\n')).toContain('已取消');
      expect(io.out.join('\n')).toContain('继续成功');

      const kinds = (await readText(path.join(dir, 'traces', 'w5.jsonl')))
        .trim()
        .split('\n')
        .map((line) => (JSON.parse(line) as { kind: string }).kind);
      expect(kinds).toContain('cancelled');
    } finally {
      await removeDir(dir);
    }
  });
});
