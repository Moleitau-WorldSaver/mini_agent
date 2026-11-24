import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/run.js';
import { loadConfig } from '../../src/config.js';
import { FakeLLM } from '../fake-llm.js';
import { captureIO, linesOf, makeTempDir, readText, removeDir } from '../helpers.js';

function configFor(dir: string) {
  return loadConfig({ DEEPSEEK_API_KEY: 'secret-key-for-test', MINI_AGENT_DATA_DIR: dir });
}

describe('CLI tool display and trace', () => {
  it('prints tool lines and writes tool trace records', async () => {
    const dir = await makeTempDir();
    try {
      const fake = new FakeLLM([
        { kind: 'tool_calls', calls: [{ name: 'calculator', arguments: '{"expression":"1+2"}' }] },
        { kind: 'text', content: '3' },
      ]);
      const io = captureIO();

      const code = await runCli({
        argv: ['--session', 'w1'],
        config: configFor(dir),
        system: 'SYS',
        createAdapter: () => fake,
        lines: linesOf('算 1+2'),
        ...io,
      });

      expect(code).toBe(0);
      expect(io.out.join('\n')).toContain('[工具] calculator');
      expect(io.out.join('\n')).toContain('助手> 3');

      const kinds = (await readText(path.join(dir, 'traces', 'w1.jsonl')))
        .trim()
        .split('\n')
        .map((line) => (JSON.parse(line) as { kind: string }).kind);
      expect(kinds).toEqual(['llm', 'tool', 'llm', 'turn_end']);
    } finally {
      await removeDir(dir);
    }
  });
});
