import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RoomCatalog } from './catalog.js';
import {
  createCatalogBackup,
  createInstallBackup,
  listCatalogBackups,
  resolveCatalogBackup,
  restoreCatalogBackup,
  verifyCatalogBackup,
  verifyInstallBackup,
} from './catalog-backup.js';
import { createRoom } from './room-admin.js';
import { createBackup } from './backup-lib.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'tabletop-board-catalog-backup-'));
}

test('catalog backup keeps catalog.sqlite and server-secret together', async (t) => {
  const dataDir = tempDir();
  try {
    RoomCatalog.initialize(dataDir).close();
    const first = await createRoom({ dataDir, name: 'First', systemId: 'pbta-2d6', gmPassword: 'password-12345' });
    const second = await createRoom({ dataDir, name: 'Second', systemId: 'nechronica', gmPassword: 'password-12345' });

    await t.test('1. Creating a catalog backup includes both authorization files', async () => {
      const backup = await createCatalogBackup(dataDir);
      assert.equal(existsSync(join(backup.path, 'catalog.sqlite')), true);
      assert.equal(existsSync(join(backup.path, 'server-secret')), true);
      assert.equal(existsSync(join(backup.path, 'rooms')), false, 'копия каталога не должна содержать игровые данные');
      const verified = await verifyCatalogBackup(backup.path);
      assert.equal(verified.rooms, 2);
      assert.equal((await listCatalogBackups(dataDir, 'catalog'))[0]?.name, backup.name);
    });

    await t.test('2. A changed or missing secret invalidates the backup', async () => {
      const backup = await createCatalogBackup(dataDir);
      const secret = readFileSync(join(backup.path, 'server-secret'), 'utf8');
      writeFileSync(join(backup.path, 'server-secret'), `${secret.trim()}x\n`, { mode: 0o600 });
      await assert.rejects(() => verifyCatalogBackup(backup.path), /не совпадает с манифестом/);
    });

    await t.test('3. Restoring the catalog restores statuses consistently with the secret', async () => {
      const backup = await createCatalogBackup(dataDir);
      const catalog = RoomCatalog.open(dataDir);
      catalog.setStatus(first.room.id, 'disabled');
      catalog.close();
      const result = await restoreCatalogBackup(dataDir, backup.name);
      assert.ok(result.safety.startsWith('pre-restore-'));
      const restored = RoomCatalog.open(dataDir);
      try {
        assert.equal(restored.getRoom(first.room.id)?.status, 'active');
        assert.equal(restored.getRoom(second.room.id)?.status, 'active');
        assert.equal(restored.findRoomByCode(first.code)?.id, first.room.id);
      } finally { restored.close(); }
    });

    await t.test('4. Room ids and names cannot escape the backup stores', async () => {
      assert.throws(() => resolveCatalogBackup(dataDir, 'catalog', '../escape'), /имя копии/);
      await assert.rejects(() => verifyCatalogBackup(join(dataDir, 'catalog-backups', 'missing')), /ENOENT|no such file/);
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('full installation backup covers the catalog, its secret and every room', async (t) => {
  const dataDir = tempDir();
  try {
    RoomCatalog.initialize(dataDir).close();
    const pbta = await createRoom({ dataDir, name: 'PbtA', systemId: 'pbta-2d6', gmPassword: 'password-12345' });
    const nechronica = await createRoom({ dataDir, name: 'Nechronica', systemId: 'nechronica', gmPassword: 'password-12345' });
    const assetDir = join(dataDir, 'rooms', pbta.room.id, 'assets');
    mkdirSync(assetDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(assetDir, 'image-1'), 'png', { mode: 0o600 });

    await t.test('1. The full copy verifies every database and file', async () => {
      const backup = await createInstallBackup(dataDir);
      const verified = await verifyInstallBackup(backup.path);
      assert.equal(verified.rooms, 2);
      assert.ok(verified.files >= 4);
      assert.equal(existsSync(join(backup.path, 'rooms', pbta.room.id, 'room.sqlite')), true);
      assert.equal(existsSync(join(backup.path, 'rooms', nechronica.room.id, 'room.sqlite')), true);
      assert.equal(existsSync(join(backup.path, 'rooms', pbta.room.id, 'assets', 'image-1')), true);
      assert.equal(existsSync(join(backup.path, 'server-secret')), true);
      assert.equal((await listCatalogBackups(dataDir, 'install'))[0]?.name, backup.name);
    });

    await t.test('2. A room database damaged after copying is detected', async () => {
      const backup = await createInstallBackup(dataDir);
      writeFileSync(join(backup.path, 'rooms', pbta.room.id, 'room.sqlite'), 'not sqlite');
      await assert.rejects(() => verifyInstallBackup(backup.path), /не совпадает с манифестом/);
    });

    await t.test('3. A room backup never contains the server secret', async () => {
      const roomBackup = await createBackup(join(dataDir, 'rooms', pbta.room.id), pbta.room.name, 'backup', { roomId: pbta.room.id });
      assert.equal(readdirSync(roomBackup.path).includes('server-secret'), false);
      assert.equal(readdirSync(roomBackup.path).includes('catalog.sqlite'), false);
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
