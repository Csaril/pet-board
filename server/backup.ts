import { loadConfig } from './config.js';
import { chmod, cp, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { RoomStore } from './store.js';

const config = loadConfig();
const backupDir = join(config.dataDir, 'backups');
await mkdir(backupDir, { recursive: true, mode: 0o700 });
const timestamp = new Date().toISOString().replaceAll(':', '-');
const backupPath = join(backupDir, `backup-${timestamp}`);
const backupAssetsDir = join(backupPath, 'assets');
await mkdir(backupAssetsDir, { recursive: true, mode: 0o700 });
const store = new RoomStore(config.dataDir, config.roomName);
try {
  await store.backup(join(backupPath, 'room.sqlite'));
  const sourceAssetsDir = join(config.dataDir, 'assets');
  if (existsSync(sourceAssetsDir)) {
    for (const filename of await readdir(sourceAssetsDir)) {
      const target = join(backupAssetsDir, filename);
      await cp(join(sourceAssetsDir, filename), target, { errorOnExist: true, force: false });
      await chmod(target, 0o600);
    }
  }
  console.log(`Room backup written to ${backupPath}`);
} finally {
  store.close();
}
