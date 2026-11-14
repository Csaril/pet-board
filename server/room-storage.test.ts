import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { deflateSync } from 'node:zlib';
import test from 'node:test';
import { listBackups, createBackup, restoreBackup } from './backup-lib.js';
import { saveImageAsset } from './assets.js';
import { migrateStorage } from './room-migrate.js';
import {
  DEFAULT_ROOM_ID,
  STORAGE_MARKER,
  StorageLayoutError,
  legacyLayoutExists,
  readStorageMarker,
  resolveRoomDirectory,
  roomDirectory,
} from './room-storage.js';
import { RoomStore } from './store.js';

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function png(color: number): Buffer {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const chunk = (name: string, data: Buffer) => {
    const type = Buffer.from(name);
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(Buffer.concat([type, data])));
    return Buffer.concat([length, type, data, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([signature, chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0, color, 45, 60, 255]))), chunk('IEND', Buffer.alloc(0))]);
}

test('a fresh data root persists the default room ID and resolves the same directory twice', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tabletop-storage-fresh-'));
  try {
    const first = resolveRoomDirectory(dataDir);
    assert.equal(first, join(dataDir, 'rooms', DEFAULT_ROOM_ID));
    assert.ok(existsSync(first));
    const marker = readStorageMarker(dataDir);
    assert.deepEqual(marker, { version: 1, roomId: DEFAULT_ROOM_ID, layout: 'rooms' });
    assert.equal(resolveRoomDirectory(dataDir), first);
    assert.equal(existsSync(join(dataDir, STORAGE_MARKER)), true);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('a legacy data root is refused by the server until the migration command runs', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tabletop-storage-legacy-'));
  try {
    const store = new RoomStore(dataDir, 'Legacy');
    store.close();
    assert.ok(legacyLayoutExists(dataDir));
    assert.throws(() => resolveRoomDirectory(dataDir), /npm run room:migrate/);
    assert.equal(readStorageMarker(dataDir), undefined);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('migration copies the database, assets and backups, verifies them and is idempotent', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tabletop-storage-migrate-'));
  try {
    const legacy = new RoomStore(dataDir, 'Campaign');
    legacy.createLayer('Migrated layer');
    legacy.createSession('legacy-session', { name: 'Ari', role: 'player' }, Date.now() + 60_000);
    const savedParticipantId = legacy.getSession('legacy-session')!.participantId;
    const saved = await saveImageAsset(legacy, legacy.assetsDir, png(90), 'image/png', 'map.png', 1024 * 1024);
    legacy.close();
    const oldBackup = await createBackup(dataDir, 'Campaign');

    const result = await migrateStorage(dataDir, 'Campaign');
    assert.equal(result.alreadyMigrated, false);
    assert.equal(result.roomDir, roomDirectory(dataDir));
    assert.ok(result.safetyCopy.startsWith(dirname(dataDir)));
    assert.ok(existsSync(result.safetyCopy));
    assert.ok(result.assets >= 1);
    assert.ok(result.rows > 0);

    const target = roomDirectory(dataDir);
    assert.ok(existsSync(join(target, 'room.sqlite')));
    assert.ok(existsSync(join(target, 'assets', saved.asset.id)));
    assert.ok(existsSync(join(target, 'backups', oldBackup.name)));
    assert.ok(statSync(join(target, 'assets', saved.asset.id)).size > 0);
    assert.deepEqual(readStorageMarker(dataDir), { version: 1, roomId: DEFAULT_ROOM_ID, layout: 'rooms' });

    // Old data is intentionally left in place for rollback.
    assert.ok(existsSync(join(dataDir, 'room.sqlite')));
    assert.ok(existsSync(join(dataDir, 'assets', saved.asset.id)));
    assert.ok(existsSync(join(dataDir, 'backups', oldBackup.name)));

    const migrated = new RoomStore(target, 'Campaign');
    try {
      assert.ok(migrated.getLayers().some((layer) => layer.name === 'Migrated layer'));
      assert.ok(migrated.getAsset(saved.asset.id));
      assert.deepEqual(migrated.getSession('legacy-session'), { participantId: savedParticipantId, name: 'Ari', role: 'player' });
      assert.ok(migrated.getParticipant(savedParticipantId));
    } finally { migrated.close(); }

    const before = statSync(join(target, 'room.sqlite')).mtimeMs;
    const second = await migrateStorage(dataDir, 'Campaign');
    assert.equal(second.alreadyMigrated, true);
    assert.equal(statSync(join(target, 'room.sqlite')).mtimeMs, before);

    // Backups created at the old location remain listable and restorable from the room.
    const names = (await listBackups(target)).map((entry) => entry.name);
    assert.ok(names.includes(oldBackup.name));
    await restoreBackup(target, 'Campaign', oldBackup.name);
    const restored = new RoomStore(target, 'Campaign');
    try {
      assert.ok(restored.getLayers().some((layer) => layer.name === 'Migrated layer'));
      assert.ok(restored.getAsset(saved.asset.id));
    } finally { restored.close(); }
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('migration refuses a partial destination and a missing source without deleting anything', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tabletop-storage-partial-'));
  const emptyDir = mkdtempSync(join(tmpdir(), 'tabletop-storage-empty-'));
  try {
    const legacy = new RoomStore(dataDir, 'Legacy');
    legacy.close();
    mkdirSync(roomDirectory(dataDir), { recursive: true, mode: 0o700 });
    await assert.rejects(() => migrateStorage(dataDir, 'Legacy'), (error: unknown) => error instanceof StorageLayoutError && /уже существует/.test(error.message));
    assert.ok(existsSync(join(dataDir, 'room.sqlite')));
    assert.equal(readStorageMarker(dataDir), undefined);

    await assert.rejects(() => migrateStorage(emptyDir, 'Empty'), /миграция не требуется|исходные данные отсутствуют/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(emptyDir, { recursive: true, force: true });
  }
});
