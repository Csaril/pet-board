import { loadConfig } from './config.js';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { RoomStore } from './store.js';

const config = loadConfig();
const backupDir = join(config.dataDir, 'backups');
mkdirSync(backupDir, { recursive: true, mode: 0o700 });
const timestamp = new Date().toISOString().replaceAll(':', '-');
const backupPath = join(backupDir, `room-${timestamp}.sqlite`);
const store = new RoomStore(config.dataDir, config.roomName);
try {
  await store.backup(backupPath);
  console.log(`Database backup written to ${backupPath}`);
} finally {
  store.close();
}
