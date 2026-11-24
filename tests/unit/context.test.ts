import { describe, expect, it } from 'vitest';
import { buildSystemPrompt, estimateTokens, findCompressionCut } from '../../src/runtime/context.js';
import type { ContextMessage } from '../../src/types.js';

function user(content: string): ContextMessage {
  return { role: 'user', content };
}

function assistant(content: string): ContextMessage {
  return { role: 'assistant', content };
}

function tool(id: string): ContextMessage {
  return { role: 'tool', toolCallId: id, name: 'x', content: '{"ok":true}', isError: false };
}

function assistantCall(id: string): ContextMessage {
  return { role: 'assistant', content: null, toolCalls: [{ id, name: 'x', arguments: '{}' }] };
}

describe('context assembly', () => {
  it('appends the summary section to the system prompt', () => {
    expect(buildSystemPrompt('BASE', null)).toBe('BASE');
    expect(buildSystemPrompt('BASE', '摘要')).toBe('BASE\n\n## 早前对话摘要\n摘要');
  });

  it('estimates a growing token count', () => {
    const base = estimateTokens('sys', [user('hi')], []);
    const longer = estimateTokens('sys', [user('hi'), assistant('a'.repeat(300))], []);
    expect(longer).toBeGreaterThan(base);
  });
});

describe('compression cut', () => {
  it('keeps at least keepRecent messages and cuts at a user boundary', () => {
    const messages = [
      user('u1'),
      assistantCall('c1'),
      tool('c1'),
      assistant('a1'),
      user('u2'),
      assistant('a2'),
      user('u3'),
      assistant('a3'),
    ];

    const cut = findCompressionCut(messages, 3);

    expect(cut).toBe(4);
    expect(messages[cut]?.role).toBe('user');
    expect(messages.length - cut).toBeGreaterThanOrEqual(3);
  });

  it('never cuts between a tool call and its result', () => {
    const messages = [user('u1'), assistantCall('c1'), tool('c1'), user('u2'), assistant('a2')];

    const cut = findCompressionCut(messages, 2);

    expect(cut).toBe(3);
    expect(messages.slice(cut)[0]?.role).toBe('user');
    expect(messages.slice(cut).some((message) => message.role === 'tool')).toBe(false);
  });

  it('refuses to cut when no safe user boundary exists', () => {
    const messages = [assistant('a1'), tool('c1'), assistant('a2')];
    expect(findCompressionCut(messages, 1)).toBe(0);
  });
});
