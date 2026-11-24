import type { TodoItem, ToolDefinition } from '../types.js';

export const todoTool: ToolDefinition = {
  name: 'todo',
  description:
    '管理当前会话的待办事项：add 新增、list 查看、complete 标记完成。id 由系统生成（t1、t2…），complete 时必须使用已有 id。',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['add', 'list', 'complete'] },
      content: { type: 'string', minLength: 1 },
      id: { type: 'string', minLength: 1 },
    },
    required: ['action'],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const { action, content, id } = args as {
      action: 'add' | 'list' | 'complete';
      content?: string;
      id?: string;
    };
    const todos = ctx.session.todos;

    if (action === 'add') {
      if (!content || content.trim() === '') {
        throw new Error('add 需要 content');
      }
      const item: TodoItem = {
        id: nextId(todos),
        content: content.trim(),
        done: false,
        createdAt: new Date().toISOString(),
      };
      todos.push(item);
      return ok({ action, item, items: todos });
    }

    if (action === 'list') {
      return ok({ action, items: todos });
    }

    if (!id) {
      throw new Error('complete 需要 id');
    }
    const item = todos.find((todo) => todo.id === id);
    if (!item) {
      throw new Error(`未知待办 id：${id}。当前待办：${formatTodos(todos)}`);
    }
    item.done = true;
    return ok({ action, item, items: todos });
  },
};

function nextId(todos: TodoItem[]): string {
  let max = 0;
  for (const todo of todos) {
    const match = /^t(\d+)$/.exec(todo.id);
    if (match) {
      max = Math.max(max, Number(match[1]));
    }
  }
  return `t${max + 1}`;
}

function formatTodos(todos: TodoItem[]): string {
  if (todos.length === 0) {
    return '无';
  }
  return todos.map((todo) => `${todo.id} ${todo.done ? '[x]' : '[ ]'} ${todo.content}`).join('；');
}

function ok(payload: unknown) {
  return { content: JSON.stringify(payload), isError: false };
}
