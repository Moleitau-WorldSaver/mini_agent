import type { Session } from '../types.js';

export const UNTITLED_TITLE = '未命名会话';

export interface CreateSessionOptions {
  id: string;
  model: string;
  thinking: boolean;
  now?: Date;
}

export function createSession(options: CreateSessionOptions): Session {
  const now = (options.now ?? new Date()).toISOString();
  return {
    version: 1,
    id: options.id,
    title: UNTITLED_TITLE,
    createdAt: now,
    updatedAt: now,
    model: options.model,
    thinking: options.thinking,
    turnSeq: 0,
    summary: null,
    todos: [],
    messages: [],
  };
}

export function touchSession(session: Session, now = new Date()): void {
  session.updatedAt = now.toISOString();
}

export function applyTitle(session: Session, input: string): void {
  if (session.title !== UNTITLED_TITLE) {
    return;
  }
  const title = input.replace(/\s+/g, ' ').trim().slice(0, 30);
  if (title) {
    session.title = title;
  }
}
