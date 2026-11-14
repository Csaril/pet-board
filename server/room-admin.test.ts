import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RoomCatalog } from './catalog.js';
import { listBackups, verifyBackup } from './backup-lib.js';
import { adminRoomDirectory, archiveRoom, createRoom, deleteRoom, initializeDefaultRoom, setRoomStatus } from './room-admin.js';
import { RoomManager, RoomUnavailableError } from './room-manager.js';
import { RoomStore } from './store.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'tabletop-board-admin-'));
}

function cli(dataDir: string, args: string[], input?: string) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'server/rooms.ts', ...args], {
    cwd: process.cwd(),
    env: { ...process.env, APP_DATA_DIR: dataDir, NODE_ENV: 'test' },
    input,
    encoding: 'utf8',
    timeout: 60_000,
  });
}

test('room admin: defaults are migrated idempotently and new rooms are atomic', async (t) => {
  const dataDir = tempDir();
  try {
    const defaultDir = join(dataDir, 'rooms', 'default');
    const defaultStore = new RoomStore(defaultDir, 'Existing campaign');
    defaultStore.initializeSystem('pbta-2d6', '1.0.0');
    defaultStore.createLayer('Existing layer', 'all-players');
    defaultStore.close();

    await t.test('1. The existing default room is registered without moving its data', async () => {
      const result = await initializeDefaultRoom({
        dataDir, roomName: 'Existing campaign', roomCode: 'OLDCODE2', gmPassword: 'old-password-123',
      });
      assert.equal(result.created, true);
      assert.equal(result.room.id, 'default');
      assert.equal(result.room.systemId, 'pbta-2d6');
      assert.equal(result.room.systemVersion, '1.0.0');
      assert.equal(result.room.name, 'Existing campaign');
      const reopened = new RoomStore(defaultDir, 'ignored');
      try {
        assert.ok(reopened.getLayers().some((layer) => layer.name === 'Existing layer'));
      } finally { reopened.close(); }
    });

    await t.test('2. Re-running init never changes code, password, name or system', async () => {
      const second = await initializeDefaultRoom({
        dataDir, roomName: 'Renamed', roomCode: 'NEWCODE2', gmPassword: 'new-password-123',
      });
      assert.equal(second.created, false);
      assert.equal(second.room.name, 'Existing campaign');
      assert.equal(second.room.systemId, 'pbta-2d6');
      const catalog = RoomCatalog.open(dataDir);
      try {
        assert.equal(catalog.findRoomByCode('OLDCODE2')?.id, 'default');
        assert.equal(catalog.findRoomByCode('NEWCODE2'), undefined);
        assert.equal(catalog.verifyGmPassword('default', 'old-password-123'), true);
        assert.equal(catalog.verifyGmPassword('default', 'new-password-123'), false);
      } finally { catalog.close(); }
    });

    await t.test('3. Init refuses contradictions and missing rooms', async () => {
      const missing = tempDir();
      try {
        await assert.rejects(() => initializeDefaultRoom({ dataDir: missing, roomCode: 'ANYCODE2', gmPassword: 'password-12345' }), /Не найдена существующая комната/);
      } finally { rmSync(missing, { recursive: true, force: true }); }

      const conflict = tempDir();
      try {
        const conflictStore = new RoomStore(join(conflict, 'rooms', 'default'), 'Conflict');
        conflictStore.initializeSystem('nechronica', '1.0.0');
        conflictStore.close();
        const conflictCatalog = RoomCatalog.initialize(conflict);
        conflictCatalog.createRoom({
          id: 'default', name: 'Conflict', systemId: 'pbta-2d6', systemVersion: '1.0.0',
          code: 'CONFLCT2', passwordHash: 'scrypt$1024$8$1$0000000000000000$0000000000000000000000000000000000000000000000000000000000000000',
        });
        conflictCatalog.close();
        await assert.rejects(
          () => initializeDefaultRoom({ dataDir: conflict, roomName: 'Conflict', roomCode: 'CONFLCT2', gmPassword: 'password-12345' }),
          /не совпадает с базой/,
        );
      } finally { rmSync(conflict, { recursive: true, force: true }); }
    });

    await t.test('4. New rooms have their own directory, assets, backups and fixed system', async () => {
      const created = await createRoom({ dataDir, name: 'New Nechronica', systemId: 'nechronica', gmPassword: 'password-12345' });
      assert.match(created.room.id, /^[0-9a-f-]{36}$/);
      assert.match(created.code, /^[A-HJ-NP-Z2-9]{8}$/);
      const directory = adminRoomDirectory(dataDir, created.room.id);
      assert.equal(existsSync(join(directory, 'room.sqlite')), true);
      assert.equal(existsSync(join(directory, 'assets')), true);
      assert.equal(existsSync(join(directory, 'backups')), true);
      assert.equal(readdirSync(join(dataDir, 'rooms')).some((name) => name.startsWith('.creating-')), false);
      const store = new RoomStore(directory, 'New Nechronica');
      try {
        assert.equal(store.roomSystem.id, 'nechronica');
        assert.equal(store.roomSystem.version, '1.0.0');
        assert.equal(store.roomSystem.fixed, true);
        assert.equal(store.getLayers('board').length, 1);
        assert.equal(store.getLayers('battle').length, 1);
      } finally { store.close(); }
    });

    await t.test('5. Failed creation leaves no catalog entry or partial directory', async () => {
      const before = readdirSync(join(dataDir, 'rooms')).sort();
      await assert.rejects(() => createRoom({ dataDir, name: 'Bad', systemId: 'unknown-system', gmPassword: 'password-12345' }), /Неизвестная игровая система/);
      await assert.rejects(() => createRoom({ dataDir, name: 'Weak', systemId: 'pbta-2d6', gmPassword: 'short' }), /не менее 10/);
      assert.deepEqual(readdirSync(join(dataDir, 'rooms')).sort(), before);
    });

    await t.test('6. Disable, enable and archive preserve data and create a final backup', async () => {
      const created = await createRoom({ dataDir, name: 'Archive me', systemId: 'pbta-2d6', gmPassword: 'password-12345' });
      const store = new RoomStore(adminRoomDirectory(dataDir, created.room.id), 'Archive me');
      store.createLayer('Keep after archive', 'all-players');
      store.close();

      assert.equal(setRoomStatus(dataDir, created.room.id, 'disabled').status, 'disabled');
      const manager = new RoomManager({ dataDir, catalog: RoomCatalog.open(dataDir) });
      try {
        assert.throws(() => manager.acquire(created.room.id), (error: unknown) =>
          error instanceof RoomUnavailableError && error.code === 'ROOM_DISABLED');
      } finally { manager.close(); }
      assert.equal(setRoomStatus(dataDir, created.room.id, 'active').status, 'active');

      const archived = await archiveRoom(dataDir, created.room.id);
      assert.equal(archived.room.status, 'archived');
      const backups = await listBackups(adminRoomDirectory(dataDir, created.room.id));
      assert.ok(backups.some((backup) => backup.name === archived.backup));
      const verified = await verifyBackup(backups.find((backup) => backup.name === archived.backup)!.path);
      assert.equal(verified.roomId, created.room.id);
      assert.equal(verified.systemId, 'pbta-2d6');

      const persisted = new RoomStore(adminRoomDirectory(dataDir, created.room.id), 'Archive me');
      try {
        assert.ok(persisted.getLayers().some((layer) => layer.name === 'Keep after archive'));
      } finally { persisted.close(); }
    });

    await t.test('7. JSON status changes from another process are visible without restart', () => {
      const catalog = RoomCatalog.open(dataDir);
      const before = catalog.getRoom('default');
      catalog.close();
      assert.equal(before?.status, 'active');
      const cliResult = cli(dataDir, ['disable', 'default']);
      assert.equal(cliResult.status, 0, cliResult.stderr);
      const after = RoomCatalog.open(dataDir);
      try {
        assert.equal(after.getRoom('default')?.status, 'disabled');
      } finally { after.close(); }
      assert.equal(cli(dataDir, ['enable', 'default']).status, 0);
      assert.equal(cli(dataDir, ['archive', 'default', '--yes']).status, 0);
      const archived = RoomCatalog.open(dataDir);
      try { assert.equal(archived.getRoom('default')?.status, 'archived'); } finally { archived.close(); }
      assert.match(cli(dataDir, ['enable', 'default']).stderr, /нельзя включить/);
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('room deletion keeps a final backup outside the deleted directory', async (t) => {
  const dataDir = tempDir();
  try {
    RoomCatalog.initialize(dataDir).close();
    const created = await createRoom({ dataDir, name: 'Delete me', systemId: 'pbta-2d6', gmPassword: 'password-12345' });
    const directory = adminRoomDirectory(dataDir, created.room.id);
    const store = new RoomStore(directory, 'Delete me');
    store.createLayer('Keep in backup', 'all-players');
    store.close();

    await t.test('1. A non-archived room is refused without force or archive', async () => {
      await assert.rejects(() => deleteRoom({ dataDir, roomId: created.room.id }), /не архивирована/);
      assert.equal(existsSync(directory), true);
      const catalog = RoomCatalog.open(dataDir);
      try { assert.ok(catalog.getRoom(created.room.id)); } finally { catalog.close(); }
    });

    await t.test('2. Unknown and invalid identifiers are rejected', async () => {
      await assert.rejects(() => deleteRoom({ dataDir, roomId: 'missing-room', force: true }), /не найдена/);
      await assert.rejects(() => deleteRoom({ dataDir, roomId: '../escape', force: true }), /не найдена/);
    });

    await t.test('3. Archived rooms are deleted with backups preserved in data/deleted-rooms', async () => {
      const archived = await archiveRoom(dataDir, created.room.id);
      assert.equal(archived.room.status, 'archived');
      const result = await deleteRoom({ dataDir, roomId: created.room.id });
      assert.equal(result.room.id, created.room.id);
      assert.equal(existsSync(directory), false);
      assert.ok(result.preservedRoot);
      assert.ok(result.preservedBackup);
      assert.ok(result.preservedBackup!.startsWith(result.preservedRoot!));

      const catalog = RoomCatalog.open(dataDir);
      try {
        assert.equal(catalog.getRoom(created.room.id), undefined);
        assert.equal(catalog.findRoomByCode(created.code), undefined);
        assert.equal(catalog.listRooms().length, 0);
      } finally { catalog.close(); }

      const record = JSON.parse(readFileSync(join(result.preservedRoot!, 'room.json'), 'utf8')) as Record<string, unknown>;
      assert.equal(record.id, created.room.id);
      assert.equal(record.name, 'Delete me');
      assert.equal(record.systemId, 'pbta-2d6');
      assert.equal(record.statusAtDeletion, 'archived');

      const backups = await listBackups(result.preservedRoot!);
      assert.ok(backups.some((backup) => backup.name === archived.backup));
      const finalName = result.preservedBackup!.split('/').pop()!;
      assert.ok(backups.some((backup) => backup.name === finalName));
      const verified = await verifyBackup(backups.find((backup) => backup.name === finalName)!.path);
      assert.equal(verified.roomId, created.room.id);
      assert.equal(verified.systemId, 'pbta-2d6');
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('rooms CLI deletes an active room only with force and confirmation', async (t) => {
  const dataDir = tempDir();
  try {
    RoomCatalog.initialize(dataDir).close();
    const created = await createRoom({ dataDir, name: 'CLI delete', systemId: 'nechronica', gmPassword: 'password-12345' });
    const directory = adminRoomDirectory(dataDir, created.room.id);

    await t.test('1. Without --yes the non-TTY CLI cancels deletion', () => {
      const cancel = cli(dataDir, ['delete', created.room.id, '--force']);
      assert.equal(cancel.status, 0, cancel.stderr);
      assert.match(cancel.stdout, /Удаление отменено/);
      assert.equal(existsSync(directory), true);
    });

    await t.test('2. An active room without --force is refused', () => {
      const refused = cli(dataDir, ['delete', created.room.id, '--yes']);
      assert.equal(refused.status, 1);
      assert.match(refused.stderr, /--force/);
      assert.equal(existsSync(directory), true);
    });

    await t.test('3. --force --yes removes the room and keeps a backup copy', () => {
      const removed = cli(dataDir, ['delete', created.room.id, '--force', '--yes']);
      assert.equal(removed.status, 0, removed.stderr);
      assert.match(removed.stdout, /удалена из каталога/);
      assert.match(removed.stdout, /Финальная копия/);
      assert.equal(existsSync(directory), false);
      const catalog = RoomCatalog.open(dataDir);
      try {
        assert.equal(catalog.getRoom(created.room.id), undefined);
        assert.equal(catalog.findRoomByCode(created.code), undefined);
      } finally { catalog.close(); }
      const preserved = readdirSync(join(dataDir, 'deleted-rooms'));
      assert.equal(preserved.length, 1);
      assert.ok(existsSync(join(dataDir, 'deleted-rooms', preserved[0]!, 'backups')));
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('rooms CLI creates a room, prints the code once and hides secrets in list output', async (t) => {
  const dataDir = tempDir();
  try {
    RoomCatalog.initialize(dataDir).close();
    const create = cli(dataDir, ['create', '--name', 'CLI room', '--system', 'nechronica'], 'cli-password-123\n');
    assert.equal(create.status, 0, create.stderr);
    const code = /Код подключения: ([A-HJ-NP-Z2-9]{8})/.exec(create.stdout)?.[1];
    assert.ok(code, `Код не напечатан: ${create.stdout}`);
    assert.doesNotMatch(create.stdout, /cli-password-123/);
    const id = /ID: ([0-9a-f-]{36})/.exec(create.stdout)?.[1];
    assert.ok(id);
    assert.match(create.stdout, /Система: nechronica@/);

    const catalog = RoomCatalog.open(dataDir);
    try {
      assert.equal(catalog.findRoomByCode(code)?.id, id);
      assert.equal(catalog.verifyGmPassword(id, 'cli-password-123'), true);
    } finally { catalog.close(); }

    await t.test('1. The list command never prints codes, HMACs or password hashes', () => {
      const list = cli(dataDir, ['list']);
      assert.equal(list.status, 0, list.stderr);
      assert.match(list.stdout, new RegExp(id!));
      assert.match(list.stdout, /nechronica@/);
      assert.match(list.stdout, /активна/);
      assert.doesNotMatch(list.stdout, new RegExp(code!));
      assert.doesNotMatch(list.stdout, /scrypt\$|[0-9a-f]{64}/);
      assert.doesNotMatch(list.stdout, /cli-password-123/);
    });

    await t.test('2. Init reports a missing default room and does not create one', () => {
      const init = cli(dataDir, ['init']);
      assert.equal(init.status, 1);
      assert.match(init.stderr, /Не найдена существующая комната/);
      const catalog = RoomCatalog.open(dataDir);
      try { assert.equal(catalog.listRooms().length, 1); } finally { catalog.close(); }
    });

    await t.test('3. Archive without confirmation in a non-TTY is cancelled', () => {
      const cancel = cli(dataDir, ['archive', id!]);
      assert.equal(cancel.status, 0, cancel.stderr);
      assert.match(cancel.stdout, /отменено/);
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
