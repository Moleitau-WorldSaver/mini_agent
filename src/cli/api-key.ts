import { createInterface } from 'node:readline/promises';

export const KEY_HELP = [
  '未检测到 DEEPSEEK_API_KEY。',
  '可以先在 PowerShell 中设置：$env:DEEPSEEK_API_KEY="你的密钥"',
  '也可以现在输入密钥：输入不会回显，仅本次运行有效，不会写入磁盘。',
].join('\n');

export type HiddenInputMode = 'normal' | 'esc' | 'csi' | 'osc';

export interface HiddenInputState {
  value: string;
  mode: HiddenInputMode;
  done: boolean;
  cancelled: boolean;
}

export function initialHiddenInputState(): HiddenInputState {
  return { value: '', mode: 'normal', done: false, cancelled: false };
}

export function consumeHiddenChunk(state: HiddenInputState, chunk: string): HiddenInputState {
  const next: HiddenInputState = { ...state };

  for (const char of chunk) {
    if (next.done || next.cancelled) {
      break;
    }
    const code = char.charCodeAt(0);

    if (next.mode === 'esc') {
      if (char === '[') {
        next.mode = 'csi';
      } else if (char === ']') {
        next.mode = 'osc';
      } else {
        next.mode = 'normal';
      }
      continue;
    }

    if (next.mode === 'csi') {
      if (code >= 0x40 && code <= 0x7e) {
        next.mode = 'normal';
      }
      continue;
    }

    if (next.mode === 'osc') {
      if (char === '\u0007') {
        next.mode = 'normal';
      }
      continue;
    }

    if (char === '\u001b') {
      next.mode = 'esc';
    } else if (char === '\r' || char === '\n') {
      next.done = true;
    } else if (char === '\u0003') {
      next.cancelled = true;
    } else if (char === '\u007f' || char === '\b') {
      next.value = next.value.slice(0, -1);
    } else if (char >= ' ') {
      next.value += char;
    }
  }

  return next;
}

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
    let state = initialHiddenInputState();

    const cleanup = () => {
      input.off('data', onData);
      input.setRawMode(false);
    };

    const finish = (result: string | null) => {
      cleanup();
      output.write('\n');
      resolve(result);
    };

    const onData = (chunk: Buffer | string) => {
      state = consumeHiddenChunk(state, chunk.toString());
      if (state.cancelled) {
        finish(null);
      } else if (state.done) {
        finish(state.value);
      }
    };

    input.on('data', onData);
  });
}
