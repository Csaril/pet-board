import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import WebSocket from 'ws';
import { findSystemModule, systemModules } from '../src/modules/registry.js';
import { pbtaSystemModule } from '../src/modules/system/pbta-2d6/module.js';
import { createBackup, restoreBackup } from './backup-lib.js';
import { executeBoardCommand } from './board.js';
import type { AppConfig } from './config.js';
import { buildServer } from './index.js';
import { executeSheetCommand } from './sheets.js';
import { RoomStore, type Identity } from './store.js';

const gm: Identity = { participantId: 'gm-1', name: 'Keeper', role: 'gm' };
const player: Identity = { participantId: 'player-1', name: 'Ari', role: 'player' };
const otherPlayer: Identity = { participantId: 'player-2', name: 'Bo', role: 'player' };

function withStore(label: string, run: (store: RoomStore, dataDir: string) => void | Promise<void>): Promise<void> {
  return (async () => {
    const dataDir = mkdtempSync(join(tmpdir(), `tabletop-${label}-`));
    const store = new RoomStore(dataDir, 'Campaign');
    try { await run(store, dataDir); } finally { store.close(); rmSync(dataDir, { recursive: true, force: true }); }
  })();
}

test('Nechronica is registered as an independent system module', () => {
  const module = findSystemModule('nechronica');
  assert.ok(module);
  assert.equal(module.name, 'Nechronica');
  assert.equal(module.version, '1.0.0');
  assert.equal(module.sheetSchemaVersion, 1);
  assert.notEqual(module.id, pbtaSystemModule.id);
  assert.ok(systemModules.some((entry) => entry.id === 'nechronica'));
  assert.ok(systemModules.some((entry) => entry.id === 'pbta-2d6'));
});

test('Nechronica and PbtA sheets stay isolated and PbtA-only commands are rejected', async () => {
  const pbtaDir = mkdtempSync(join(tmpdir(), 'tabletop-system-pbta-'));
  const nechDir = mkdtempSync(join(tmpdir(), 'tabletop-system-nechronica-'));
  const pbtaStore = new RoomStore(pbtaDir, 'PbtA room');
  const nechStore = new RoomStore(nechDir, 'Nechronica room');
  try {
    pbtaStore.initializeSystem(pbtaSystemModule.id, pbtaSystemModule.version);
    executeSheetCommand(pbtaStore, player, { type: 'sheet:create', characterName: 'PbtA hero' });
    const pbtaSheet = pbtaStore.getSheetsFor(gm)[0]!;
    assert.equal(pbtaSheet.systemId, 'pbta-2d6');
    assert.deepEqual(pbtaSheet.characteristics, { might: 0, insight: 0, glory: 0, will: 0 });

    // The one-time choice cannot be replaced, and the PbtA sheet is untouched.
    assert.throws(() => pbtaStore.initializeSystem('nechronica', '1.0.0'), /ROOM_SYSTEM_IMMUTABLE/);
    assert.equal(pbtaStore.roomSystem.id, 'pbta-2d6');
    assert.equal(pbtaStore.getSheetsFor(gm).length, 1);
    assert.equal(pbtaStore.getSheet(pbtaSheet.id)?.systemId, 'pbta-2d6');

    nechStore.initializeSystem('nechronica', '1.0.0');
    executeSheetCommand(nechStore, gm, { type: 'sheet:create', characterName: 'Nechro draft' });
    executeSheetCommand(nechStore, player, { type: 'sheet:create', characterName: 'Nechro player' });
    const gmSheets = nechStore.getSheetsFor(gm);
    assert.equal(gmSheets.length, 2);
    assert.ok(gmSheets.every((sheet) => sheet.systemId === 'nechronica' && sheet.systemVersion === '1.0.0'));
    const draft = gmSheets.find((sheet) => !sheet.assignedPlayerId)!;
    const owned = gmSheets.find((sheet) => sheet.assignedPlayerId === player.participantId)!;
    assert.ok(draft);
    assert.ok(owned);
    assert.deepEqual(owned.characteristics, {});
    assert.deepEqual(owned.counters, []);
    assert.deepEqual(owned.abilities, []);
    // A player only sees assigned sheets of the fixed system.
    const playerSheets = nechStore.getSheetsFor(player);
    assert.equal(playerSheets.length, 1);
    assert.equal(playerSheets[0]!.id, owned.id);

    assert.throws(() => executeSheetCommand(nechStore, gm, { type: 'sheet:update', id: owned.id, changes: { characteristics: { might: 1 } } }), /PbtA/);
    assert.throws(() => executeSheetCommand(nechStore, gm, { type: 'sheet:update', id: owned.id, changes: { fate: 3 } }), /PbtA/);
    assert.throws(() => executeSheetCommand(nechStore, gm, { type: 'sheet:fate:update', sheetId: owned.id, value: 1 }), /PbtA/);
    assert.throws(() => executeSheetCommand(nechStore, gm, { type: 'sheet:counter:create', sheetId: owned.id, name: 'Charge' }), /PbtA/);
    assert.throws(() => executeSheetCommand(nechStore, gm, { type: 'sheet:ability:create', sheetId: owned.id, name: 'Move' }), /PbtA/);
    // Shared fields keep working for any system.
    executeSheetCommand(nechStore, gm, { type: 'sheet:update', id: owned.id, changes: { characterName: 'Nechro renamed' } });
    assert.equal(nechStore.getSheet(owned.id)?.characterName, 'Nechro renamed');
    // A player cannot edit another player's sheet.
    assert.throws(() => executeSheetCommand(nechStore, otherPlayer, { type: 'sheet:update', id: owned.id, changes: { characterName: 'Hijack' } }), /назначенный/);

    // The Nechronica room never exposes the PbtA sheet and cannot switch systems.
    assert.equal(nechStore.getSheetsFor(gm).some((sheet) => sheet.id === pbtaSheet.id), false);
    assert.throws(() => nechStore.initializeSystem(pbtaSystemModule.id, pbtaSystemModule.version), /ROOM_SYSTEM_IMMUTABLE/);
    assert.equal(nechStore.getSheet(owned.id)?.characterName, 'Nechro renamed');
    assert.equal(nechStore.getSheets().filter((sheet) => sheet.systemId === 'nechronica').length, 2);
  } finally {
    pbtaStore.close();
    nechStore.close();
    rmSync(pbtaDir, { recursive: true, force: true });
    rmSync(nechDir, { recursive: true, force: true });
  }
});

