import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const SERVER_LOCK_FILE = 'server.lock';

export function serverLockPath(dataDir: string): string {
  return join(dataDir, SERVER_LOCK_FILE);
}

/** True when the pid exists and the current user may signal it. */
function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readLockPid(path: string): number | null {
  try {
    const pid = Number(readFileSync(path, 'utf8').trim());
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Creates `data/server.lock` for a production server process. A second server
 * or an offline migration must never touch the same SQLite files concurrently.
 */
export function acquireServerLock(dataDir: string): () => void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const path = serverLockPath(dataDir);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(path, `${process.pid}\n`, { mode: 0o600, flag: 'wx' });
      return () => releaseServerLock(dataDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const pid = readLockPid(path);
      if (pid !== null && pid !== process.pid && isProcessAlive(pid)) {
        throw new Error(`Сервер уже запущен (pid ${pid}). Остановите его перед повторным запуском.`);
      }
      // A stale lock from a crashed process is safe to replace.
      try { unlinkSync(path); } catch { /* another process may have removed it */ }
    }
  }
  throw new Error('Не удалось создать файл блокировки сервера.');
}

export function releaseServerLock(dataDir: string): void {
  const path = serverLockPath(dataDir);
  if (!existsSync(path)) return;
  try {
    if (readLockPid(path) === process.pid) unlinkSync(path);
  } catch { /* best-effort cleanup on shutdown */ }
}

/**
 * Refuses an offline migration while a live server owns the data directory.
 * A stale lock is removed; a live pid aborts with an actionable message.
 */
export function assertServerStopped(dataDir: string): void {
  const path = serverLockPath(dataDir);
  if (!existsSync(path)) return;
  const pid = readLockPid(path);
  if (pid !== null && pid !== process.pid && isProcessAlive(pid)) {
    throw new Error(
      `Сервер уже запущен (pid ${pid}) и использует ${dataDir}. `
      + 'Остановите сервер и повторите команду: одновременная миграция SQLite-файлов запрещена.',
    );
  }
  try { unlinkSync(path); } catch { /* stale lock is best-effort */ }
}
