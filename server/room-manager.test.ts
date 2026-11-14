import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RoomCatalog, hashRoomPassword } from './catalog.js';
import { createRoom } from './room-admin.js';
import { CatalogRoomAccess, RoomCapacityError, RoomConfigurationError, RoomManager, RoomUnavailableError } from './room-manager.js';
import { RoomStore } from './store.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'tabletop-board-manager-'));
}

async function setup(dataDir: string, maxOpenRooms = 8): Promise<{ catalog: RoomCatalog; manager: RoomManager }> {
  const catalog = RoomCatalog.initialize(dataDir);
  const manager = new RoomManager({ dataDir, catalog, maxOpenRooms });
  return { catalog, manager };
}

test('room manager: opens lazily, enforces status and bounded cache', async (t) => {
  const dataDir = tempDir();
  try {
    const catalog = RoomCatalog.initialize(dataDir);
    catalog.close();
    const first = await createRoom({ dataDir, name: 'PbtA', systemId: 'pbta-2d6', gmPassword: 'password-12345' });
    const second = await createRoom({ dataDir, name: 'Nechronica', systemId: 'nechronica', gmPassword: 'password-12345' });
    const third = await createRoom({ dataDir, name: 'Third', systemId: 'pbta-2d6', gmPassword: 'password-12345' });

    const { catalog: openCatalog, manager } = await setup(dataDir, 2);
    try {
      await t.test('1. No room database is opened at construction', () => {
        assert.equal(manager.openRoomCount, 0);
        assert.equal(manager.leasedRoomCount, 0);
      });

      await t.test('2. A lease opens the right room and survives release until evicted', () => {
        const lease = manager.acquire(first.room.id);
        try {
          assert.equal(lease.room.id, first.room.id);
          assert.equal(lease.store.roomName, 'PbtA');
          assert.match(lease.store.roomDir, new RegExp(`${first.room.id}$`));
          assert.equal(manager.openRoomCount, 1);
          assert.equal(manager.leasedRoomCount, 1);
        } finally {
          lease.release();
          lease.release();
        }
        assert.equal(manager.openRoomCount, 1);
        assert.equal(manager.leasedRoomCount, 0);
      });

      await t.test('3. Status is re-read from the catalog on every acquire', () => {
        openCatalog.setStatus(first.room.id, 'disabled');
        assert.throws(() => manager.acquire(first.room.id), (error: unknown) =>
          error instanceof RoomUnavailableError && error.code === 'ROOM_DISABLED');
        openCatalog.setStatus(first.room.id, 'archived');
        assert.throws(() => manager.acquire(first.room.id), (error: unknown) =>
          error instanceof RoomUnavailableError && error.code === 'ROOM_ARCHIVED');
        openCatalog.setStatus(first.room.id, 'active');
        manager.acquire(first.room.id).release();
      });

      await t.test('4. Unknown and traversal-like ids never resolve to a path', () => {
        assert.throws(() => manager.acquire('../../etc/passwd'), (error: unknown) =>
          error instanceof RoomUnavailableError && error.code === 'ROOM_NOT_FOUND');
        assert.throws(() => manager.roomDirectory('../escape'), RoomUnavailableError);
        assert.throws(() => manager.acquire('missing-room'), RoomUnavailableError);
      });

      await t.test('5. LRU evicts only idle rooms', () => {
        const held = manager.acquire(second.room.id);
        manager.acquire(third.room.id).release();
        assert.equal(manager.openRoomCount, 2);
        assert.ok(manager.leasedRoomCount >= 1);
        held.release();
        assert.equal(manager.openRoomCount, 2);
      });

      await t.test('6. Capacity is reported instead of opening unlimited databases', () => {
        const firstLease = manager.acquire(first.room.id);
        const secondLease = manager.acquire(second.room.id);
        try {
          assert.equal(manager.openRoomCount, 2);
          assert.throws(() => manager.acquire(third.room.id), (error: unknown) =>
            error instanceof RoomCapacityError && error.limit === 2);
        } finally {
          firstLease.release();
          secondLease.release();
        }
        manager.acquire(third.room.id).release();
      });

      await t.test('7. A requested close waits for the current lease', () => {
        const lease = manager.acquire(first.room.id);
        manager.requestClose(first.room.id);
        assert.equal(manager.openRoomCount, 2);
        lease.release();
        assert.equal(manager.openRoomCount, 1);
        const reopened = manager.acquire(first.room.id);
        reopened.release();
      });

      await t.test('8. The catalog access adapter exposes the same manager', () => {
        const access = new CatalogRoomAccess(manager);
        assert.equal(access.legacyCookie, false);
        assert.equal(access.getRoom(first.room.id)?.id, first.room.id);
        assert.equal(access.findByCode('00000000'), undefined);
        const lease = access.acquire(first.room.id);
        lease.release();
      });
    } finally {
      manager.close();
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('room manager: refuses contradictory or unfixed systems', async (t) => {
  const dataDir = tempDir();
  const catalog = RoomCatalog.initialize(dataDir);
  const manager = new RoomManager({ dataDir, catalog, maxOpenRooms: 4 });
  try {
    mkdirSync(join(dataDir, 'rooms'), { recursive: true });

    await t.test('1. Catalog and room database must agree', () => {
      const directory = join(dataDir, 'rooms', 'mismatch');
      const store = new RoomStore(directory, 'Mismatch');
      store.initializeSystem('pbta-2d6', '1.0.0');
      store.close();
      catalog.createRoom({
        id: 'mismatch',
        name: 'Mismatch',
        systemId: 'nechronica',
        systemVersion: '1.0.0',
        code: 'MISMATCH',
        passwordHash: hashRoomPassword('password-12345'),
      });
      assert.throws(() => manager.acquire('mismatch'), (error: unknown) =>
        error instanceof RoomConfigurationError && /противоречит каталогу/.test(error.message));
    });

    await t.test('2. An unfixed room is not started', () => {
      const directory = join(dataDir, 'rooms', 'unfixed');
      new RoomStore(directory, 'Unfixed').close();
      catalog.createRoom({
        id: 'unfixed',
        name: 'Unfixed',
        systemId: 'pbta-2d6',
        systemVersion: '1.0.0',
        code: 'UNFIXED2',
        passwordHash: hashRoomPassword('password-12345'),
      });
      assert.throws(() => manager.acquire('unfixed'), (error: unknown) =>
        error instanceof RoomConfigurationError && /не зафиксирована/.test(error.message));
    });

    await t.test('3. A catalog entry without its directory is a configuration error', () => {
      catalog.createRoom({
        id: 'missing-directory',
        name: 'Missing',
        systemId: 'pbta-2d6',
        systemVersion: '1.0.0',
        code: 'MISSING2',
        passwordHash: hashRoomPassword('password-12345'),
      });
      assert.throws(() => manager.acquire('missing-directory'), (error: unknown) =>
        error instanceof RoomConfigurationError && /отсутствует/.test(error.message));
    });
  } finally {
    manager.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