test('battle map is a separate scene with GM-only preview data and correct ACL', async () => {
  await withStore('battle-scene', (store) => {
    store.createAsset({ id: 'battle-art', sha256: 'hash-battle', mimeType: 'image/png', originalName: 'battle.png', size: 4, width: 100, height: 100 });
    const battleLayer = store.getLayers('battle')[0]!;
    store.setBackground('battle', 'black');

    // The GM may prepare the inactive battle scene without activating it.
    executeBoardCommand(store, gm, { type: 'object:create', assetId: 'battle-art', layerId: battleLayer.id, scene: 'battle' });
    const battleObject = store.getObjects('battle')[0]!;
    assert.ok(battleObject);

    // A player cannot touch an inactive scene directly.
    assert.throws(() => executeBoardCommand(store, player, {
      type: 'object:update', id: battleObject.id, changes: { x: 5 }, scene: 'battle',
    }), /неактивную/);

    const playerBoard = store.snapshot(player);
    assert.equal(playerBoard.activeScene, 'board');
    assert.equal(playerBoard.objects.some((object) => object.id === battleObject.id), false);
    assert.equal('battle' in playerBoard, false);

    const gmPreview = store.snapshot(gm);
    assert.equal(gmPreview.activeScene, 'board');
    assert.ok(gmPreview.battle);
    assert.equal(gmPreview.battle!.background, 'black');
    assert.equal(gmPreview.battle!.objects.some((object) => object.id === battleObject.id), true);

    // Battle-only artwork is not readable by a player while the main board is active.
    assert.equal(store.canReadAsset('battle-art', player, 'board'), false);
    assert.equal(store.canReadAsset('battle-art', player, 'battle'), true);
    assert.equal(store.getAssetUsage('battle-art').some((usage) => usage.kind === 'board-object' && usage.count === 1), true);

    // Activation switches every snapshot to the battle scene.
    store.setActiveScene('battle');
    const playerBattle = store.snapshot(player);
    assert.equal(playerBattle.activeScene, 'battle');
    assert.equal(playerBattle.background, 'black');
    assert.equal(playerBattle.objects.some((object) => object.id === battleObject.id), true);

    // Editing while the scene is active is synchronized through the same model.
    executeBoardCommand(store, gm, { type: 'object:update', id: battleObject.id, changes: { x: 42 } });
    assert.equal(store.getObjects('battle')[0]?.x, 42);
    assert.equal(store.getObjects('board').length, 0);

    // Returning to the board keeps both scenes intact.
    store.setActiveScene('board');
    assert.equal(store.snapshot(player).activeScene, 'board');
    assert.equal(store.snapshot(player).objects.length, 0);
    assert.equal(store.getObjects('battle')[0]?.x, 42);
    assert.equal(store.backgroundFor('battle'), 'black');
    assert.equal(store.backgroundFor('board'), 'gray');
  });
});

