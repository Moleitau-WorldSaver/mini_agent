import { mkdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sessionsDir } from './store.js';

export class SessionLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionLockError';
  }
}

export function lockFilePath(dataDir: string, id: string): string {
  return path.join(sessionsDir(dataDir), `${id}.lock`);
}

export async function acquireLock(dataDir: string, id: string, staleMs: number): Promise<() => Promise<void>> {
  await mkdir(sessionsDir(dataDir), { recursive: true });
  const file = lockFilePath(dataDir, id);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeFile(
        file,
        JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
        { encoding: 'utf8', flag: 'wx' },
      );

      const heartbeat = setInterval(() => {
        const now = new Date();
        void utimes(file, now, now).catch(() => {});
      }, Math.max(50, Math.floor(staleMs / 3)));
      heartbeat.unref();

      return async () => {
        clearInterval(heartbeat);
        await rm(file, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }

      let stale = true;
      try {
        const info = await stat(file);
        stale = Date.now() - info.mtimeMs > staleMs;
      } catch {
        stale = true;
      }

      if (!stale) {
        throw new SessionLockError(`会话 ${id} 正在使用（锁文件：${file}）`);
      }
      await rm(file, { force: true });
    }
  }

  throw new SessionLockError(`会话 ${id} 正在使用（锁文件：${file}）`);
}
