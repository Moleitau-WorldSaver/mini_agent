import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/run.js';
import { FakeLLM } from '../fake-llm.js';
import { captureIO, linesOf, makeTempDir, readText, removeDir, testConfig } from '../helpers.js';

describe('CLI output and trace', () => {
  it('keeps default output concise and writes the trace contract', async () => {
    const dir = await makeTempDir();
    try {
      const fake = new FakeLLM([
        { kind: 'tool_calls', calls: [{ name: 'calculator', arguments: '{"expression":"1+2"}' }] },
        { kind: 'text', content: '3' },
      ]);
      const io = captureIO();

      const code = await runCli({
        argv: ['--session', 'w1'],
        config: testConfig(dir),
        system: 'SYS',
        createAdapter: () => fake,
        lines: linesOf('算 1+2'),
        ...io,
      });

      expect(code).toBe(0);
      expect(io.out.join('\n')).not.toContain('[工具]');
      expect(io.out.join('\n')).toContain('助手> 3');

      const records = (await readText(path.join(dir, 'traces', 'w1.jsonl')))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);

      expect(records.map((record) => record.kind)).toEqual(['llm', 'tool', 'llm', 'turn_end']);
      for (const record of records) {
        expect(typeof record.ts).toBe('string');
        expect(record.sessionId).toBe('w1');
        expect(typeof record.step).toBe('number');
        expect(typeof record.durationMs).toBe('number');
      }
      expect(records.at(-1)).toMatchObject({ kind: 'turn_end', step: 2, steps: 2, reason: 'final' });
    } finally {
      await removeDir(dir);
    }
  });

  it('prints tool details with --verbose', async () => {
    const dir = await makeTempDir();
    try {
      const fake = new FakeLLM([
        { kind: 'tool_calls', calls: [{ name: 'calculator', arguments: '{"expression":"1+2"}' }] },
        { kind: 'text', content: '3' },
      ]);
      const io = captureIO();

      await runCli({
        argv: ['--session', 'w2', '--verbose'],
        config: testConfig(dir),
        system: 'SYS',
        createAdapter: () => fake,
        lines: linesOf('算 1+2'),
        ...io,
      });

      expect(io.out.join('\n')).toContain('[工具] calculator');
    } finally {
      await removeDir(dir);
    }
  });
});
