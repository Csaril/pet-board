import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { findLatestSystemMetadata, findSystemMetadata } from '../src/modules/manifest.js';
import { clientLoaderKeys } from '../src/modules/client-registry.js';
import {
  isCurrentNechronicaSheetData,
  migrateNechronicaSheetData,
  NECHRONICA_SHEET_SCHEMA_VERSION,
  NechronicaSheetSchemaError,
  parseNechronicaSheetData,
  type NechronicaSheetData,
} from '../src/modules/system/nechronica/schema.js';
import type { SheetCharacteristicKey } from '../src/shared/board.js';
import { BoardCommandError, SYSTEM_MISMATCH } from './board.js';
import { listBackups } from './backup-lib.js';
import { executeSheetCommand } from './sheets.js';
import { generateRoomCode, hashRoomPassword, RoomCatalog, type RoomStatus } from './catalog.js';
import { acquireServerLock, assertServerStopped, serverLockPath } from './instance-lock.js';
import { adminRoomDirectory } from './room-admin.js';
import { RoomStore, type Identity } from './store.js';
import { migrateSystem, planSystemMigration } from './system-migrate.js';
import { loadSystemServer } from './system-registry.js';

const gm: Identity = { participantId: 'gm-1', name: 'Keeper', role: 'gm' };
const player: Identity = { participantId: 'player-1', name: 'Ari', role: 'player' };
const PASSWORD = 'password-12345';

function tempDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `tabletop-nechronica-migration-${label}-`));
}

function ensureCatalog(dataDir: string): void {
  RoomCatalog.initialize(dataDir).close();
}

function hashFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

interface SheetFixture {
  id: string;
  name: string;
  schemaVersion: number;
  systemData?: unknown;
  portraitAssetId?: string | null;
  assignedPlayerId?: string | null;
  assignedPlayerName?: string | null;
  characteristics?: Record<string, number>;
}

interface RoomFixture {
  id: string;
  name: string;
  systemId: string;
  systemVersion: string;
  status?: RoomStatus;
  assetId?: string;
  sheets?: SheetFixture[];
}

/** Builds the exact on-disk shape a legacy room has: fixed pair + catalog row. */
function createRoomFixture(dataDir: string, fixture: RoomFixture): string {
  ensureCatalog(dataDir);
  const directory = adminRoomDirectory(dataDir, fixture.id);
  mkdirSync(join(directory, 'assets'), { recursive: true, mode: 0o700 });
  const store = new RoomStore(directory, fixture.name);
  try {
    store.initializeSystem(fixture.systemId, fixture.systemVersion);
    if (fixture.assetId) {
      store.createAsset({
        id: fixture.assetId, sha256: `sha-${fixture.assetId}`, mimeType: 'image/png',
        originalName: `${fixture.assetId}.png`, size: 4, width: 10, height: 10,
      });
      writeFileSync(join(directory, 'assets', fixture.assetId), 'png!', { mode: 0o600 });
    }
    for (const sheet of fixture.sheets ?? []) {
      store.createSheet({
        id: sheet.id,
        creatorId: gm.participantId,
        creatorName: gm.name,
        assignedPlayerId: sheet.assignedPlayerId ?? null,
        assignedPlayerName: sheet.assignedPlayerName ?? null,
        systemId: fixture.systemId,
        systemVersion: fixture.systemVersion,
        schemaVersion: sheet.schemaVersion,
        characterName: sheet.name,
        portraitAssetId: sheet.portraitAssetId ?? null,
        characteristics: (sheet.characteristics ?? {}) as Record<SheetCharacteristicKey, number>,
        fate: 0,
        systemData: sheet.systemData,
      });
    }
  } finally {
    store.close();
  }
  const catalog = RoomCatalog.open(dataDir);
  try {
    let code = generateRoomCode();
    while (catalog.codeExists(code)) code = generateRoomCode();
    catalog.createRoom({
      id: fixture.id,
      name: fixture.name,
      systemId: fixture.systemId,
      systemVersion: fixture.systemVersion,
      code,
      passwordHash: hashRoomPassword(PASSWORD),
      ...(fixture.status ? { status: fixture.status } : {}),
    });
  } finally {
    catalog.close();
  }
  return directory;
}

function catalogRoom(dataDir: string, roomId: string) {
  const catalog = RoomCatalog.open(dataDir);
  try { return catalog.getRoom(roomId); } finally { catalog.close(); }
}

interface RawSheet {
  id: string;
  system_id: string;
  system_version: string;
  schema_version: number;
  character_name: string;
  assigned_player_id: string | null;
  assigned_player_name: string | null;
  portrait_asset_id: string | null;
  characteristics_json: string;
  fate: number;
  system_data_json: string | null;
}

