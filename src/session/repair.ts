import type { Session, ToolMessage } from '../types.js';

export function repairSession(session: Session): number {
  let repaired = 0;

  for (let index = 0; index < session.messages.length; index += 1) {
    const message = session.messages[index]!;
    if (message.role !== 'assistant' || !message.toolCalls || message.toolCalls.length === 0) {
      continue;
    }

    const present = new Set<string>();
    let end = index + 1;
    while (end < session.messages.length && session.messages[end]!.role === 'tool') {
      present.add((session.messages[end] as ToolMessage).toolCallId);
      end += 1;
    }

    let insertAt = end;
    for (const call of message.toolCalls) {
      if (present.has(call.id)) {
        continue;
      }
      session.messages.splice(insertAt, 0, {
        role: 'tool',
        toolCallId: call.id,
        name: call.name,
        content: JSON.stringify({ error: '运行时恢复：该工具调用未完成' }),
        isError: true,
        turnId: message.turnId,
        step: message.step,
      });
      insertAt += 1;
      repaired += 1;
    }

    index = insertAt - 1;
  }

  return repaired;
}
