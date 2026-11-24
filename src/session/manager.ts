import { readdir } from 'node:fs/promises';
import type { Session } from '../types.js';
import { createSession, newSessionId } from './session.js';
import { loadSession, saveSession, SessionStoreError, sessionsDir } from './store.js';

export interface SessionSummary {
  id: string;
  title: string;
  updatedAt: string;
  messageCount: number;
  todoCount: number;
  thinking: boolean;
  model: string;
}

export interface SessionManagerOptions {
  dataDir: string;
  model: string;
  thinking: boolean;
  onWarning?: (message: string) => void;
}

export class SessionManager {
  private readonly options: SessionManagerOptions;

  constructor(options: SessionManagerOptions) {
    this.options = options;
  }

  async open(id: string): Promise<{ session: Session; created: boolean }> {
    const existing = await loadSession(this.options.dataDir, id);
    if (existing) {
      return { session: existing, created: false };
    }
    const session = createSession({
      id,
      model: this.options.model,
      thinking: this.options.thinking,
    });
    await saveSession(this.options.dataDir, session);
    return { session, created: true };
  }

  async create(id?: string): Promise<Session> {
    const sessionId = id ?? newSessionId();
    const existing = await loadSession(this.options.dataDir, sessionId);
    if (existing) {
      throw new SessionStoreError(`会话已存在：${sessionId}`);
    }
    const session = createSession({
      id: sessionId,
      model: this.options.model,
      thinking: this.options.thinking,
    });
    await saveSession(this.options.dataDir, session);
    return session;
  }

  async save(session: Session): Promise<void> {
    await saveSession(this.options.dataDir, session);
  }

  async list(): Promise<SessionSummary[]> {
    let entries: string[];
    try {
      entries = await readdir(sessionsDir(this.options.dataDir));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }

    const summaries: SessionSummary[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.json')) {
        continue;
      }
      const id = entry.slice(0, -'.json'.length);
      try {
        const session = await loadSession(this.options.dataDir, id);
        if (!session) {
          continue;
        }
        summaries.push({
          id: session.id,
          title: session.title,
          updatedAt: session.updatedAt,
          messageCount: session.messages.length,
          todoCount: session.todos.length,
          thinking: session.thinking,
          model: session.model,
        });
      } catch (error) {
        this.options.onWarning?.(
          `跳过无法读取的会话 ${id}：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
}
