import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createBackup, listBackups, resolveBackupDirectory, restoreBackup, verifyBackup } from './backup-lib.js';
import { RoomStore } from './store.js';

function writeAsset(dataDir: string, id: string, bytes: string): void {
  mkdirSync(join(dataDir, 'assets'), { recursive: true, mode: 0o700 });
  writeFileSync(join(dataDir, 'assets', id), bytes, { mode: 0o600 });
}

test('backup, verify, list and restore keep SQLite and images together', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tabletop-board-backup-'));
  const roomName = 'Campaign';
  try {
    const store = new RoomStore(dataDir, roomName);
    const layer = store.getLayers()[0]!;
    store.createAsset({ id: 'asset-1', sha256: 'hash-1', mimeType: 'image/png', originalName: 'map.png', size: 4, width: 1, height: 1 });
    writeAsset(dataDir, 'asset-1', 'PNG1');
    store.createObject({
      id: 'object-1', assetId: 'asset-1', layerId: layer.id, x: 10, y: 20, width: 30, height: 40,
      orderIndex: 0, flipX: false, flipY: false, crop: null, allowPlayerMove: false, freeStretch: false,
    });
    store.close();

    const backup = await createBackup(dataDir, roomName);
    assert.equal(backup.assetCount, 1);
    assert.equal((await listBackups(dataDir))[0]?.name, backup.name);
    assert.deepEqual(await verifyBackup(backup.path), { assetCount: 1, databaseBytes: backup.databaseBytes });

    const mutated = new RoomStore(dataDir, roomName);
    mutated.updateLayer(layer.id, { name: 'Changed layer' });
    mutated.deleteObject('object-1');
    mutated.close();
    const changed = new RoomStore(dataDir, roomName);
    assert.equal(changed.getLayers()[0]?.name, 'Changed layer');
    changed.close();

    const result = await restoreBackup(dataDir, roomName, backup.name);
    assert.ok(result.safetyBackup.startsWith('pre-restore-'));
    const restored = new RoomStore(dataDir, roomName);
    try {
      assert.equal(restored.getLayers()[0]?.name, 'Основной слой');
      assert.ok(restored.getObject('object-1'));
      assert.ok(restored.getAsset('asset-1'));
      assert.equal(existsSync(join(dataDir, 'assets', 'asset-1')), true);
    } finally {
      restored.close();
    }
    const names = (await listBackups(dataDir)).map((entry) => entry.name);
    assert.ok(names.includes(backup.name));
    assert.ok(names.includes(result.safetyBackup));
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('invalid backups are rejected before the current room is touched', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tabletop-board-broken-backup-'));
  const roomName = 'Campaign';
  try {
    const store = new RoomStore(dataDir, roomName);
    store.createLayer('Keep me', 'all-players');
    store.close();
    const brokenDir = join(dataDir, 'backups', 'broken-copy');
    mkdirSync(brokenDir, { recursive: true });
    writeFileSync(join(brokenDir, 'room.sqlite'), 'not a sqlite database');

    await assert.rejects(() => verifyBackup(brokenDir));
    await assert.rejects(() => restoreBackup(dataDir, roomName, 'broken-copy'));
    const current = new RoomStore(dataDir, roomName);
    try {
      assert.ok(current.getLayers().some((layer) => layer.name === 'Keep me'));
    } finally {
      current.close();
    }
    assert.throws(() => resolveBackupDirectory(dataDir, '../outside'), /имя копии/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('a backup with a missing image is rejected before restore changes anything', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tabletop-board-missing-image-'));
  const roomName = 'Campaign';
  try {
    const store = new RoomStore(dataDir, roomName);
    store.createLayer('Keep me', 'all-players');
    store.createAsset({ id: 'asset-1', sha256: 'hash-1', mimeType: 'image/png', originalName: 'map.png', size: 4, width: 1, height: 1 });
    writeAsset(dataDir, 'asset-1', 'PNG1');
    store.close();

    const backup = await createBackup(dataDir, roomName);
    rmSync(join(backup.path, 'assets', 'asset-1'));
    await assert.rejects(() => verifyBackup(backup.path), /изображение/);
    await assert.rejects(() => restoreBackup(dataDir, roomName, backup.name), /изображение/);

    const current = new RoomStore(dataDir, roomName);
    try {
      assert.ok(current.getLayers().some((layer) => layer.name === 'Keep me'));
      assert.ok(current.getAsset('asset-1'));
    } finally {
      current.close();
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
