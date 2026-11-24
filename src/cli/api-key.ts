import { createInterface } from 'node:readline/promises';

export const KEY_HELP = [
  '未检测到 DEEPSEEK_API_KEY。',
  '可以先在 PowerShell 中设置：$env:DEEPSEEK_API_KEY="你的密钥"',
  '也可以现在输入密钥：输入不会回显，仅本次运行有效，不会写入磁盘。',
].join('\n');

export async function readHiddenPrompt(prompt: string): Promise<string | null> {
  const input = process.stdin;
  const output = process.stdout;

  if (!input.isTTY) {
    const rl = createInterface({ input, output, terminal: false });
    try {
      return await rl.question(prompt);
    } finally {
      rl.close();
    }
  }

  output.write(prompt);
  input.setRawMode(true);
  input.resume();

  return await new Promise<string | null>((resolve) => {
    let value = '';

    const cleanup = () => {
      input.off('data', onData);
      input.setRawMode(false);
    };

    const onData = (chunk: Buffer | string) => {
      for (const char of chunk.toString()) {
        if (char === '\r' || char === '\n') {
          cleanup();
          output.write('\n');
          resolve(value);
          return;
        }
        if (char === '\u0003') {
          cleanup();
          output.write('\n');
          resolve(null);
          return;
        }
        if (char === '\u007f' || char === '\b') {
          value = value.slice(0, -1);
        } else if (char >= ' ') {
          value += char;
        }
      }
    };

    input.on('data', onData);
  });
}
