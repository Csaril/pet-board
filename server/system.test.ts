import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import WebSocket from 'ws';
import type { DiceRollEntry } from '../src/shared/board.js';
import { createBackup, restoreBackup } from './backup-lib.js';
import type { AppConfig } from './config.js';
import { buildServer } from './index.js';
import { executeSheetCommand } from './sheets.js';
import { RoomStore, type Identity } from './store.js';

const gm: Identity = { participantId: 'gm-system', name: 'Keeper', role: 'gm' };
const player: Identity = { participantId: 'player-system', name: 'Ari', role: 'player' };

function configFor(dataDir: string): AppConfig {
  return {
    host: '127.0.0.1', port: 0, dataDir, roomName: 'Campaign', roomCode: 'room-code-with-enough-length',
    gmPassword: 'gm-password-with-enough-length', sessionDays: 30, cookieSecure: false, maxUploadBytes: 1024,
  };
}

function nextMessage(socket: WebSocket, predicate: (message: Record<string, unknown>) => boolean, label = 'WebSocket response'): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { socket.off('message', listener); reject(new Error(`${label} timeout`)); }, 3000);
    const listener = (raw: WebSocket.RawData) => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (!predicate(message)) return;
      clearTimeout(timeout);
      socket.off('message', listener);
      resolve(message);
    };
    socket.on('message', listener);
  });
}

function tableIds(database: Database.Database, table: string): string[] {
  return (database.prepare(`SELECT id FROM ${table} ORDER BY id`).all() as Array<{ id: string }>).map((row) => row.id);
}

function historicalRoll(patch: Partial<DiceRollEntry> & Pick<DiceRollEntry, 'id' | 'createdAt'>): DiceRollEntry {
  return {
    authorId: player.participantId, authorName: player.name, actorId: player.participantId, actorName: player.name,
    kind: 'pbta', systemId: 'pbta-2d6', systemVersion: null,
    dice: [2, 3], keptDice: [2, 3], discardedDie: null, characteristicName: null,
    characterId: null, characterOwnerId: null, characteristicBonus: 0, situationalModifier: 0,
    disadvantage: false, sides: 6, total: 5, category: 'success', critical: null, rerollOf: null,
    abilityId: null, abilitySheetId: null, abilityCharacterName: null, abilityName: null,
    abilityAssetId: null, abilitySummary: null, abilityDescription: null, abilityFontFamily: null,
    ...patch,
  };
}