function readRawSheet(directory: string, sheetId: string): RawSheet {
  const db = new Database(join(directory, 'room.sqlite'), { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare('SELECT * FROM character_sheets WHERE id = ?').get(sheetId) as RawSheet | undefined;
    assert.ok(row, `sheet ${sheetId} must exist`);
    return row;
  } finally {
    db.close();
  }
}

function readRoomVersion(directory: string): string {
  const db = new Database(join(directory, 'room.sqlite'), { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare('SELECT system_id, system_version FROM room WHERE id = 1').get() as
      { system_id: string; system_version: string };
    return `${row.system_id}@${row.system_version}`;
  } finally {
    db.close();
  }
}

function defaultSheetData(): NechronicaSheetData {
  return migrateNechronicaSheetData(null);
}

/* ---------- 10 sheet migration scenarios ---------- */

test('1. a new 1.2.0 sheet starts on schema 3 with every section and empty collections', async () => {
  const module = await loadSystemServer('nechronica', '1.2.0');
  const data = parseNechronicaSheetData(module.sheetDefaults().systemData);
  assert.equal(data.schemaVersion, NECHRONICA_SHEET_SCHEMA_VERSION);
  assert.deepEqual(data.profile, { maxAp: 0, currentAp: 0, deployment: null, approval: 0 });
  assert.deepEqual(data.abilities, []);
  assert.deepEqual(data.fetters, []);
  assert.deepEqual(data.memories, []);
  assert.deepEqual(Object.keys(data.bodyParts).sort(), ['arms', 'head', 'legs', 'torso']);
  assert.ok(Object.values(data.bodyParts).every((parts) => parts.length === 0));
  assert.deepEqual(data.info, {
    position: '', mainClass: '', secondaryClass: '', premonition: '',
    armaments: 0, mutations: 0, enhancements: 0, notes: '',
  });
  assert.equal(isCurrentNechronicaSheetData(data), true, 'empty collections are valid, not damaged');

  const frozen = await loadSystemServer('nechronica', '1.1.0');
  const frozenRaw = frozen.sheetDefaults().systemData as { schemaVersion?: number };
  assert.equal(frozenRaw.schemaVersion, 2, 'the frozen 1.1.0 module keeps schema 2');
  assert.equal(isCurrentNechronicaSheetData(frozenRaw), false, 'schema 2 is no longer current for 1.2.0');
  assert.equal(parseNechronicaSheetData(frozenRaw).schemaVersion, 3, '1.1.0 data migrates on read');
});

test('2. null and undefined payloads migrate to a complete schema 3 object', () => {
  for (const value of [null, undefined]) {
    const data = migrateNechronicaSheetData(value);
    assert.equal(data.schemaVersion, 3);
    assert.deepEqual(data, defaultSheetData());
  }
});

test('3. an empty or whitespace JSON string migrates instead of being rejected', () => {
  for (const value of ['', '   ', '""', '  ""  ', 'null']) {
    const data = migrateNechronicaSheetData(value);
    assert.equal(data.schemaVersion, 3);
    assert.deepEqual(data, defaultSheetData());
  }
});

test('4. partial data keeps known values and fills only the missing sections', () => {
  const data = migrateNechronicaSheetData({
    schemaVersion: 3,
    profile: { maxAp: 12, currentAp: 7, deployment: 'elysium', approval: 3 },
    abilities: [{ id: 'a-1', name: 'Blade', cost: '2', used: true }],
  });
  assert.equal(data.profile.maxAp, 12);
  assert.equal(data.profile.currentAp, 7);
  assert.equal(data.profile.deployment, 'elysium');
  assert.equal(data.profile.approval, 3);
  assert.equal(data.abilities[0]!.id, 'a-1');
  assert.equal(data.abilities[0]!.name, 'Blade');
  assert.equal(data.abilities[0]!.used, true);
  assert.deepEqual(data.fetters, []);
  assert.deepEqual(data.memories, []);
  assert.ok(Object.values(data.bodyParts).every((parts) => parts.length === 0));
  assert.equal(data.info.position, '');
});

test('5. legacy schemaVersion 1 is upgraded additively and keeps every known value', () => {
  const data = migrateNechronicaSheetData({
    schemaVersion: 1,
    profile: { maxAp: 9, currentAp: 4, deployment: 'limbo', approval: 1 },
    abilities: [{ id: 'old-ability', name: 'Claw', effect: 'slash' }],
    bodyParts: { head: [{ id: 'old-head', name: 'Head', destroyed: true }] },
    fetters: [{ id: 'old-fetter', target: 'Mika', madness: 'fear' }],
    info: { position: 'scout', notes: 'kept' },
    memories: [{ id: 'old-memory', name: 'Rain', number: 2, content: 'text' }],
  });
  assert.equal(data.schemaVersion, 3);
  assert.equal(data.profile.maxAp, 9);
  assert.equal(data.abilities[0]!.name, 'Claw');
  assert.equal(data.bodyParts.head[0]!.destroyed, true);
  assert.equal(data.bodyParts.arms.length, 0);
  assert.equal(data.fetters[0]!.target, 'Mika');
  assert.deepEqual(data.fetters[0]!.spentMadness, [false, false, false, false]);
  assert.equal(data.info.notes, 'kept');
  assert.equal(data.memories[0]!.number, 2);
  assert.equal(data.memories[0]!.imageAssetId, null, 'old memories get an empty optional image');
});

test('6. unknown fields survive at the sheet, profile, info and item levels', () => {
  const data = migrateNechronicaSheetData({
    schemaVersion: 1,
    futureSection: { keep: true },
    profile: { maxAp: 3, futureProfile: 'x' },
    abilities: [{ id: 'a-1', name: 'A', futureAbility: 42 }],
    bodyParts: { head: [{ id: 'h-1', name: 'H', futurePart: ['y'] }] },
    fetters: [{ id: 'f-1', target: 'T', futureFetter: null }],
    info: { notes: 'n', futureInfo: 7 },
    memories: [{ id: 'm-1', name: 'M', futureMemory: false }],
  });
  const record = data as unknown as Record<string, unknown>;
  assert.deepEqual(record.futureSection, { keep: true });
  assert.equal(data.profile.futureProfile, 'x');
  assert.equal(data.abilities[0]!.futureAbility, 42);
  assert.deepEqual(data.bodyParts.head[0]!.futurePart, ['y']);
  assert.equal(data.fetters[0]!.futureFetter, null);
  assert.equal(data.info.futureInfo, 7);
  assert.equal(data.memories[0]!.futureMemory, false);
});

test('7. migration is idempotent and does not rewrite an already current payload', () => {
  const once = migrateNechronicaSheetData({
    schemaVersion: 1,
    profile: { maxAp: 5, currentAp: 2 },
    abilities: [{ id: 'a-1', name: 'A' }],
  });
  const twice = migrateNechronicaSheetData(once);
  assert.deepEqual(twice, once);
  assert.equal(isCurrentNechronicaSheetData(once), true);
  assert.deepEqual(migrateNechronicaSheetData(once), once);
});

test('8. a future schema throws with expected/actual versions and is never downgraded', () => {
  assert.throws(
    () => migrateNechronicaSheetData({ schemaVersion: 4, profile: { maxAp: 1 } }),
    (error: unknown) => {
      assert.ok(error instanceof NechronicaSheetSchemaError);
      assert.equal(error.expectedVersion, 3);
      assert.equal(error.actualVersion, 4);
      assert.equal(error.code, 'SHEET_SCHEMA_UNSUPPORTED');
      assert.match(error.message, /ожидается версия 3/);
      assert.match(error.message, /версия 4/);
      return true;
    },
  );
});

test('9. corrupt JSON and non-object payloads throw instead of becoming defaults', () => {
  for (const value of ['{not json', '[1,2,3]', '42', 'true']) {
    assert.throws(() => migrateNechronicaSheetData(value), NechronicaSheetSchemaError);
  }
  assert.throws(() => migrateNechronicaSheetData(42), NechronicaSheetSchemaError);
  assert.throws(() => migrateNechronicaSheetData(['x']), NechronicaSheetSchemaError);
});

test('10. the server hook migrates a 1.0.0 room and leaves a current 1.2.0 sheet byte-identical', async () => {
  const dataDir = tempDir('hook');
  try {
    const legacyId = '11111111-1111-4111-8111-111111111111';
    const legacyDir = createRoomFixture(dataDir, {
      id: legacyId, name: 'Legacy', systemId: 'nechronica', systemVersion: '1.0.0', assetId: 'art-legacy',
      sheets: [{
        id: 'sheet-legacy', name: 'Csarag', schemaVersion: 1,
        portraitAssetId: 'art-legacy', assignedPlayerId: player.participantId, assignedPlayerName: player.name,
      }],
    });
    const legacyStore = new RoomStore(legacyDir, 'Legacy');
    try {
      const module = await loadSystemServer('nechronica', '1.2.0');
      assert.ok(module.migrateRoomSheets);
      const report = module.migrateRoomSheets({
        store: legacyStore,
        target: { id: 'nechronica', version: '1.2.0', schemaVersion: 3 },
      });
      assert.deepEqual(report.migratedSheetIds, ['sheet-legacy']);
      assert.equal(readRoomVersion(legacyDir), 'nechronica@1.2.0');
      const row = readRawSheet(legacyDir, 'sheet-legacy');
      assert.equal(row.system_version, '1.2.0');
      assert.equal(row.schema_version, 3);
      assert.equal(row.id, 'sheet-legacy');
      assert.equal(row.character_name, 'Csarag');
      assert.equal(row.assigned_player_id, player.participantId);
      assert.equal(row.assigned_player_name, player.name);
      assert.equal(row.portrait_asset_id, 'art-legacy');
      const data = parseNechronicaSheetData(JSON.parse(row.system_data_json!));
      assert.equal(data.schemaVersion, 3);
      assert.equal(isCurrentNechronicaSheetData(data), true);
      assert.throws(() => legacyStore.db.prepare('UPDATE room SET system_version = ? WHERE id = 1').run('1.0.0'), /ROOM_SYSTEM_IMMUTABLE/);
    } finally {
      legacyStore.close();
    }

    const currentId = '22222222-2222-4222-8222-222222222222';
    const currentDir = createRoomFixture(dataDir, {
      id: currentId, name: 'Current', systemId: 'nechronica', systemVersion: '1.2.0',
      sheets: [{ id: 'sheet-current', name: 'Ready', schemaVersion: 3, systemData: defaultSheetData() }],
    });
    const before = readRawSheet(currentDir, 'sheet-current').system_data_json;
    const currentStore = new RoomStore(currentDir, 'Current');
    try {
      const module = await loadSystemServer('nechronica', '1.2.0');
      const report = module.migrateRoomSheets!({
        store: currentStore,
        target: { id: 'nechronica', version: '1.2.0', schemaVersion: 3 },
      });
      assert.deepEqual(report.migratedSheetIds, []);
      assert.deepEqual(report.unchangedSheetIds, ['sheet-current']);
      assert.equal(readRawSheet(currentDir, 'sheet-current').system_data_json, before);
      const second = module.migrateRoomSheets!({
        store: currentStore,
        target: { id: 'nechronica', version: '1.2.0', schemaVersion: 3 },
      });
      assert.deepEqual(second.migratedSheetIds, []);
    } finally {
      currentStore.close();
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

/* ---------- 16 bulk migration scenarios ---------- */

test('11. the plan lists every room of the system regardless of status and excludes other systems', async () => {
  const dataDir = tempDir('plan');
  try {
    createRoomFixture(dataDir, {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Active', systemId: 'nechronica',
      systemVersion: '1.0.0', status: 'active', sheets: [{ id: 's-active', name: 'A', schemaVersion: 1 }],
    });
    createRoomFixture(dataDir, {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Disabled', systemId: 'nechronica',
      systemVersion: '1.0.0', status: 'disabled', sheets: [{ id: 's-disabled', name: 'B', schemaVersion: 1 }],
    });
    createRoomFixture(dataDir, {
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', name: 'Archived', systemId: 'nechronica',
      systemVersion: '1.0.0', status: 'archived',
    });
    createRoomFixture(dataDir, {
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', name: 'PbtA', systemId: 'pbta-2d6',
      systemVersion: '1.0.0', sheets: [{ id: 's-pbta', name: 'Hero', schemaVersion: 1, characteristics: { might: 2 } }],
    });

    const plan = await planSystemMigration(dataDir, 'nechronica');
    assert.equal(plan.targetVersion, '1.2.0');
    assert.equal(plan.targetSchemaVersion, 3);
    assert.equal(plan.rooms.length, 3);
    assert.deepEqual(plan.rooms.map((room) => room.status).sort(), ['active', 'archived', 'disabled']);
    assert.deepEqual(plan.otherSystemRoomIds, ['dddddddd-dddd-4ddd-8ddd-dddddddddddd']);
    assert.deepEqual(plan.skippedRoomIds, []);
    assert.equal(plan.blockers.length, 0);
    assert.equal(plan.canApply, true);
    assert.equal(plan.rooms.find((room) => room.id === 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')?.sheetsToMigrate, 1);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('12. dry-run reports the plan and changes no file, database, catalog or backup', async () => {
  const dataDir = tempDir('dry-run');
  try {
    const directory = createRoomFixture(dataDir, {
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', name: 'Dry', systemId: 'nechronica',
      systemVersion: '1.0.0', sheets: [{ id: 's-dry', name: 'D', schemaVersion: 1 }],
    });
    const catalogBefore = hashFile(join(dataDir, 'catalog.sqlite'));
    const roomBefore = hashFile(join(directory, 'room.sqlite'));
    const result = await migrateSystem({
      dataDir, systemId: 'nechronica', dryRun: true, skipServerCheck: true,
    });
    assert.equal(result.applied, false);
    assert.equal(result.reason, 'dry-run');
    assert.equal(result.roomBackups.length, 0);
    assert.equal(hashFile(join(dataDir, 'catalog.sqlite')), catalogBefore);
    assert.equal(hashFile(join(directory, 'room.sqlite')), roomBefore);
    assert.equal(existsSync(join(dataDir, 'catalog-backups')), false);
    assert.equal(existsSync(join(dataDir, 'backups', 'system-migrations')), false);
    assert.equal(existsSync(join(directory, 'backups')), false);
    assert.equal(readRoomVersion(directory), 'nechronica@1.0.0');
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('13. refusing confirmation leaves every room and the catalog untouched', async () => {
  const dataDir = tempDir('decline');
  try {
    const directory = createRoomFixture(dataDir, {
      id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', name: 'Decline', systemId: 'nechronica',
      systemVersion: '1.0.0', sheets: [{ id: 's-decline', name: 'D', schemaVersion: 1 }],
    });
    const catalogBefore = hashFile(join(dataDir, 'catalog.sqlite'));
    const roomBefore = hashFile(join(directory, 'room.sqlite'));
    const result = await migrateSystem({
      dataDir, systemId: 'nechronica', skipServerCheck: true, confirm: () => false,
    });
    assert.equal(result.applied, false);
    assert.equal(result.reason, 'declined');
    assert.equal(hashFile(join(dataDir, 'catalog.sqlite')), catalogBefore);
    assert.equal(hashFile(join(directory, 'room.sqlite')), roomBefore);
    assert.equal(existsSync(join(dataDir, 'catalog-backups')), false);
    assert.equal(existsSync(join(directory, 'backups')), false);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('14. applying migrates all statuses, preserves sheet identity and writes exact versions', async () => {
  const dataDir = tempDir('apply');
  try {
    const activeId = '10101010-1010-4010-8010-101010101010';
    const disabledId = '20202020-2020-4020-8020-202020202020';
    const archivedId = '30303030-3030-4030-8030-303030303030';
    const activeDir = createRoomFixture(dataDir, {
      id: activeId, name: 'Active', systemId: 'nechronica', systemVersion: '1.0.0', status: 'active', assetId: 'art-a',
      sheets: [{
        id: 's-a', name: 'Csarag', schemaVersion: 1, portraitAssetId: 'art-a',
        assignedPlayerId: player.participantId, assignedPlayerName: player.name,
        systemData: { schemaVersion: 1, profile: { maxAp: 10, currentAp: 3 }, abilities: [{ id: 'ab', name: 'Blade' }] },
      }],
    });
    const disabledDir = createRoomFixture(dataDir, {
      id: disabledId, name: 'Disabled', systemId: 'nechronica', systemVersion: '1.0.0', status: 'disabled',
      sheets: [{ id: 's-b', name: 'B', schemaVersion: 1 }],
    });
    const archivedDir = createRoomFixture(dataDir, {
      id: archivedId, name: 'Archived', systemId: 'nechronica', systemVersion: '1.0.0', status: 'archived',
    });

    const result = await migrateSystem({
      dataDir, systemId: 'nechronica', yes: true, skipServerCheck: true, logger: () => undefined,
    });
    assert.equal(result.applied, true);
    assert.equal(result.roomBackups.length, 3);

    for (const [id, directory] of [[activeId, activeDir], [disabledId, disabledDir], [archivedId, archivedDir]] as const) {
      assert.equal(readRoomVersion(directory), 'nechronica@1.2.0');
      assert.equal(catalogRoom(dataDir, id)?.systemId, 'nechronica');
      assert.equal(catalogRoom(dataDir, id)?.systemVersion, '1.2.0');
    }
    assert.equal(catalogRoom(dataDir, activeId)?.status, 'active');
    assert.equal(catalogRoom(dataDir, disabledId)?.status, 'disabled');
    assert.equal(catalogRoom(dataDir, archivedId)?.status, 'archived');

    const row = readRawSheet(activeDir, 's-a');
    assert.equal(row.system_version, '1.2.0');
    assert.equal(row.schema_version, 3);
    assert.equal(row.character_name, 'Csarag');
    assert.equal(row.assigned_player_id, player.participantId);
    assert.equal(row.assigned_player_name, player.name);
    assert.equal(row.portrait_asset_id, 'art-a');
    const data = parseNechronicaSheetData(JSON.parse(row.system_data_json!));
    assert.equal(data.profile.maxAp, 10);
    assert.equal(data.profile.currentAp, 3);
    assert.equal(data.abilities[0]!.name, 'Blade');
    assert.equal(isCurrentNechronicaSheetData(data), true);
    assert.equal(readRawSheet(disabledDir, 's-b').schema_version, 3);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('15. PbtA rooms keep their pair, sheet and characteristics untouched', async () => {
  const dataDir = tempDir('pbta');
  try {
    const pbtaId = '40404040-4040-4040-8040-404040404040';
    const pbtaDir = createRoomFixture(dataDir, {
      id: pbtaId, name: 'PbtA', systemId: 'pbta-2d6', systemVersion: '1.0.0',
      sheets: [{ id: 's-hero', name: 'Hero', schemaVersion: 1, characteristics: { might: 2, insight: 1 } }],
    });
    const before = readRawSheet(pbtaDir, 's-hero');
    createRoomFixture(dataDir, {
      id: '50505050-5050-4050-8050-505050505050', name: 'Nechronica', systemId: 'nechronica',
      systemVersion: '1.0.0', sheets: [{ id: 's-doll', name: 'Doll', schemaVersion: 1 }],
    });

    const plan = await planSystemMigration(dataDir, 'nechronica');
    assert.deepEqual(plan.otherSystemRoomIds, [pbtaId]);
    const result = await migrateSystem({ dataDir, systemId: 'nechronica', yes: true, skipServerCheck: true });
    assert.equal(result.applied, true);
    assert.equal(readRoomVersion(pbtaDir), 'pbta-2d6@1.0.0');
    assert.equal(catalogRoom(dataDir, pbtaId)?.systemVersion, '1.0.0');
    const after = readRawSheet(pbtaDir, 's-hero');
    assert.deepEqual(after, before);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('16. a room already on the latest version and schema is reported as up to date', async () => {
  const dataDir = tempDir('latest');
  try {
    const directory = createRoomFixture(dataDir, {
      id: '60606060-6060-4060-8060-606060606060', name: 'Latest', systemId: 'nechronica',
      systemVersion: '1.2.0', sheets: [{ id: 's-latest', name: 'Ready', schemaVersion: 3, systemData: defaultSheetData() }],
    });
    const before = hashFile(join(directory, 'room.sqlite'));
    const result = await migrateSystem({ dataDir, systemId: 'nechronica', yes: true, skipServerCheck: true });
    assert.equal(result.applied, false);
    assert.equal(result.reason, 'up-to-date');
    assert.equal(result.roomBackups.length, 0);
    assert.equal(hashFile(join(directory, 'room.sqlite')), before);
    assert.equal(existsSync(join(dataDir, 'catalog-backups')), false);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('17. a second run is idempotent and creates no additional changes', async () => {
  const dataDir = tempDir('idempotent');
  try {
    const directory = createRoomFixture(dataDir, {
      id: '70707070-7070-4070-8070-707070707070', name: 'Repeat', systemId: 'nechronica',
      systemVersion: '1.0.0', sheets: [{ id: 's-repeat', name: 'R', schemaVersion: 1 }],
    });
    const first = await migrateSystem({ dataDir, systemId: 'nechronica', yes: true, skipServerCheck: true });
    assert.equal(first.applied, true);
    const afterFirst = hashFile(join(directory, 'room.sqlite'));
    const second = await migrateSystem({ dataDir, systemId: 'nechronica', yes: true, skipServerCheck: true });
    assert.equal(second.applied, false);
    assert.equal(second.reason, 'up-to-date');
    assert.equal(hashFile(join(directory, 'room.sqlite')), afterFirst);
    assert.equal(readRawSheet(directory, 's-repeat').schema_version, 3);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('18. downgrading to an older version is refused without touching data', async () => {
  const dataDir = tempDir('downgrade');
  try {
    const directory = createRoomFixture(dataDir, {
      id: '80808080-8080-4080-8080-808080808080', name: 'Downgrade', systemId: 'nechronica',
      systemVersion: '1.2.0', sheets: [{ id: 's-down', name: 'D', schemaVersion: 3, systemData: defaultSheetData() }],
    });
    const before = hashFile(join(directory, 'room.sqlite'));
    await assert.rejects(
      () => migrateSystem({ dataDir, systemId: 'nechronica', targetVersion: '1.0.0', yes: true, skipServerCheck: true }),
      /Понижение версии запрещено/,
    );
    assert.equal(readRoomVersion(directory), 'nechronica@1.2.0');
    assert.equal(hashFile(join(directory, 'room.sqlite')), before);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('19. an unknown target version is rejected before any change', async () => {
  const dataDir = tempDir('unknown-version');
  try {
    createRoomFixture(dataDir, {
      id: '90909090-9090-4090-8090-909090909090', name: 'Unknown', systemId: 'nechronica', systemVersion: '1.0.0',
    });
    await assert.rejects(
      () => planSystemMigration(dataDir, 'nechronica', '9.9.9'),
      /не зарегистрирована/,
    );
    await assert.rejects(
      () => migrateSystem({ dataDir, systemId: 'nechronica', targetVersion: '9.9.9', yes: true, skipServerCheck: true }),
      /не зарегистрирована/,
    );
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('20. a catalog/database version mismatch blocks the whole operation', async () => {
  const dataDir = tempDir('mismatch');
  try {
    const directory = createRoomFixture(dataDir, {
      id: 'a0a0a0a0-a0a0-40a0-80a0-a0a0a0a0a0a0', name: 'Mismatch', systemId: 'nechronica', systemVersion: '1.0.0',
    });
    const catalog = RoomCatalog.open(dataDir);
    try {
      catalog.updateRoomSystems([{ roomId: 'a0a0a0a0-a0a0-40a0-80a0-a0a0a0a0a0a0', systemId: 'nechronica', systemVersion: '1.2.0' }]);
    } finally { catalog.close(); }
    const before = hashFile(join(directory, 'room.sqlite'));
    await assert.rejects(
      () => migrateSystem({ dataDir, systemId: 'nechronica', yes: true, skipServerCheck: true }),
      /не совпадает с каталогом/,
    );
    assert.equal(hashFile(join(directory, 'room.sqlite')), before);
    assert.equal(readRoomVersion(directory), 'nechronica@1.0.0');
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('21. a catalog entry without a room directory is a blocker', async () => {
  const dataDir = tempDir('missing');
  try {
    ensureCatalog(dataDir);
    const catalog = RoomCatalog.open(dataDir);
    try {
      catalog.createRoom({
        id: 'b0b0b0b0-b0b0-40b0-80b0-b0b0b0b0b0b0', name: 'Missing', systemId: 'nechronica', systemVersion: '1.0.0',
        code: 'ABCDEFGH', passwordHash: hashRoomPassword(PASSWORD),
      });
    } finally { catalog.close(); }
    await assert.rejects(
      () => migrateSystem({ dataDir, systemId: 'nechronica', yes: true, skipServerCheck: true }),
      /Каталог комнаты отсутствует/,
    );
    assert.equal(catalogRoom(dataDir, 'b0b0b0b0-b0b0-40b0-80b0-b0b0b0b0b0b0')?.systemVersion, '1.0.0');
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('22. a live server lock blocks migration and a stale lock is removed', async () => {
  const dataDir = tempDir('lock');
  try {
    const directory = createRoomFixture(dataDir, {
      id: 'c0c0c0c0-c0c0-40c0-80c0-c0c0c0c0c0c0', name: 'Locked', systemId: 'nechronica', systemVersion: '1.0.0',
    });
    // pid 1 always exists; signaling it yields EPERM, which still means alive.
    writeFileSync(serverLockPath(dataDir), '1\n', { mode: 0o600 });
    await assert.rejects(
      () => migrateSystem({ dataDir, systemId: 'nechronica', yes: true }),
      /Сервер уже запущен/,
    );
    assert.equal(readRoomVersion(directory), 'nechronica@1.0.0');

    writeFileSync(serverLockPath(dataDir), '999999\n', { mode: 0o600 });
    assertServerStopped(dataDir);
    assert.equal(existsSync(serverLockPath(dataDir)), false);
    const result = await migrateSystem({ dataDir, systemId: 'nechronica', yes: true });
    assert.equal(result.applied, true);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('23. a staging failure leaves live databases and the catalog unchanged and keeps backups', async () => {
  const dataDir = tempDir('stage-fail');
  try {
    const firstId = 'd0d0d0d0-d0d0-40d0-80d0-d0d0d0d0d0d0';
    const secondId = 'e0e0e0e0-e0e0-40e0-80e0-e0e0e0e0e0e0';
    const firstDir = createRoomFixture(dataDir, {
      id: firstId, name: 'First', systemId: 'nechronica', systemVersion: '1.0.0',
      sheets: [{ id: 's-first', name: 'F', schemaVersion: 1 }],
    });
    const secondDir = createRoomFixture(dataDir, {
      id: secondId, name: 'Second', systemId: 'nechronica', systemVersion: '1.0.0',
      sheets: [{ id: 's-second', name: 'S', schemaVersion: 1 }],
    });
    const firstBefore = hashFile(join(firstDir, 'room.sqlite'));
    const secondBefore = hashFile(join(secondDir, 'room.sqlite'));
    const catalogBefore = hashFile(join(dataDir, 'catalog.sqlite'));
    await assert.rejects(
      () => migrateSystem({
        dataDir, systemId: 'nechronica', yes: true, skipServerCheck: true,
        failAfterStagingRoomId: secondId, logger: () => undefined,
      }),
      /не применена/,
    );
    assert.equal(hashFile(join(firstDir, 'room.sqlite')), firstBefore);
    assert.equal(hashFile(join(secondDir, 'room.sqlite')), secondBefore);
    assert.equal(hashFile(join(dataDir, 'catalog.sqlite')), catalogBefore);
    assert.equal(readRoomVersion(firstDir), 'nechronica@1.0.0');
    assert.equal(readRoomVersion(secondDir), 'nechronica@1.0.0');
    assert.equal(catalogRoom(dataDir, firstId)?.systemVersion, '1.0.0');
    const backups = await listBackups(firstDir);
    assert.equal(backups.length, 1);
    assert.match(backups[0]!.name, /^pre-system-migration-/);
    assert.equal(existsSync(backups[0]!.path), true);
    const journal = JSON.parse(readFileSync(join(dataDir, 'backups', 'system-migrations', readdirSync(join(dataDir, 'backups', 'system-migrations'))[0]!, 'journal.json'), 'utf8')) as { status: string };
    assert.equal(journal.status, 'failed-before-apply');
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('24. a failure after replacement rolls back every file and the catalog', async () => {
  const dataDir = tempDir('apply-fail');
  try {
    const firstId = 'f0f0f0f0-f0f0-40f0-80f0-f0f0f0f0f0f0';
    const secondId = '12121212-1212-4212-8212-121212121212';
    const firstDir = createRoomFixture(dataDir, {
      id: firstId, name: 'First', systemId: 'nechronica', systemVersion: '1.0.0',
      sheets: [{ id: 's-first', name: 'F', schemaVersion: 1 }],
    });
    const secondDir = createRoomFixture(dataDir, {
      id: secondId, name: 'Second', systemId: 'nechronica', systemVersion: '1.0.0',
      sheets: [{ id: 's-second', name: 'S', schemaVersion: 1 }],
    });
    const firstBefore = hashFile(join(firstDir, 'room.sqlite'));
    const secondBefore = hashFile(join(secondDir, 'room.sqlite'));
    await assert.rejects(
      () => migrateSystem({
        dataDir, systemId: 'nechronica', yes: true, skipServerCheck: true, failAfterApply: true,
      }),
      /исходные базы восстановлены/,
    );
    assert.equal(hashFile(join(firstDir, 'room.sqlite')), firstBefore);
    assert.equal(hashFile(join(secondDir, 'room.sqlite')), secondBefore);
    assert.equal(readRoomVersion(firstDir), 'nechronica@1.0.0');
    assert.equal(readRoomVersion(secondDir), 'nechronica@1.0.0');
    assert.equal(catalogRoom(dataDir, firstId)?.systemVersion, '1.0.0');
    assert.equal(catalogRoom(dataDir, secondId)?.systemVersion, '1.0.0');
    assert.equal(readRawSheet(firstDir, 's-first').schema_version, 1);
    const journals = readdirSync(join(dataDir, 'backups', 'system-migrations'));
    const journal = JSON.parse(readFileSync(join(dataDir, 'backups', 'system-migrations', journals[0]!, 'journal.json'), 'utf8')) as { status: string };
    assert.equal(journal.status, 'rolled-back');
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('25. the operation writes a catalog backup, per-room backups and a completed journal', async () => {
  const dataDir = tempDir('backups');
  try {
    const directory = createRoomFixture(dataDir, {
      id: '23232323-2323-4323-8323-232323232323', name: 'Backed', systemId: 'nechronica',
      systemVersion: '1.0.0', sheets: [{ id: 's-backed', name: 'B', schemaVersion: 1 }],
    });
    const result = await migrateSystem({ dataDir, systemId: 'nechronica', yes: true, skipServerCheck: true });
    assert.equal(result.applied, true);
    assert.ok(result.catalogBackup);
    assert.equal(existsSync(join(result.catalogBackup!, 'catalog.sqlite')), true);
    assert.equal(existsSync(join(result.catalogBackup!, 'server-secret')), true);
    assert.ok(result.journalPath);
    const journal = JSON.parse(readFileSync(result.journalPath!, 'utf8')) as {
      status: string;
      systemId: string;
      targetVersion: string;
      roomBackups: Array<{ roomId: string; path: string }>;
    };
    assert.equal(journal.status, 'completed');
    assert.equal(journal.systemId, 'nechronica');
    assert.equal(journal.targetVersion, '1.2.0');
    assert.equal(journal.roomBackups.length, 1);
    assert.equal(existsSync(journal.roomBackups[0]!.path), true);
    const backups = await listBackups(directory);
    assert.equal(backups.length, 1);
    assert.equal(backups[0]!.systemVersion, '1.0.0');
    assert.equal(existsSync(join(backups[0]!.path, 'room.sqlite')), true);
    // Safety copies are never deleted by the operation.
    assert.equal(existsSync(result.operationDir!), true);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('26. after apply the exact pair is enforced, isolation holds and triggers are recreated', async () => {
  const dataDir = tempDir('verify');
  try {
    const roomId = '34343434-3434-4434-8434-343434343434';
    const directory = createRoomFixture(dataDir, {
      id: roomId, name: 'Verified', systemId: 'nechronica', systemVersion: '1.0.0', assetId: 'art-v',
      sheets: [{
        id: 's-v', name: 'V', schemaVersion: 1, portraitAssetId: 'art-v',
        assignedPlayerId: player.participantId, assignedPlayerName: player.name,
      }],
    });
    const result = await migrateSystem({ dataDir, systemId: 'nechronica', yes: true, skipServerCheck: true });
    assert.equal(result.applied, true);
    const store = new RoomStore(directory, 'Verified');
    try {
      assert.equal(store.roomSystem.version, '1.2.0');
      assert.equal(store.getSheetsFor(gm).length, 1);
      assert.equal(store.getSheetsFor(player).length, 1);
      assert.equal(store.getSheetsByAssignedPlayer(player.participantId).length, 1);
      assert.ok(store.getSheetFor('s-v', player));
      assert.equal(store.canEditSheet('s-v', player), true);
      assert.equal(store.getAssetUsage('art-v').some((usage) => usage.kind === 'sheet-portrait'), true);
      assert.throws(() => store.db.prepare('UPDATE room SET system_version = ? WHERE id = 1').run('1.0.0'), /ROOM_SYSTEM_IMMUTABLE/);
    } finally { store.close(); }
    const module = await loadSystemServer('nechronica', '1.2.0');
    const verifyStore = new RoomStore(directory, 'Verified');
    try {
      const problems = module.verifyRoomSheets?.({
        store: verifyStore,
        target: { id: 'nechronica', version: '1.2.0', schemaVersion: 3 },
      });
      assert.deepEqual(problems, []);
    } finally { verifyStore.close(); }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('27. corrupt persisted JSON aborts the whole migration and is not replaced', async () => {
  const dataDir = tempDir('corrupt');
  try {
    const directory = createRoomFixture(dataDir, {
      id: '45454545-4545-4545-8545-454545454545', name: 'Corrupt', systemId: 'nechronica', systemVersion: '1.0.0',
    });
    // Insert an intentionally corrupt payload that a legacy build may have left.
    const db = new Database(join(directory, 'room.sqlite'));
    try {
      db.prepare(`INSERT INTO character_sheets
        (id, creator_id, creator_name, assigned_player_id, assigned_player_name, system_id, system_version,
         schema_version, character_name, portrait_asset_id, characteristics_json, fate, system_data_json)
        VALUES ('s-corrupt', 'gm-1', 'Keeper', NULL, NULL, 'nechronica', '1.0.0', 2, 'Broken', NULL, '{}', 0, '{not json')`).run();
    } finally { db.close(); }
    const before = readRawSheet(directory, 's-corrupt').system_data_json;
    await assert.rejects(
      () => migrateSystem({ dataDir, systemId: 'nechronica', yes: true, skipServerCheck: true }),
      /некорректный JSON/,
    );
    assert.equal(readRawSheet(directory, 's-corrupt').system_data_json, before);
    assert.equal(readRoomVersion(directory), 'nechronica@1.0.0');
    assert.equal(catalogRoom(dataDir, '45454545-4545-4545-8545-454545454545')?.systemVersion, '1.0.0');
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

/* ---------- Regression: loaders, exact pairs and PbtA isolation ---------- */

test('28. loaders keep exact pairs, the 1.0.0 module has no migration hook and PbtA is unchanged', async () => {
  const legacy = await loadSystemServer('nechronica', '1.0.0');
  const current = await loadSystemServer('nechronica', '1.2.0');
  const pbta = await loadSystemServer('pbta-2d6', '1.0.0');
  assert.equal(legacy.migrateRoomSheets, undefined);
  assert.ok(current.migrateRoomSheets);
  assert.ok(current.verifyRoomSheets);
  assert.equal(pbta.migrateRoomSheets, undefined);
  assert.deepEqual(
    [...clientLoaderKeys].sort(),
    ['nechronica@1.0.0', 'nechronica@1.1.0', 'nechronica@1.2.0', 'pbta-2d6@1.0.0'],
  );
  assert.equal(findLatestSystemMetadata('nechronica')?.version, '1.2.0');
  assert.equal(findSystemMetadata('nechronica', '1.0.0')?.sheetSchemaVersion, 1);
  assert.equal(findSystemMetadata('nechronica', '1.1.0')?.sheetSchemaVersion, 2);
  assert.equal(findSystemMetadata('nechronica', '1.2.0')?.sheetSchemaVersion, 3);
});

test('29. a latest-version room with an older sheet schema is migrated, not skipped', async () => {
  const dataDir = tempDir('schema-only');
  try {
    const roomId = '56565656-5656-4656-8656-565656565656';
    const directory = createRoomFixture(dataDir, {
      id: roomId, name: 'Schema only', systemId: 'nechronica', systemVersion: '1.2.0',
      sheets: [{ id: 's-old', name: 'Old schema', schemaVersion: 1, systemData: null }],
    });
    const plan = await planSystemMigration(dataDir, 'nechronica');
    assert.equal(plan.rooms[0]!.needsMigration, true);
    assert.equal(plan.rooms[0]!.sheetsToMigrate, 1);
    const result = await migrateSystem({ dataDir, systemId: 'nechronica', yes: true, skipServerCheck: true });
    assert.equal(result.applied, true);
    const row = readRawSheet(directory, 's-old');
    assert.equal(row.schema_version, 3);
    assert.equal(parseNechronicaSheetData(JSON.parse(row.system_data_json!)).schemaVersion, 3);
    assert.equal(readRoomVersion(directory), 'nechronica@1.2.0');
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('30. the original failure is reproduced and repaired: a version bump without sheets hides them with SYSTEM_MISMATCH', async () => {
  const dataDir = tempDir('repro');
  try {
    const directory = createRoomFixture(dataDir, {
      id: '67676767-6767-4767-8767-676767676767', name: 'Repro', systemId: 'nechronica', systemVersion: '1.0.0',
      sheets: [{ id: 's-repro', name: 'Csarag', schemaVersion: 1 }],
    });
    // Simulate a room version bump performed without migrating its sheets.
    const db = new Database(join(directory, 'room.sqlite'));
    try {
      db.exec('DROP TRIGGER IF EXISTS room_system_immutable');
      db.prepare("UPDATE room SET system_version = '1.2.0' WHERE id = 1").run();
    } finally { db.close(); }

    const store = new RoomStore(directory, 'Repro');
    try {
      assert.equal(store.roomSystem.version, '1.2.0');
      assert.deepEqual(store.getSheetsFor(gm), [], 'the old sheet disappears from the room snapshot');
      assert.equal(store.getSheet('s-repro')?.systemVersion, '1.0.0');
      await assert.rejects(
        () => executeSheetCommand(store, gm, { type: 'sheet:nechronica:ap', sheetId: 's-repro', maxAp: 1 }),
        (error: unknown) => {
          assert.ok(error instanceof BoardCommandError);
          assert.equal(error.code, SYSTEM_MISMATCH);
          assert.match(error.message, /Лист относится к другой игровой системе\./);
          return true;
        },
      );

      const module = await loadSystemServer('nechronica', '1.2.0');
      const report = module.migrateRoomSheets!({
        store,
        target: { id: 'nechronica', version: '1.2.0', schemaVersion: 3 },
      });
      assert.deepEqual(report.migratedSheetIds, ['s-repro']);
      assert.equal(store.getSheetsFor(gm).length, 1, 'the repaired sheet is visible again');
      await executeSheetCommand(store, gm, { type: 'sheet:nechronica:ap', sheetId: 's-repro', maxAp: 3 });
      assert.equal(parseNechronicaSheetData(store.getSheet('s-repro')!.systemData).profile.maxAp, 3);
    } finally { store.close(); }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('31. the lock helper refuses a live owner and can be released by that owner', () => {
  const dataDir = tempDir('instance-lock');
  try {
    writeFileSync(serverLockPath(dataDir), '1\n', { mode: 0o600 });
    assert.throws(() => acquireServerLock(dataDir), /Сервер уже запущен/);
    rmSync(serverLockPath(dataDir), { force: true });
    const release = acquireServerLock(dataDir);
    assert.equal(existsSync(serverLockPath(dataDir)), true);
    release();
    assert.equal(existsSync(serverLockPath(dataDir)), false);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
