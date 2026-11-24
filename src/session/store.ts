import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Session } from '../types.js';
import { isValidSessionId } from './session.js';

export class SessionStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionStoreError';
  }
}

export function sessionsDir(dataDir: string): string {
  return path.join(dataDir, 'sessions');
}

export function sessionFilePath(dataDir: string, id: string): string {
  return path.join(sessionsDir(dataDir), `${id}.json`);
}

export async function loadSession(dataDir: string, id: string): Promise<Session | null> {
  if (!isValidSessionId(id)) {
    throw new SessionStoreError(`会话 id 不合法：${id}`);
  }
  const file = sessionFilePath(dataDir, id);
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SessionStoreError(`会话文件损坏：${file}`);
  }
  if (!isSession(parsed)) {
    throw new SessionStoreError(`会话文件结构不合法：${file}`);
  }
  return parsed;
}

export async function saveSession(dataDir: string, session: Session): Promise<void> {
  if (!isValidSessionId(session.id)) {
    throw new SessionStoreError(`会话 id 不合法：${session.id}`);
  }
  await mkdir(sessionsDir(dataDir), { recursive: true });
  const file = sessionFilePath(dataDir, session.id);
  const temp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  await writeFile(temp, `${JSON.stringify(session, null, 2)}\n`, 'utf8');
  await rename(temp, file);
}

function isSession(value: unknown): value is Session {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const session = value as Record<string, unknown>;
  return (
    session.version === 1 &&
    typeof session.id === 'string' &&
    typeof session.title === 'string' &&
    typeof session.createdAt === 'string' &&
    typeof session.updatedAt === 'string' &&
    typeof session.model === 'string' &&
    typeof session.thinking === 'boolean' &&
    typeof session.turnSeq === 'number' &&
    (session.summary === null || typeof session.summary === 'string') &&
    Array.isArray(session.todos) &&
    Array.isArray(session.messages)
  );
}