test('migration of a copy of the real room fixes the system and keeps every record', (t) => {
  const source = join(process.cwd(), 'data', 'room.sqlite');
  if (!existsSync(source)) {
    t.skip('data/room.sqlite отсутствует в этом окружении.');
    return;
  }
  const dataDir = mkdtempSync(join(tmpdir(), 'tabletop-system-real-'));
  try {
    copyFileSync(source, join(dataDir, 'room.sqlite'));
    const legacy = new Database(join(dataDir, 'room.sqlite'), { readonly: true, fileMustExist: true });
    let legacySystem: { id: string | null; version: string | null; fixed: boolean };
    let ids: Record<string, string[]>;
    let legacyRolls: Array<{ id: string; kind: string }>;
    try {
      const columns = new Set((legacy.prepare('PRAGMA table_info(room)').all() as Array<{ name: string }>).map((column) => column.name));
      const row = legacy.prepare('SELECT * FROM room WHERE id = 1').get() as Record<string, unknown>;
      const id = (row.system_id ?? row.active_system_id ?? null) as string | null;
      const version = (row.system_version ?? row.active_system_version ?? null) as string | null;
      legacySystem = {
        id, version,
        fixed: columns.has('system_fixed') && Number(row.system_fixed) === 1 ? true : id !== null && version !== null,
      };
      ids = {
        assets: tableIds(legacy, 'assets'),
        board_objects: tableIds(legacy, 'board_objects'),
        notes: tableIds(legacy, 'notes'),
        note_markers: tableIds(legacy, 'note_markers'),
        character_sheets: tableIds(legacy, 'character_sheets'),
        character_counters: tableIds(legacy, 'character_counters'),
        character_abilities: tableIds(legacy, 'character_abilities'),
      };
      legacyRolls = legacy.prepare('SELECT id, kind FROM dice_rolls ORDER BY id').all() as typeof legacyRolls;
    } finally { legacy.close(); }

    const store = new RoomStore(dataDir, 'Migration copy');
    let migratedSystem: { fixed: boolean; id: string | null; version: string | null; name: string | null; config: Record<string, unknown> };
    try {
      migratedSystem = store.roomSystem;
      if (legacySystem.fixed) {
        assert.equal(store.roomSystem.fixed, true);
        assert.equal(store.roomSystem.id, legacySystem.id);
        assert.equal(store.roomSystem.version, legacySystem.version);
        if (legacySystem.id && legacySystem.version) {
          assert.deepEqual(store.fixedSystem, { id: legacySystem.id, version: legacySystem.version });
        } else {
          assert.equal(store.fixedSystem, null);
        }
      } else {
        assert.equal(store.roomSystem.fixed, false);
      }
      for (const [table, expected] of Object.entries(ids)) {
        assert.deepEqual(tableIds(store.db, table), expected, `${table} IDs must be preserved`);
      }
      const rolls = store.db.prepare('SELECT id, kind, system_id, system_version FROM dice_rolls ORDER BY id').all() as Array<{ id: string; kind: string; system_id: string | null; system_version: string | null }>;
      assert.deepEqual(rolls.map((roll) => roll.id), legacyRolls.map((roll) => roll.id));
      for (const roll of rolls) {
        if (roll.kind === 'free') assert.deepEqual({ id: roll.system_id, version: roll.system_version }, { id: null, version: null });
        else if (roll.kind === 'pbta' || roll.kind === 'ability-use') {
          // The old module version was never stored, so it must not be invented.
          assert.deepEqual({ id: roll.system_id, version: roll.system_version }, { id: 'pbta-2d6', version: null });
        }
      }
      // A sheet from another system is preserved but not exposed by the usual APIs.
      const allSheets = store.getSheets();
      const foreign = allSheets.filter((sheet) => legacySystem.id === null || sheet.systemId !== legacySystem.id || sheet.systemVersion !== legacySystem.version);
      if (foreign.length) {
        const hidden = foreign[0]!;
        assert.equal(store.getSheetFor(hidden.id, gm), undefined);
        assert.equal(store.getSheetsFor(gm).some((sheet) => sheet.id === hidden.id), false);
        assert.equal(store.canEditSheet(hidden.id, gm), false);
        assert.throws(() => executeSheetCommand(store, gm, { type: 'sheet:update', id: hidden.id, changes: { characterName: 'Hidden' } }));
        assert.ok(store.getSheet(hidden.id));
      }
      // Ordinary writes cannot replace the fixed system.
      assert.throws(() => store.db.prepare("UPDATE room SET system_id = 'nechronica' WHERE id = 1").run(), /ROOM_SYSTEM_IMMUTABLE/);
      assert.throws(() => store.db.prepare('UPDATE room SET system_fixed = 0 WHERE id = 1').run(), /ROOM_SYSTEM_IMMUTABLE/);
      assert.throws(() => store.db.prepare("UPDATE room SET active_system_id = 'nechronica' WHERE id = 1").run(), /ROOM_SYSTEM_IMMUTABLE/);
    } finally { store.close(); }

    // Opening the same migrated database again must be a no-op.
    const reopened = new RoomStore(dataDir, 'Migration copy');
    try {
      assert.deepEqual(reopened.roomSystem, migratedSystem);
      for (const [table, expected] of Object.entries(ids)) {
        assert.deepEqual(tableIds(reopened.db, table), expected, `${table} IDs must survive a restart`);
      }
    } finally { reopened.close(); }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('legacy migration rejects partial or unknown systems without committing a fix', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tabletop-system-legacy-'));
  try {
    const legacy = new Database(join(dataDir, 'room.sqlite'));
    legacy.exec(`
      CREATE TABLE room (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        name TEXT NOT NULL,
        active_system_id TEXT,
        active_system_version TEXT
      );
      INSERT INTO room (id, name, active_system_id, active_system_version) VALUES (1, 'Legacy', 'pbta-2d6', NULL);
      CREATE TABLE character_sheets (
        id TEXT PRIMARY KEY, creator_id TEXT NOT NULL, creator_name TEXT NOT NULL,
        assigned_player_id TEXT, assigned_player_name TEXT, system_id TEXT NOT NULL,
        system_version TEXT NOT NULL, schema_version INTEGER NOT NULL, character_name TEXT NOT NULL DEFAULT '',
        portrait_asset_id TEXT, characteristics_json TEXT NOT NULL, fate INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    legacy.close();

    assert.throws(() => new RoomStore(dataDir, 'Legacy'), /Требуется ручная проверка/);

    const repair = new Database(join(dataDir, 'room.sqlite'));
    try { repair.prepare("UPDATE room SET active_system_version = '1.0.0' WHERE id = 1").run(); }
    finally { repair.close(); }

    const migrated = new RoomStore(dataDir, 'Legacy');
    try {
      assert.deepEqual(migrated.fixedSystem, { id: 'pbta-2d6', version: '1.0.0' });
    } finally { migrated.close(); }
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('a fresh room can choose a system once, including the deliberate no-system mode', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tabletop-system-fresh-'));
  const noSystemDir = mkdtempSync(join(tmpdir(), 'tabletop-system-none-'));
  try {
    const store = new RoomStore(dataDir, 'Fresh');
    try {
      assert.deepEqual(store.roomSystem, { fixed: false, id: null, version: null, name: null, config: {}, capabilities: { battleMap: false } });
      assert.equal(store.fixedSystem, null);
      assert.deepEqual(store.getSheetsFor(gm), []);
      assert.throws(() => store.createSheet({
        id: 'blocked', creatorId: gm.participantId, creatorName: gm.name, assignedPlayerId: null, assignedPlayerName: null,
        systemId: 'pbta-2d6', systemVersion: '1.0.0', schemaVersion: 1, characterName: 'Blocked', portraitAssetId: null,
        characteristics: { might: 0, insight: 0, glory: 0, will: 0 }, fate: 0,
      }), /не закреплена/);
      // The pair guard rejects a half-written system before the first fix.
      assert.throws(() => store.db.prepare("UPDATE room SET system_id = 'pbta-2d6' WHERE id = 1").run(), /ROOM_SYSTEM_INVALID/);
      store.initializeSystem('pbta-2d6', '1.0.0', { setting: 'grim' });
      assert.deepEqual(store.roomSystem, { fixed: true, id: 'pbta-2d6', version: '1.0.0', name: 'PbtA', config: { setting: 'grim' }, capabilities: { battleMap: false } });
      assert.throws(() => store.initializeSystem('nechronica', '1.0.0'), /ROOM_SYSTEM_IMMUTABLE/);
      assert.deepEqual(store.roomSystem, { fixed: true, id: 'pbta-2d6', version: '1.0.0', name: 'PbtA', config: { setting: 'grim' }, capabilities: { battleMap: false } });
    } finally { store.close(); }

    const reopened = new RoomStore(dataDir, 'Fresh');
    try {
      assert.deepEqual(reopened.roomSystem, { fixed: true, id: 'pbta-2d6', version: '1.0.0', name: 'PbtA', config: { setting: 'grim' }, capabilities: { battleMap: false } });
    } finally { reopened.close(); }

    const noSystem = new RoomStore(noSystemDir, 'No system');
    try {
      noSystem.initializeSystem(null, null);
      assert.deepEqual(noSystem.roomSystem, { fixed: true, id: null, version: null, name: null, config: {}, capabilities: { battleMap: false } });
      assert.equal(noSystem.fixedSystem, null);
      assert.deepEqual(noSystem.getSheetsFor(gm), []);
      assert.throws(() => noSystem.createSheet({
        id: 'blocked-none', creatorId: gm.participantId, creatorName: gm.name, assignedPlayerId: null, assignedPlayerName: null,
        systemId: 'pbta-2d6', systemVersion: '1.0.0', schemaVersion: 1, characterName: 'Blocked', portraitAssetId: null,
        characteristics: { might: 0, insight: 0, glory: 0, will: 0 }, fate: 0,
      }), /не закреплена/);
      assert.throws(() => noSystem.initializeSystem('pbta-2d6', '1.0.0'), /ROOM_SYSTEM_IMMUTABLE/);
    } finally { noSystem.close(); }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(noSystemDir, { recursive: true, force: true });
  }
});

test('a controlled version migration may drop the immutable trigger, ordinary writes may not', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tabletop-system-controlled-'));
  try {
    const store = new RoomStore(dataDir, 'Controlled');
    try {
      store.initializeSystem('pbta-2d6', '1.0.0');
      assert.throws(() => store.db.prepare("UPDATE room SET system_version = '2.0.0' WHERE id = 1").run(), /ROOM_SYSTEM_IMMUTABLE/);
      // A future explicit migration owns this step; every ordinary path stays blocked.
      store.db.exec('DROP TRIGGER room_system_immutable');
      store.db.prepare("UPDATE room SET system_version = '2.0.0' WHERE id = 1").run();
      assert.equal(store.roomSystem.id, 'pbta-2d6');
      assert.equal(store.roomSystem.version, '2.0.0');
      assert.throws(() => store.initializeSystem('pbta-2d6', '1.0.0'), /ROOM_SYSTEM_IMMUTABLE/);
    } finally { store.close(); }
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('HTTP and WebSocket allow one system commit and reject every later change', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tabletop-system-http-'));
  const config = configFor(dataDir);
  const store = new RoomStore(dataDir, config.roomName);
  const app = await buildServer({ config, store, logger: false });
  const sockets: WebSocket[] = [];
  try {
    const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    const { host } = new URL(baseUrl);
    const origin = `http://${host}`;
    const login = async (name: string, role: 'gm' | 'player') => {
      const response = await app.inject({ method: 'POST', url: '/api/session', headers: { origin, host }, payload: { name, role, roomCode: config.roomCode, gmPassword: role === 'gm' ? config.gmPassword : undefined } });
      assert.equal(response.statusCode, 200);
      return (response.headers['set-cookie'] as string).split(';')[0]!;
    };
    const connect = async (cookie: string) => {
      const socket = new WebSocket(`ws://${host}/ws`, { headers: { origin, cookie } });
      sockets.push(socket);
      const state = nextMessage(socket, (message) => message.type === 'room:state');
      await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
      return { socket, state: await state };
    };
    const putSystem = (cookie: string | undefined, payload: Record<string, unknown>) => app.inject({
      method: 'PUT', url: '/api/room/system', headers: { origin, host, ...(cookie ? { cookie } : {}) }, payload,
    });

    assert.equal((await app.inject({ method: 'PUT', url: '/api/room/system', headers: { origin, host }, payload: { systemId: null } })).statusCode, 401);
    const gmCookie = await login('Keeper', 'gm');
    const playerCookie = await login('Ari', 'player');

    assert.equal((await putSystem(playerCookie, { systemId: 'pbta-2d6', version: '1.0.0' })).statusCode, 403);
    assert.equal(store.roomSystem.fixed, false);
    assert.equal((await putSystem(gmCookie, { systemId: 'unknown', version: '1.0.0' })).statusCode, 400);
    assert.equal((await putSystem(gmCookie, { systemId: 'pbta-2d6', version: '9.9.9' })).statusCode, 400);
    assert.equal((await putSystem(gmCookie, { systemId: null, version: '1.0.0' })).statusCode, 400);
    assert.equal(store.roomSystem.fixed, false);

    const committed = await putSystem(gmCookie, { systemId: 'pbta-2d6', version: '1.0.0' });
    assert.equal(committed.statusCode, 200);
    assert.deepEqual(committed.json().system, { fixed: true, id: 'pbta-2d6', version: '1.0.0', name: 'PbtA', config: {}, capabilities: { battleMap: false } });

    const repeated = await putSystem(gmCookie, { systemId: 'nechronica', version: '1.0.0' });
    assert.equal(repeated.statusCode, 409);
    assert.equal(repeated.json().code, 'ROOM_SYSTEM_IMMUTABLE');
    const repeatedNull = await putSystem(gmCookie, { systemId: null });
    assert.equal(repeatedNull.statusCode, 409);
    assert.equal(repeatedNull.json().code, 'ROOM_SYSTEM_IMMUTABLE');

    const board = await app.inject({ method: 'GET', url: '/api/board', headers: { cookie: playerCookie } });
    assert.equal(board.statusCode, 200);
    assert.deepEqual(board.json().system, { fixed: true, id: 'pbta-2d6', version: '1.0.0', name: 'PbtA', config: {}, capabilities: { battleMap: false } });

    const gmConnection = await connect(gmCookie);
    const playerConnection = await connect(playerCookie);
    const actorId = (playerConnection.state.identity as { participantId: string }).participantId;

    for (const [socket, requestId] of [[gmConnection.socket, 'gm-set'], [playerConnection.socket, 'player-set']] as const) {
      const denied = nextMessage(socket, (message) => message.type === 'command:result' && message.requestId === requestId);
      socket.send(JSON.stringify({ type: 'room:system:set', systemId: null, version: null, requestId }));
      const ack = await denied;
      assert.equal(ack.ok, false);
      assert.equal(ack.code, 'ROOM_SYSTEM_IMMUTABLE');
    }
    const reinitialize = nextMessage(gmConnection.socket, (message) => message.type === 'command:result' && message.requestId === 'gm-reinit');
    gmConnection.socket.send(JSON.stringify({ type: 'room:system:initialize', systemId: 'nechronica', version: '1.0.0', requestId: 'gm-reinit' }));
    const reinitAck = await reinitialize;
    assert.equal(reinitAck.ok, false);
    assert.equal(reinitAck.code, 'ROOM_SYSTEM_IMMUTABLE');

    // New PbtA rolls are attributed by the server; free rolls stay system-neutral.
    const sendDice = async (payload: Record<string, unknown>, requestId: string) => {
      const ack = nextMessage(playerConnection.socket, (message) => message.type === 'command:result' && message.requestId === requestId);
      playerConnection.socket.send(JSON.stringify({ ...payload, requestId }));
      assert.equal((await ack).ok, true);
      return (await app.inject({ method: 'GET', url: '/api/board', headers: { cookie: playerCookie } })).json().diceRolls as Array<Record<string, unknown>>;
    };
    const pbtaRolls = await sendDice({ type: 'dice:pbta', characteristicBonus: 0, situationalModifier: 0, disadvantage: false }, 'pbta-roll');
    assert.deepEqual({ id: pbtaRolls[0]!.systemId, version: pbtaRolls[0]!.systemVersion }, { id: 'pbta-2d6', version: '1.0.0' });
    const freeRolls = await sendDice({ type: 'dice:free', count: 1, sides: 6 }, 'free-roll');
    assert.deepEqual({ id: freeRolls[0]!.systemId, version: freeRolls[0]!.systemVersion }, { id: null, version: null });

    // Legacy history keeps NULL version and cannot be replayed through current mechanics.
    store.saveDiceRoll(historicalRoll({
      id: 'historical-pbta', createdAt: new Date().toISOString(),
      authorId: actorId, authorName: 'Ari', actorId, actorName: 'Ari',
    }));
    const rerollDenied = nextMessage(playerConnection.socket, (message) => message.type === 'command:result' && message.requestId === 'historical-reroll');
    playerConnection.socket.send(JSON.stringify({ type: 'dice:reroll', rollId: 'historical-pbta', requestId: 'historical-reroll' }));
    const rerollAck = await rerollDenied;
    assert.equal(rerollAck.ok, false);
    assert.equal(rerollAck.code, 'SYSTEM_MISMATCH');
  } finally {
    for (const socket of sockets) socket.close();
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('a Nechronica room hides foreign sheets and rejects PbtA mechanics while free rolls work', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tabletop-system-nechronica-'));
  const config = configFor(dataDir);
  const store = new RoomStore(dataDir, config.roomName);
  store.initializeSystem('nechronica', '1.0.0');
  // A sheet left from the previous system remains stored but is isolated.
  store.db.prepare(`INSERT INTO character_sheets
    (id, creator_id, creator_name, assigned_player_id, assigned_player_name, system_id, system_version, schema_version, character_name, characteristics_json, fate)
    VALUES ('legacy-pbta-sheet', ?, ?, ?, ?, 'pbta-2d6', '1.0.0', 1, 'Old Ari', '{"might":1,"insight":0,"glory":0,"will":0}', 0)`)
    .run(player.participantId, player.name, player.participantId, player.name);
  const app = await buildServer({ config, store, logger: false });
  const sockets: WebSocket[] = [];
  try {
    const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    const { host } = new URL(baseUrl);
    const origin = `http://${host}`;
    const login = async (name: string, role: 'gm' | 'player') => {
      const response = await app.inject({ method: 'POST', url: '/api/session', headers: { origin, host }, payload: { name, role, roomCode: config.roomCode, gmPassword: role === 'gm' ? config.gmPassword : undefined } });
      assert.equal(response.statusCode, 200);
      return (response.headers['set-cookie'] as string).split(';')[0]!;
    };
    const connect = async (cookie: string) => {
      const socket = new WebSocket(`ws://${host}/ws`, { headers: { origin, cookie } });
      sockets.push(socket);
      const state = nextMessage(socket, (message) => message.type === 'room:state');
      await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
      return { socket, state: await state };
    };
    const gmCookie = await login('Keeper', 'gm');
    const playerCookie = await login('Ari', 'player');
    const gmConnection = await connect(gmCookie);
    const playerConnection = await connect(playerCookie);

    assert.equal((gmConnection.state.sheets as Array<Record<string, unknown>>).length, 0);
    const sheetResponse = await app.inject({ method: 'GET', url: '/api/sheets/legacy-pbta-sheet', headers: { cookie: gmCookie } });
    assert.equal(sheetResponse.statusCode, 404);
    const sheetsResponse = await app.inject({ method: 'GET', url: '/api/sheets', headers: { cookie: gmCookie } });
    assert.deepEqual(sheetsResponse.json().sheets, []);

    const pbtaDenied = nextMessage(playerConnection.socket, (message) => message.type === 'command:result' && message.requestId === 'nech-pbta');
    playerConnection.socket.send(JSON.stringify({ type: 'dice:pbta', characteristicBonus: 0, situationalModifier: 0, disadvantage: false, requestId: 'nech-pbta' }));
    const pbtaAck = await pbtaDenied;
    assert.equal(pbtaAck.ok, false);
    assert.equal(pbtaAck.code, 'SYSTEM_MISMATCH');

    const freeAck = nextMessage(playerConnection.socket, (message) => message.type === 'command:result' && message.requestId === 'nech-free');
    playerConnection.socket.send(JSON.stringify({ type: 'dice:free', count: 1, sides: 20, requestId: 'nech-free' }));
    assert.equal((await freeAck).ok, true);
    const rolls = (await app.inject({ method: 'GET', url: '/api/board', headers: { cookie: playerCookie } })).json().diceRolls as Array<Record<string, unknown>>;
    assert.deepEqual({ id: rolls[0]!.systemId, version: rolls[0]!.systemVersion }, { id: null, version: null });

    // Shared board data still works; only system mechanics are disabled.
    const boardCommand = nextMessage(gmConnection.socket, (message) => message.type === 'command:result' && message.requestId === 'nech-background');
    gmConnection.socket.send(JSON.stringify({ type: 'room:background:set', background: 'black', requestId: 'nech-background' }));
    assert.equal((await boardCommand).ok, true);
  } finally {
    for (const socket of sockets) socket.close();
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('backup and restore preserve the fixed system and its triggers', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tabletop-system-backup-'));
  try {
    const store = new RoomStore(dataDir, 'Campaign');
    store.initializeSystem('pbta-2d6', '1.0.0', { variant: 'standard' });
    store.saveDiceRoll(historicalRoll({ id: 'kept-roll', createdAt: new Date().toISOString(), systemId: 'pbta-2d6', systemVersion: '1.0.0' }));
    store.close();

    const backup = await createBackup(dataDir, 'Campaign');
    await restoreBackup(dataDir, 'Campaign', backup.name);
    const restored = new RoomStore(dataDir, 'Campaign');
    try {
      assert.deepEqual(restored.roomSystem, { fixed: true, id: 'pbta-2d6', version: '1.0.0', name: 'PbtA', config: { variant: 'standard' }, capabilities: { battleMap: false } });
      assert.equal(restored.getDiceRolls()[0]?.id, 'kept-roll');
      assert.throws(() => restored.initializeSystem('nechronica', '1.0.0'), /ROOM_SYSTEM_IMMUTABLE/);
      const triggers = restored.db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all() as Array<{ name: string }>;
      assert.deepEqual(triggers.map((trigger) => trigger.name), ['room_legacy_system_immutable', 'room_system_fixed_immutable', 'room_system_immutable', 'room_system_pair_update']);
    } finally { restored.close(); }
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('the interface only offers the one-time system choice and marks history', () => {
  const clientSource = readFileSync(join(process.cwd(), 'src', 'client', 'app.ts'), 'utf8');
  const indexSource = readFileSync(join(process.cwd(), 'src', 'pages', 'index.astro'), 'utf8');
  const styleSource = readFileSync(join(process.cwd(), 'src', 'styles', 'global.css'), 'utf8');

  assert.match(indexSource, /id="room-system-readonly"/);
  assert.match(indexSource, /id="room-system"/);
  assert.match(clientSource, /room:system:initialize/);
  assert.doesNotMatch(clientSource, /room:system:set/);
  assert.match(clientSource, /systemReadonly\.hidden = !system\.fixed/);
  assert.match(clientSource, /if \(system\.fixed\)/);
  assert.match(clientSource, /Историческая запись/);
  assert.match(clientSource, /!isHistoricalRoll\(roll\)/);
  assert.match(styleSource, /\.dice-entry-historical/);
});
