import path from 'node:path';
import { mkdir, readFile, utimes, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/run.js';
import { lockFilePath } from '../../src/session/lock.js';
import { createSession } from '../../src/session/session.js';
import { saveSession, sessionFilePath } from '../../src/session/store.js';
import { FakeLLM } from '../fake-llm.js';
import {
  captureIO,
  linesOf,
  makeTempDir,
  readJsonFile,
  readText,
  removeDir,
  testConfig,
} from '../helpers.js';

async function fileExists(file: string): Promise<boolean> {
  return readFile(file).then(
    () => true,
    () => false,
  );
}

describe('session safety', () => {
  it('refuses to open a session locked by another process', async () => {
    const dir = await makeTempDir();
    try {
      await mkdir(path.join(dir, 'sessions'), { recursive: true });
      await writeFile(lockFilePath(dir, 'w1'), JSON.stringify({ pid: 999999 }), 'utf8');

      const io = captureIO();
      const code = await runCli({
        argv: ['--session', 'w1'],
        config: testConfig(dir),
        system: 'SYS',
        createAdapter: () => new FakeLLM([]),
        lines: linesOf('你好'),
        ...io,
      });

      expect(code).toBe(1);
      expect(io.err.join('\n')).toContain('正在使用');
    } finally {
      await removeDir(dir);
    }
  });

  it('takes over a stale lock and releases it on exit', async () => {
    const dir = await makeTempDir();
    try {
      await mkdir(path.join(dir, 'sessions'), { recursive: true });
      const file = lockFilePath(dir, 'w1');
      await writeFile(file, '{}', 'utf8');
      await utimes(file, new Date(0), new Date(0));

      const fake = new FakeLLM([{ kind: 'text', content: '答复' }]);
      const io = captureIO();
      const code = await runCli({
        argv: ['--session', 'w1'],
        config: testConfig(dir),
        system: 'SYS',
        createAdapter: () => fake,
        lines: linesOf('你好'),
        ...io,
      });

      expect(code).toBe(0);
      expect(await fileExists(file)).toBe(false);
    } finally {
      await removeDir(dir);
    }
  });

  it('does not overwrite a corrupt session file', async () => {
    const dir = await makeTempDir();
    try {
      await mkdir(path.join(dir, 'sessions'), { recursive: true });
      const file = sessionFilePath(dir, 'w1');
      await writeFile(file, '{not json', 'utf8');

      const io = captureIO();
      const code = await runCli({
        argv: ['--session', 'w1'],
        config: testConfig(dir),
        system: 'SYS',
        createAdapter: () => new FakeLLM([]),
        lines: linesOf('你好'),
        ...io,
      });

      expect(code).toBe(1);
      expect(io.err.join('\n')).toContain('损坏');
      expect(await readText(file)).toBe('{not json');
    } finally {
      await removeDir(dir);
    }
  });

  it('repairs a missing tool result on load and traces the repair', async () => {
    const dir = await makeTempDir();
    try {
      const session = createSession({ id: 'w1', model: 'deepseek-flash', thinking: true });
      session.messages.push({ role: 'user', content: '之前', turnId: 'turn-1' });
      session.messages.push({
        role: 'assistant',
        content: null,
        toolCalls: [{ id: 'c1', name: 'calculator', arguments: '{"expression":"1+1"}' }],
        turnId: 'turn-1',
        step: 1,
      });
      await saveSession(dir, session);

      const fake = new FakeLLM([{ kind: 'text', content: '恢复后答复' }]);
      const io = captureIO();
      const code = await runCli({
        argv: ['--session', 'w1'],
        config: testConfig(dir),
        system: 'SYS',
        createAdapter: () => fake,
        lines: linesOf('继续'),
        ...io,
      });

      expect(code).toBe(0);
      const messages = fake.requests[0]!.messages;
      expect(messages).toHaveLength(4);
      expect(messages[2]).toMatchObject({ role: 'tool', toolCallId: 'c1', isError: true });
      expect(String((messages[2] as { content?: unknown }).content)).toContain('运行时恢复');

      const saved = await readJsonFile<{ messages: { role: string; isError?: boolean }[] }>(
        sessionFilePath(dir, 'w1'),
      );
      expect(saved.messages[2]).toMatchObject({ role: 'tool', isError: true });

      const kinds = (await readText(path.join(dir, 'traces', 'w1.jsonl')))
        .trim()
        .split('\n')
        .map((line) => (JSON.parse(line) as { kind: string }).kind);
      expect(kinds[0]).toBe('repair');
      expect(await fileExists(lockFilePath(dir, 'w1'))).toBe(false);
    } finally {
      await removeDir(dir);
    }
  });
});
