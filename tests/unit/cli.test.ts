import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/run.js';
import { loadConfig } from '../../src/config.js';
import { FakeLLM } from '../fake-llm.js';

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    stdout: (line: string) => out.push(line),
    stderr: (line: string) => err.push(line),
  };
}

describe('runCli (one-shot)', () => {
  it('fails with a readable message when the API key is missing', async () => {
    const io = capture();
    const code = await runCli({
      argv: ['你好'],
      config: loadConfig({}),
      system: 'SYS',
      createAdapter: () => {
        throw new Error('adapter should not be created without a key');
      },
      ...io,
    });

    expect(code).toBe(1);
    expect(io.err.join('\n')).toContain('DEEPSEEK_API_KEY');
    expect(io.out).toHaveLength(0);
  });

  it('prints the answer and hides reasoning by default', async () => {
    const fake = new FakeLLM([{ kind: 'text', content: '答案', reasoning: '这是思考' }]);
    const io = capture();
    const code = await runCli({
      argv: ['问题'],
      config: loadConfig({ DEEPSEEK_API_KEY: 'test-key' }),
      system: 'SYS',
      createAdapter: () => fake,
      ...io,
    });

    expect(code).toBe(0);
    expect(io.out.join('\n')).toBe('答案');
    expect(io.err.join('\n')).not.toContain('这是思考');
  });

  it('shows reasoning with --verbose', async () => {
    const fake = new FakeLLM([{ kind: 'text', content: '答案', reasoning: '这是思考' }]);
    const io = capture();
    const code = await runCli({
      argv: ['--verbose', '问题'],
      config: loadConfig({ DEEPSEEK_API_KEY: 'test-key' }),
      system: 'SYS',
      createAdapter: () => fake,
      ...io,
    });

    expect(code).toBe(0);
    expect(io.err.join('\n')).toContain('这是思考');
  });

  it('prints usage when no question is given', async () => {
    const io = capture();
    const code = await runCli({
      argv: [],
      config: loadConfig({ DEEPSEEK_API_KEY: 'test-key' }),
      system: 'SYS',
      createAdapter: () => new FakeLLM([]),
      ...io,
    });

    expect(code).toBe(2);
    expect(io.err.join('\n')).toContain('用法');
  });
});
