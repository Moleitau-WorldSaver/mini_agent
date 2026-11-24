import type { RuntimeEvent } from '../runtime/loop.js';
import type { SessionSummary } from '../session/manager.js';
import type { Session } from '../types.js';
import { truncate } from '../text.js';

export const REPL_HELP = [
  '可用命令：',
  '  /help          显示帮助',
  '  /new [id]      新建并切换会话',
  '  /switch <id>   切换会话',
  '  /todos         查看当前会话的待办',
  '  /exit          退出（也可用 /quit）',
  '直接输入文字即可对话。',
].join('\n');

export function formatSessionList(items: SessionSummary[]): string {
  if (items.length === 0) {
    return '暂无会话。';
  }
  return items
    .map(
      (item) =>
        `${item.id} | ${item.title} | ${item.updatedAt} | 消息 ${item.messageCount} | 待办 ${item.todoCount} | 思考 ${item.thinking ? '开' : '关'}`,
    )
    .join('\n');
}

export function formatTodos(session: Session): string {
  if (session.todos.length === 0) {
    return '当前会话没有待办。';
  }
  return session.todos.map((todo) => `${todo.id} [${todo.done ? 'x' : ' '}] ${todo.content}`).join('\n');
}

export function printToolEvent(event: RuntimeEvent, out: (line: string) => void): void {
  if (event.type !== 'tool') {
    return;
  }
  const args = compactArguments(event.call.arguments);
  const result = truncate(event.result.content, 160);
  out(`[工具] ${event.call.name} ${args} → ${event.result.isError ? '错误：' : ''}${result}`);
}

function compactArguments(raw: string): string {
  try {
    return truncate(JSON.stringify(JSON.parse(raw) as unknown), 120);
  } catch {
    return truncate(raw, 120);
  }
}
