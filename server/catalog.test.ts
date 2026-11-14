import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  CatalogNotInitializedError,
  CatalogSecretMissingError,
  RoomCatalog,
  RoomConflictError,
  assertValidRoomId,
  generateRoomCode,
  hashRoomPassword,
  hmacRoomCode,
  normalizeRoomCode,
  verifyRoomPassword,
} from './catalog.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'tabletop-board-catalog-'));
}

function createSampleRoom(catalog: RoomCatalog, id: string, code: string) {
  return catalog.createRoom({
    id,
    name: `Room ${id}`,
    systemId: 'pbta-2d6',
    systemVersion: '1.0.0',
    code,
    passwordHash: hashRoomPassword('correct horse battery staple'),
  });
}

test('catalog: initialization, secret handling and authorization metadata', async (t) => {
  const dataDir = tempDir();
  try {
    await t.test('1. Opening a missing catalog never creates one', () => {
      assert.throws(() => RoomCatalog.open(dataDir), CatalogNotInitializedError);
      assert.equal(existsSync(join(dataDir, 'catalog.sqlite')), false);
    });

    await t.test('2. Initialization creates a 32-byte secret with owner-only permissions', () => {
      const catalog = RoomCatalog.initialize(dataDir);
      try {
        assert.equal(catalog.secret.length, 32);
        assert.equal(statSync(join(dataDir, 'server-secret')).mode & 0o777, 0o600);
        assert.equal(statSync(join(dataDir, 'catalog.sqlite')).mode & 0o777, 0o600);
      } finally {
        catalog.close();
      }
    });

    await t.test('3. Re-initialization keeps the existing secret and catalog', () => {
      const firstSecret = readFileSync(join(dataDir, 'server-secret'), 'utf8').trim();
      const catalog = RoomCatalog.initialize(dataDir);
      const room = catalog.createRoom({
        id: 'room-a',
        name: 'PbtA room',
        systemId: 'pbta-2d6',
        systemVersion: '1.0.0',
        code: 'ABCD2345',
        passwordHash: hashRoomPassword('correct horse battery staple'),
      });
      catalog.close();

      const second = RoomCatalog.initialize(dataDir);
      try {
        assert.equal(readFileSync(join(dataDir, 'server-secret'), 'utf8').trim(), firstSecret);
        assert.equal(second.getRoom('room-a')?.name, room.name);
        assert.equal(second.listRooms().length, 1);
      } finally {
        second.close();
      }
    });

    await t.test('4. An existing catalog without its secret fails instead of rotating codes', () => {
      unlinkSync(join(dataDir, 'server-secret'));
      assert.throws(() => RoomCatalog.open(dataDir), CatalogSecretMissingError);
      assert.equal(existsSync(join(dataDir, 'server-secret')), false);
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('catalog: codes are stored as HMAC only and match legacy normalization', async () => {
  const dataDir = tempDir();
  try {
    const catalog = RoomCatalog.initialize(dataDir);
    try {
      const room = createSampleRoom(catalog, 'room-a', 'abcd2345');
      const stored = catalog.db.prepare('SELECT room_code_hmac, gm_password_hash FROM rooms WHERE id = ?').get('room-a') as {
        room_code_hmac: string;
        gm_password_hash: string;
      };
      assert.equal(stored.room_code_hmac, hmacRoomCode(catalog.secret, 'ABCD2345'));
      assert.equal(stored.room_code_hmac.includes('ABCD2345'), false);
      assert.match(stored.gm_password_hash, /^scrypt\$/);
      assert.equal(stored.gm_password_hash.includes('correct horse battery staple'), false);

      assert.equal(catalog.findRoomByCode(' abcd2345 ')?.id, room.id);
      assert.equal(catalog.findRoomByCode('WRONG999'), undefined);

      const legacy = catalog.createRoom({
        id: 'legacy',
        name: 'Legacy',
        systemId: 'pbta-2d6',
        systemVersion: '1.0.0',
        code: 'Legacy-Code-Keeps-Case',
        passwordHash: hashRoomPassword('legacy password value'),
      });
      assert.equal(catalog.findRoomByCode('Legacy-Code-Keeps-Case')?.id, legacy.id);
      assert.equal(catalog.findRoomByCode('legacy-code-keeps-case'), undefined);
    } finally {
      catalog.close();
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('catalog: password hashing, code uniqueness and room statuses', async (t) => {
  const dataDir = tempDir();
  try {
    const catalog = RoomCatalog.initialize(dataDir);
    try {
      await t.test('1. scrypt verifies only the right password', () => {
        const hash = hashRoomPassword('a sufficiently long password', { N: 1024, r: 8, p: 1 });
        assert.equal(verifyRoomPassword(hash, 'a sufficiently long password'), true);
        assert.equal(verifyRoomPassword(hash, 'a sufficiently long passwor'), false);
        assert.equal(verifyRoomPassword('garbage', 'a sufficiently long password'), false);
        assert.throws(() => hashRoomPassword('short'), /не менее 10/);
      });

      await t.test('2. The same room code cannot be registered twice', () => {
        createSampleRoom(catalog, 'room-a', 'ABCD2345');
        assert.throws(() => createSampleRoom(catalog, 'room-b', 'abcd2345'), RoomConflictError);
        assert.throws(() => createSampleRoom(catalog, 'room-a', 'ZZZZ2345'), RoomConflictError);
      });

      await t.test('3. Status changes are visible through fresh catalog reads', () => {
        assert.equal(catalog.getRoom('room-a')?.status, 'active');
        assert.equal(catalog.setStatus('room-a', 'disabled').status, 'disabled');
        assert.equal(catalog.getRoom('room-a')?.status, 'disabled');
        assert.equal(catalog.setStatus('room-a', 'archived').status, 'archived');
        assert.equal(catalog.setStatus('room-a', 'active').status, 'active');
        assert.throws(() => catalog.setStatus('missing', 'disabled'), /не найдена/);
      });

      await t.test('4. New codes use the safe alphabet and room ids reject traversal', () => {
        for (let index = 0; index < 20; index += 1) assert.match(generateRoomCode(), /^[A-HJ-NP-Z2-9]{8}$/);
        assert.equal(normalizeRoomCode('  pr2f4k9m  '), 'PR2F4K9M');
        assert.throws(() => assertValidRoomId('../escape'));
        assert.throws(() => assertValidRoomId('Room A'));
        assert.equal(catalog.getRoom('../escape'), undefined);
        assertValidRoomId('room-a');
      });

      await t.test('5. A damaged secret is rejected', () => {
        catalog.close();
        writeFileSync(join(dataDir, 'server-secret'), `${Buffer.from('short').toString('base64url')}\n`, { mode: 0o600 });
        assert.throws(() => RoomCatalog.open(dataDir), /слишком короткий секрет/);
      });
    } finally {
      if (catalog.db.open) catalog.close();
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
