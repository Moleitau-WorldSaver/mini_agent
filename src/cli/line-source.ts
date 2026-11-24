import { createInterface } from 'node:readline/promises';

export interface LineSource {
  next(): Promise<string | null>;
  close(): void;
  onInterrupt?: (handler: () => void) => () => void;
}

export function fromAsyncIterable(lines: AsyncIterable<string>): LineSource {
  const iterator = lines[Symbol.asyncIterator]();
  return {
    async next() {
      const result = await iterator.next();
      return result.done ? null : result.value;
    },
    close() {
      void iterator.return?.();
    },
  };
}

export function readlineSource(): LineSource {
  const terminal = process.stdin.isTTY === true;
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal });
  const iterator = rl[Symbol.asyncIterator]();
  return {
    async next() {
      if (terminal) {
        rl.setPrompt('你> ');
        rl.prompt();
      }
      try {
        const result = await iterator.next();
        return result.done ? null : result.value;
      } catch {
        return null;
      }
    },
    close() {
      rl.close();
    },
    onInterrupt(handler: () => void) {
      rl.on('SIGINT', handler);
      return () => {
        rl.off('SIGINT', handler);
      };
    },
  };
}
