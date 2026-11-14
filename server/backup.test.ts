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
    assert.deepEqual(await verifyBackup(backup.path), {
      version: 2,
      assetCount: 1,
      databaseBytes: backup.databaseBytes,
      roomName,
      systemId: null,
      systemVersion: null,
      schemaVersion: 1,
    });

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

test('room backup manifests carry room and system identity and restore verifies both', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tabletop-board-room-manifest-'));
  const otherDir = mkdtempSync(join(tmpdir(), 'tabletop-board-room-other-'));
  const roomName = 'Manifest room';
  try {
    const store = new RoomStore(dataDir, roomName);
    store.initializeSystem('pbta-2d6', '1.0.0');
    store.createAsset({ id: 'asset-1', sha256: 'hash-1', mimeType: 'image/png', originalName: 'map.png', size: 4, width: 1, height: 1 });
    writeAsset(dataDir, 'asset-1', 'PNG1');
    store.createNote({
      id: 'note-1', title: 'Before backup', body: 'kept', access: 'gm-only', selectedParticipantIds: [],
      creatorId: 'gm-1', assetIds: [], markerType: 'text', markerText: '', fontFamily: 'default',
    });
    store.close();

    const metadata = { roomId: 'room-a', systemId: 'pbta-2d6', systemVersion: '1.0.0', schemaVersion: 1 };
    const backup = await createBackup(dataDir, roomName, 'backup', metadata);
    assert.equal(backup.roomId, 'room-a');
    assert.equal(backup.systemId, 'pbta-2d6');
    assert.equal(backup.systemVersion, '1.0.0');
    assert.equal(backup.version, 2);
    assert.equal(backup.files?.length, 2);
    assert.ok(backup.files?.every((file) => /^[0-9a-f]{64}$/.test(file.sha256)));

    const verified = await verifyBackup(backup.path);
    assert.equal(verified.roomId, 'room-a');
    assert.equal(verified.systemId, 'pbta-2d6');
    assert.equal(verified.systemVersion, '1.0.0');
    assert.equal(verified.version, 2);

    await assert.rejects(
      () => restoreBackup(dataDir, roomName, backup.name, { roomId: 'room-b', systemId: 'pbta-2d6', systemVersion: '1.0.0' }),
      /принадлежит комнате room-a/,
    );
    await assert.rejects(
      () => restoreBackup(dataDir, roomName, backup.name, { roomId: 'room-a', systemId: 'nechronica', systemVersion: '1.0.0' }),
      /Системная принадлежность/,
    );
    await assert.rejects(
      () => restoreBackup(dataDir, roomName, backup.name, {
        roomId: 'room-b', systemId: 'nechronica', systemVersion: '1.0.0', allowRoomMismatch: true,
      }),
      /Системная принадлежность/,
    );

    // A deleted room's backup can be restored into a new room of the same system.
    const mismatched = await restoreBackup(dataDir, roomName, backup.name, {
      roomId: 'room-b', systemId: 'pbta-2d6', systemVersion: '1.0.0', allowRoomMismatch: true,
    });
    assert.match(mismatched.safetyBackup, /^pre-restore-/);

    const changed = new RoomStore(dataDir, roomName);
    changed.updateNote('note-1', { title: 'Changed', body: '', access: 'gm-only', selectedParticipantIds: [], assetIds: [], markerType: 'text', markerText: '', fontFamily: 'default' });
    changed.close();
    const result = await restoreBackup(dataDir, roomName, backup.name, { roomId: 'room-a', systemId: 'pbta-2d6', systemVersion: '1.0.0' });
    const restored = new RoomStore(dataDir, roomName);
    try {
      assert.equal(restored.getNote('note-1')?.title, 'Before backup');
      assert.ok((await listBackups(dataDir)).some((entry) => entry.name === result.safetyBackup));
    } finally { restored.close(); }

    // The other room is never touched by a restore.
    const other = new RoomStore(otherDir, 'Other');
    other.initializeSystem('nechronica', '1.0.0');
    other.createLayer('Other layer', 'all-players');
    other.close();
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(otherDir, { recursive: true, force: true });
  }
});

test('a checksum mismatch in a v2 backup is detected before restore', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tabletop-board-checksum-'));
  const roomName = 'Checksum';
  try {
    const store = new RoomStore(dataDir, roomName);
    store.createAsset({ id: 'asset-1', sha256: 'hash-1', mimeType: 'image/png', originalName: 'map.png', size: 4, width: 1, height: 1 });
    writeAsset(dataDir, 'asset-1', 'PNG1');
    store.close();
    const backup = await createBackup(dataDir, roomName, 'backup', { roomId: 'room-a' });
    writeFileSync(join(backup.path, 'assets', 'asset-1'), 'EVIL');
    await assert.rejects(() => verifyBackup(backup.path), /Контрольная сумма/);
    await assert.rejects(() => restoreBackup(dataDir, roomName, backup.name, { roomId: 'room-a' }), /Контрольная сумма/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('version 1 backups without a room id remain restorable into an explicitly chosen room', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tabletop-board-v1-backup-'));
  const roomName = 'Legacy room';
  try {
    const store = new RoomStore(dataDir, roomName);
    store.initializeSystem('pbta-2d6', '1.0.0');
    store.createNote({
      id: 'legacy-note', title: 'Legacy', body: '', access: 'gm-only', selectedParticipantIds: [],
      creatorId: 'gm-1', assetIds: [], markerType: 'text', markerText: '', fontFamily: 'default',
    });
    store.close();

    const directory = join(dataDir, 'backups', 'legacy-copy');
    mkdirSync(join(directory, 'assets'), { recursive: true });
    const source = new RoomStore(dataDir, roomName);
    await source.backup(join(directory, 'room.sqlite'));
    source.close();
    writeFileSync(join(directory, 'manifest.json'), JSON.stringify({
      version: 1, name: 'legacy-copy', createdAt: new Date().toISOString(), roomName, assetCount: 0, databaseBytes: 0,
    }));

    const verified = await verifyBackup(directory);
    assert.equal(verified.version, 1);
    assert.equal(verified.roomId, undefined);
    assert.equal(verified.systemId, 'pbta-2d6');
    assert.equal(verified.systemVersion, '1.0.0');

    const changed = new RoomStore(dataDir, roomName);
    changed.deleteNote('legacy-note');
    changed.close();
    await restoreBackup(dataDir, roomName, 'legacy-copy', { roomId: 'default' });
    const restored = new RoomStore(dataDir, roomName);
    try {
      assert.equal(restored.getNote('legacy-note')?.title, 'Legacy');
    } finally { restored.close(); }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
