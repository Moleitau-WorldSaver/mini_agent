import { utimes, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { acquireLock, lockFilePath, SessionLockError } from '../../src/session/lock.js';
import { makeTempDir, removeDir } from '../helpers.js';

describe('session lock', () => {
  it('rejects a second holder until released', async () => {
    const dir = await makeTempDir();
    try {
      const release = await acquireLock(dir, 'w1', 60_000);
      await expect(acquireLock(dir, 'w1', 60_000)).rejects.toBeInstanceOf(SessionLockError);
      await release();

      const again = await acquireLock(dir, 'w1', 60_000);
      await again();
    } finally {
      await removeDir(dir);
    }
  });

  it('replaces a stale lock', async () => {
    const dir = await makeTempDir();
    try {
      const release = await acquireLock(dir, 'w1', 60_000);
      await release();

      const file = lockFilePath(dir, 'w1');
      await writeFile(file, '{}', 'utf8');
      await utimes(file, new Date(0), new Date(0));

      const acquired = await acquireLock(dir, 'w1', 10_000);
      await acquired();
    } finally {
      await removeDir(dir);
    }
  });
});