test('players cannot change the active scene over WebSocket and reconnect returns the active scene', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tabletop-scene-ws-'));
  const config: AppConfig = {
    host: '127.0.0.1', port: 0, dataDir, roomName: 'Campaign', roomCode: 'room-code-with-enough-length',
    gmPassword: 'gm-password-with-enough-length', sessionDays: 30, cookieSecure: false, maxUploadBytes: 1024,
  };
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
    const gmCookie = await login('Keeper', 'gm');
    const playerCookie = await login('Ari', 'player');
    const gmSocket = await connect(gmCookie);
    const playerSocket = await connect(playerCookie);

    const playerDenied = nextMessage(playerSocket.socket, (message) => message.type === 'command:result' && message.requestId === 'player-scene');
    playerSocket.socket.send(JSON.stringify({ type: 'room:scene:set', scene: 'battle', requestId: 'player-scene' }));
    assert.equal((await playerDenied).ok, false);

    const gmState = nextMessage(playerSocket.socket, (message) => message.type === 'room:state' && message.activeScene === 'battle');
    gmSocket.socket.send(JSON.stringify({ type: 'room:scene:set', scene: 'battle', requestId: 'gm-scene' }));
    const battleState = await gmState;
    assert.equal(battleState.activeScene, 'battle');

    const returned = nextMessage(playerSocket.socket, (message) => message.type === 'room:state' && message.activeScene === 'board');
    gmSocket.socket.send(JSON.stringify({ type: 'room:scene:set', scene: 'board', requestId: 'gm-board' }));
    assert.equal((await returned).activeScene, 'board');

    // Reconnecting yields the room's current active scene.
    playerSocket.socket.close();
    const playerAgain = await connect(playerCookie);
    assert.equal(playerAgain.state.activeScene, 'board');
  } finally {
    for (const socket of sockets) socket.close();
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

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

test('backup and restore preserve the battle scene, its background and its assets', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tabletop-battle-backup-'));
  try {
    const store = new RoomStore(dataDir, 'Campaign');
    store.createAsset({ id: 'battle-art', sha256: 'hash-battle', mimeType: 'image/png', originalName: 'battle.png', size: 4, width: 10, height: 10 });
    mkdirSync(join(dataDir, 'assets'), { recursive: true, mode: 0o700 });
    writeFileSync(join(dataDir, 'assets', 'battle-art'), 'PNG1', { mode: 0o600 });
    const battleLayer = store.getLayers('battle')[0]!;
    store.setBackground('battle', 'black');
    store.setActiveScene('battle');
    executeBoardCommand(store, gm, { type: 'object:create', assetId: 'battle-art', layerId: battleLayer.id });
    const object = store.getObjects('battle')[0]!;
    store.close();

    const backup = await createBackup(dataDir, 'Campaign');
    const mutated = new RoomStore(dataDir, 'Campaign');
    try {
      mutated.setActiveScene('board');
      mutated.setBackground('battle', 'gray');
      mutated.deleteObject(object.id);
      assert.equal(mutated.getObjects('battle').length, 0);
    } finally { mutated.close(); }

    await restoreBackup(dataDir, 'Campaign', backup.name);
    const restored = new RoomStore(dataDir, 'Campaign');
    try {
      assert.equal(restored.activeScene, 'battle');
      assert.equal(restored.backgroundFor('battle'), 'black');
      assert.equal(restored.getObjects('battle').some((entry) => entry.id === object.id), true);
      assert.ok(restored.getAsset('battle-art'));
    } finally { restored.close(); }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
