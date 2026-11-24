import type { Session } from '../types.js';

export const UNTITLED_TITLE = '未命名会话';

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

export function isValidSessionId(id: string): boolean {
  return SESSION_ID_PATTERN.test(id);
}

export function newSessionId(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `s-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

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
