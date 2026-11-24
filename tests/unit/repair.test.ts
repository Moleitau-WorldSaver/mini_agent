import { describe, expect, it } from 'vitest';
import { repairSession } from '../../src/session/repair.js';
import { createSession } from '../../src/session/session.js';

function base() {
  return createSession({ id: 'w1', model: 'deepseek-flash', thinking: true });
}

describe('repairSession', () => {
  it('backfills a missing tool result in order', () => {
    const session = base();
    session.messages.push({ role: 'user', content: '之前', turnId: 'turn-1' });
    session.messages.push({
      role: 'assistant',
      content: null,
      toolCalls: [
        { id: 'c1', name: 'calculator', arguments: '{}' },
        { id: 'c2', name: 'weather', arguments: '{}' },
      ],
      turnId: 'turn-1',
      step: 1,
    });
    session.messages.push({
      role: 'tool',
      toolCallId: 'c1',
      name: 'calculator',
      content: '{"ok":true}',
      isError: false,
      turnId: 'turn-1',
      step: 1,
    });

    const repaired = repairSession(session);

    expect(repaired).toBe(1);
    expect(session.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'tool', 'tool']);
    expect(session.messages[3]).toMatchObject({ role: 'tool', toolCallId: 'c2', name: 'weather', isError: true });
    expect(String(session.messages[3]!.content)).toContain('运行时恢复');
  });

  it('leaves complete sessions unchanged', () => {
    const session = base();
    session.messages.push({ role: 'user', content: '之前', turnId: 'turn-1' });
    session.messages.push({
      role: 'assistant',
      content: null,
      toolCalls: [{ id: 'c1', name: 'calculator', arguments: '{}' }],
      turnId: 'turn-1',
      step: 1,
    });
    session.messages.push({
      role: 'tool',
      toolCallId: 'c1',
      name: 'calculator',
      content: '{}',
      isError: false,
      turnId: 'turn-1',
      step: 1,
    });

    expect(repairSession(session)).toBe(0);
    expect(session.messages).toHaveLength(3);
  });
});
