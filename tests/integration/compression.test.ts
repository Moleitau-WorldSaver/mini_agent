import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/run.js';
import { loadConfig } from '../../src/config.js';
import { AgentRuntime, type RuntimeEvent } from '../../src/runtime/loop.js';
import { createSession } from '../../src/session/session.js';
import { saveSession } from '../../src/session/store.js';
import { TraceWriter, traceFilePath } from '../../src/telemetry/trace.js';
import type { Session } from '../../src/types.js';
import { FakeLLM } from '../fake-llm.js';
import { captureIO, linesOf, makeTempDir, readText, removeDir } from '../helpers.js';

function longSession(pairs = 10): Session {
  const session = createSession({ id: 'c1', model: 'deepseek-flash', thinking: true });
  for (let index = 0; index < pairs; index += 1) {
    session.messages.push({
      role: 'user',
      content: `问题 ${index} ${'x'.repeat(50)}`,
      turnId: `turn-${index + 1}`,
    });
    session.messages.push({
      role: 'assistant',
      content: `答复 ${index}`,
      reasoningContent: '想',
      turnId: `turn-${index + 1}`,
      step: 1,
    });
  }
  session.turnSeq = pairs;
  return session;
}

function runtimeWith(
  fake: FakeLLM,
  options: { contextTokens?: number; keepRecent?: number; compression?: boolean } = {},
  events?: RuntimeEvent[],
) {
  return new AgentRuntime(fake, {
    system: 'BASE',
    maxSteps: 8,
    maxTokens: 1024,
    contextTokens: options.contextTokens ?? 50,
    keepRecent: options.keepRecent ?? 4,
    compression: options.compression,
    onEvent: events
      ? (event) => {
          events.push(event);
        }
      : undefined,
  });
}

function cliConfig(dir: string, extra: NodeJS.ProcessEnv = {}) {
  return loadConfig({
    DEEPSEEK_API_KEY: 'secret-key-for-test',
    MINI_AGENT_DATA_DIR: dir,
    ...extra,
  });
}

describe('context compression', () => {
  it('compresses older messages into a system summary', async () => {
    const fake = new FakeLLM([
      { kind: 'text', content: '摘要内容' },
      { kind: 'text', content: '最终答复' },
    ]);
    const events: RuntimeEvent[] = [];
    const runtime = runtimeWith(fake, {}, events);
    const session = longSession();

    const result = await runtime.runTurn(session, '新问题');

    expect(result.content).toBe('最终答复');
    expect(session.summary).toBe('摘要内容');
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests[0]).toMatchObject({ tools: [], thinking: false });
    expect(fake.requests[0]!.system).toContain('摘要器');
    expect(fake.requests[1]!.system).toContain('## 早前对话摘要');
    expect(fake.requests[1]!.system).toContain('摘要内容');
    expect(session.messages[0]?.role).toBe('user');
    expect(session.messages.some((message) => message.role === 'tool')).toBe(false);
    expect(events.map((event) => event.type)).toEqual(['compression', 'llm', 'turn_end']);
    expect(events[0]).toMatchObject({ type: 'compression', fallback: false });
  });

  it('falls back to dropping the oldest messages when summarization fails', async () => {
    const fake = new FakeLLM([
      { kind: 'throw', error: new Error('summary failed') },
      { kind: 'text', content: '最终答复' },
    ]);
    const events: RuntimeEvent[] = [];
    const runtime = runtimeWith(fake, {}, events);
    const session = longSession();
    const before = session.messages.length;

    const result = await runtime.runTurn(session, '新问题');

    expect(result.content).toBe('最终答复');
    expect(session.summary).toBeNull();
    expect(session.messages.length).toBeLessThan(before + 1);
    expect(events.some((event) => event.type === 'compression' && event.fallback)).toBe(true);
    expect(fake.requests[1]!.system).not.toContain('## 早前对话摘要');
  });

  it('merges the previous summary into the next compression', async () => {
    const fake = new FakeLLM([
      { kind: 'text', content: '摘要一' },
      { kind: 'text', content: '答复一' },
      { kind: 'text', content: '摘要二' },
      { kind: 'text', content: '答复二' },
    ]);
    const runtime = runtimeWith(fake, { contextTokens: 1, keepRecent: 4 });
    const session = longSession();

    await runtime.runTurn(session, '第一问');
    await runtime.runTurn(session, '第二问');

    expect(session.summary).toBe('摘要二');
    const secondSummaryRequest = fake.requests[2]!;
    expect(String((secondSummaryRequest.messages[0] as { content?: unknown }).content)).toContain('摘要一');
  });

  it('does not compress when compression is disabled', async () => {
    const fake = new FakeLLM([{ kind: 'text', content: '答复' }]);
    const runtime = runtimeWith(fake, { compression: false });
    const session = longSession();

    await runtime.runTurn(session, '新问题');

    expect(session.summary).toBeNull();
    expect(fake.requests).toHaveLength(1);
  });

  it('honours --no-compress and writes compression trace records otherwise', async () => {
    const dir = await makeTempDir();
    try {
      const session = longSession(40);
      session.id = 'w1';
      await saveSession(dir, session);

      const off = new FakeLLM([{ kind: 'text', content: '答复' }]);
      const offIO = captureIO();
      const offCode = await runCli({
        argv: ['--session', 'w1', '--no-compress'],
        config: cliConfig(dir),
        system: 'SYS',
        createAdapter: () => off,
        lines: linesOf('新问题'),
        ...offIO,
      });
      expect(offCode).toBe(0);
      expect(off.requests).toHaveLength(1);
      expect(off.requests[0]!.system).not.toContain('早前对话摘要');

      const on = new FakeLLM([
        { kind: 'text', content: '压缩摘要' },
        { kind: 'text', content: '答复二' },
      ]);
      const onIO = captureIO();
      const onCode = await runCli({
        argv: ['--session', 'w1'],
        config: cliConfig(dir),
        system: 'SYS',
        createAdapter: () => on,
        lines: linesOf('继续'),
        ...onIO,
      });
      expect(onCode).toBe(0);
      expect(on.requests[0]!.tools).toEqual([]);

      const records = (await readText(path.join(dir, 'traces', 'w1.jsonl')))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { kind: string });
      expect(records.some((record) => record.kind === 'compression')).toBe(true);
    } finally {
      await removeDir(dir);
    }
  });

  it('maps a failed compression event to a compression_fallback trace record', async () => {
    const dir = await makeTempDir();
    try {
      const writer = new TraceWriter(traceFilePath(dir, 't1'));
      await writer.write('t1', {
        type: 'compression',
        turnId: 'turn-1',
        step: 1,
        removedMessages: 3,
        keptMessages: 2,
        summaryChars: 0,
        durationMs: 1,
        fallback: true,
        error: 'summary failed',
      });

      const record = JSON.parse((await readText(path.join(dir, 'traces', 't1.jsonl'))).trim()) as { kind: string };
      expect(record.kind).toBe('compression_fallback');
    } finally {
      await removeDir(dir);
    }
  });
});
