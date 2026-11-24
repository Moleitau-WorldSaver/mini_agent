import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/run.js';
import { loadConfig } from '../../src/config.js';
import { FakeLLM } from '../fake-llm.js';
import { linesOf } from '../helpers.js';

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
      lines: linesOf(),
      ...io,
    });

    expect(code).toBe(1);
    expect(io.err.join('\n')).toContain('DEEPSEEK_API_KEY');
    expect(io.err.join('\n')).toContain('未提供密钥');
    expect(io.out).toHaveLength(0);
  });

  it('asks for a missing key and continues with a one-shot question', async () => {
    let receivedKey = '';
    const fake = new FakeLLM([{ kind: 'text', content: '答案' }]);
    const io = capture();

    const code = await runCli({
      argv: ['问题'],
      config: loadConfig({}),
      system: 'SYS',
      createAdapter: (_model, apiKey) => {
        receivedKey = apiKey;
        return fake;
      },
      lines: linesOf('sk-entered'),
      ...io,
    });

    expect(code).toBe(0);
    expect(receivedKey).toBe('sk-entered');
    expect(io.out.join('\n')).toBe('答案');
    expect(io.err.join('\n')).toContain('DEEPSEEK_API_KEY');
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
});
