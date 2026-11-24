import { describe, expect, it } from 'vitest';
import { consumeHiddenChunk, initialHiddenInputState } from '../../src/cli/api-key.js';

function feed(...chunks: string[]) {
  let state = initialHiddenInputState();
  for (const chunk of chunks) {
    state = consumeHiddenChunk(state, chunk);
  }
  return state;
}

describe('hidden key input', () => {
  it('collects printable characters until Enter', () => {
    const state = feed('sk-abc', '\r');

    expect(state.value).toBe('sk-abc');
    expect(state.done).toBe(true);
  });

  it('strips bracketed paste markers', () => {
    const state = feed('\u001b[200~', 'sk-abc', '\u001b[201~', '\r');

    expect(state.value).toBe('sk-abc');
    expect(state.done).toBe(true);
  });

  it('supports backspace', () => {
    const state = feed('sk-abx', '\u007f', '\r');

    expect(state.value).toBe('sk-ab');
  });

  it('ignores arrow-key escape sequences', () => {
    const state = feed('sk-', '\u001b[A', 'abc\r');

    expect(state.value).toBe('sk-abc');
  });

  it('cancels on Ctrl+C', () => {
    const state = feed('sk-a', '\u0003');

    expect(state.cancelled).toBe(true);
  });
});
