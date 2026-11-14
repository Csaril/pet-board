import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import WebSocket from 'ws';
import type { AppConfig } from './config.js';
import { buildServer } from './index.js';
import { RoomStore } from './store.js';

function configFor(dataDir: string): AppConfig {
  return {
    host: '127.0.0.1', port: 0, dataDir, roomName: 'Campaign', roomCode: 'room-code-with-enough-length',
    gmPassword: 'gm-password-with-enough-length', sessionDays: 30, cookieSecure: false, maxUploadBytes: 1024,
  };
}

function nextMessage(socket: WebSocket, predicate: (message: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { socket.off('message', listener); reject(new Error('WebSocket response timeout')); }, 3000);
    const listener = (raw: WebSocket.RawData) => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (!predicate(message)) return;
      clearTimeout(timeout); socket.off('message', listener); resolve(message);
    };
    socket.on('message', listener);
  });
}

async function command(socket: WebSocket, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const requestId = String(payload.requestId);
  const result = nextMessage(socket, (message) => message.type === 'command:result' && message.requestId === requestId);
  socket.send(JSON.stringify(payload));
  return result;
}

test('the battle map is a Nechronica capability and is absent from a PbtA snapshot', () => {
  const pbtaDir = mkdtempSync(join(tmpdir(), 'tabletop-cap-pbta-'));
  const nechDir = mkdtempSync(join(tmpdir(), 'tabletop-cap-nech-'));
  const pbta = new RoomStore(pbtaDir, 'PbtA');
  const nech = new RoomStore(nechDir, 'Nechronica');
  try {
    pbta.initializeSystem('pbta-2d6', '1.0.0');
    nech.initializeSystem('nechronica', '1.0.0');
    assert.equal(pbta.roomSystem.capabilities.battleMap, false);
    assert.equal(nech.roomSystem.capabilities.battleMap, true);
    assert.throws(() => pbta.setActiveScene('battle'), /BATTLE_MAP_UNAVAILABLE/);
    assert.equal(pbta.activeScene, 'board');
    const pbtaSnapshot = pbta.snapshot('gm');
    assert.equal(pbtaSnapshot.system.capabilities.battleMap, false);
    assert.equal(pbtaSnapshot.activeScene, 'board');
    assert.equal(pbtaSnapshot.battle, undefined);

    nech.setActiveScene('battle');
    const nechSnapshot = nech.snapshot('gm');
    assert.equal(nechSnapshot.system.capabilities.battleMap, true);
    assert.equal(nechSnapshot.activeScene, 'battle');
    assert.ok(nechSnapshot.battle);
  } finally {
    pbta.close();
    nech.close();
    rmSync(pbtaDir, { recursive: true, force: true });
    rmSync(nechDir, { recursive: true, force: true });
  }
});

test('a legacy PbtA room with active battle data returns to the board without deleting the scene', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tabletop-cap-legacy-'));
  try {
    let store = new RoomStore(dataDir, 'Legacy PbtA');
    store.initializeSystem('pbta-2d6', '1.0.0');
    const battleLayer = store.getLayers('battle')[0]!;
    store.createAsset({ id: 'legacy-battle-art', sha256: 'legacy-hash', mimeType: 'image/png', originalName: 'battle.png', size: 4, width: 1, height: 1 });
    store.createObject({
      id: 'legacy-battle-object', assetId: 'legacy-battle-art', layerId: battleLayer.id, x: 1, y: 2, width: 3, height: 4,
      orderIndex: 0, flipX: false, flipY: false, crop: null, allowPlayerMove: false, freeStretch: false,
    });
    // Simulate an old database that still pointed the room at the battle scene.
    store.db.prepare("UPDATE room SET active_scene = 'battle' WHERE id = 1").run();
    store.close();

    store = new RoomStore(dataDir, 'Legacy PbtA');
    try {
      assert.equal(store.activeScene, 'board');
      assert.equal(store.roomSystem.capabilities.battleMap, false);
      assert.equal(store.snapshot('gm').activeScene, 'board');
      assert.equal(store.snapshot('gm').battle, undefined);
      // The scene itself and its objects are preserved for a future system move.
      assert.ok(store.getLayers('battle').some((layer) => layer.id === battleLayer.id));
      assert.ok(store.getObject('legacy-battle-object'));
      assert.ok(store.getAsset('legacy-battle-art'));
    } finally { store.close(); }
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('PbtA rejects battle-scene commands over WebSocket and ignores spoofed capabilities', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tabletop-cap-ws-'));
  const config = configFor(dataDir);
  const store = new RoomStore(dataDir, config.roomName);
  store.initializeSystem('pbta-2d6', '1.0.0');
  const app = await buildServer({ config, store, logger: false });
  const sockets: WebSocket[] = [];
  try {
    const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    const { host } = new URL(baseUrl);
    const origin = `http://${host}`;
    const login = await app.inject({
      method: 'POST', url: '/api/session', headers: { origin, host },
      payload: { name: 'Keeper', role: 'gm', roomCode: config.roomCode, gmPassword: config.gmPassword },
    });
    assert.equal(login.statusCode, 200);
    const cookie = (login.headers['set-cookie'] as string).split(';')[0]!;

    const board = await app.inject({ method: 'GET', url: '/api/board', headers: { origin, host, cookie } });
    assert.equal(board.statusCode, 200);
    const snapshot = board.json() as { system: { capabilities: { battleMap: boolean } }; battle?: unknown; activeScene: string };
    assert.equal(snapshot.system.capabilities.battleMap, false);
    assert.equal(snapshot.battle, undefined);
    assert.equal(snapshot.activeScene, 'board');

    const socket = new WebSocket(`ws://${host}/ws`, { headers: { origin, cookie } });
    sockets.push(socket);
    const state = nextMessage(socket, (message) => message.type === 'room:state');
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    await state;

    const direct = await command(socket, { type: 'room:scene:set', scene: 'battle', requestId: 'direct' });
    assert.equal(direct.ok, false);
    assert.equal(direct.code, 'SYSTEM_MISMATCH');

    const spoofed = await command(socket, {
      type: 'room:scene:set', scene: 'battle', requestId: 'spoofed',
      systemId: 'nechronica', capabilities: { battleMap: true },
    });
    assert.equal(spoofed.ok, false);
    assert.equal(store.activeScene, 'board');

    const background = await command(socket, { type: 'room:background:set', scene: 'battle', background: 'black', requestId: 'background' });
    assert.equal(background.ok, false);
    assert.equal(background.code, 'SYSTEM_MISMATCH');

    const systemChange = await command(socket, { type: 'room:system:set', systemId: 'nechronica', requestId: 'system' });
    assert.equal(systemChange.ok, false);
    assert.equal(systemChange.code, 'ROOM_SYSTEM_IMMUTABLE');
    assert.equal(store.roomSystem.id, 'pbta-2d6');
  } finally {
    for (const socket of sockets) socket.close();
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
