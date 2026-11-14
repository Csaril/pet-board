import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile, unlink as unlinkFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { deflateSync } from 'node:zlib';
import Database from 'better-sqlite3';
import WebSocket from 'ws';
import type { AppConfig } from './config.js';
import { deleteImageAsset } from './assets.js';
import { executeBoardCommand } from './board.js';
import { buildServer } from './index.js';
import { executeSheetCommand } from './sheets.js';
import { RoomStore } from './store.js';

function pngFixture(red = 180): Buffer {
  const crc32 = (bytes: Buffer) => {
    let crc = 0xffffffff;
    for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1; }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (name: string, data: Buffer) => {
    const type = Buffer.from(name); const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([type, data])));
    return Buffer.concat([length, type, data, crc]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([0, red, 45, 60, 255]))), chunk('IEND', Buffer.alloc(0)),
  ]);
}

function multipart(boundary: string, filename: string, mime: string, data: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`),
    data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
}

function configFor(dataDir: string): AppConfig {
  return {
    host: '127.0.0.1', port: 0, dataDir, roomName: 'Campaign', roomCode: 'room-code-with-enough-length',
    gmPassword: 'gm-password-with-enough-length', sessionDays: 30, cookieSecure: false, maxUploadBytes: 25 * 1024 * 1024,
  };
}

function nextMessage(socket: WebSocket, predicate: (message: Record<string, unknown>) => boolean, label = 'WebSocket message'): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { socket.off('message', listener); reject(new Error(`${label} timeout`)); }, 3000);
    const listener = (raw: WebSocket.RawData) => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (!predicate(message)) return;
      clearTimeout(timeout); socket.off('message', listener); resolve(message);
    };
    socket.on('message', listener);
  });
}

const gm = { participantId: 'gm-session', name: 'Keeper', role: 'gm' as const };
const player = { participantId: 'player-session', name: 'Ari', role: 'player' as const };

test('board background scenarios 1-4: GM switch, broadcast, restart and player denial', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tabletop-background-'));
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
    const gmCookie = await login('Keeper', 'gm');
    const playerCookie = await login('Ari', 'player');
    const gmConnection = await connect(gmCookie);
    const playerConnection = await connect(playerCookie);
    assert.equal(gmConnection.state.background, 'gray');

    await t.test('1. GM can switch the background', async () => {
      const playerState = nextMessage(playerConnection.socket, (message) => message.type === 'room:state' && message.background === 'black', 'player background update');
      const acknowledgement = nextMessage(gmConnection.socket, (message) => message.type === 'command:result' && message.requestId === 'background-black', 'background ack');
      gmConnection.socket.send(JSON.stringify({ type: 'room:background:set', requestId: 'background-black', background: 'black' }));
      assert.equal((await acknowledgement).ok, true);
      await playerState;
      assert.equal(store.boardBackground, 'black');
    });

    await t.test('2. All players receive the shared background update', async () => {
      const gmState = nextMessage(gmConnection.socket, (message) => message.type === 'room:state' && message.background === 'black', 'GM background projection');
      const playerState = nextMessage(playerConnection.socket, (message) => message.type === 'room:state' && message.background === 'black', 'player background projection');
      const acknowledgement = nextMessage(gmConnection.socket, (message) => message.type === 'command:result' && message.requestId === 'background-second', 'second background ack');
      gmConnection.socket.send(JSON.stringify({ type: 'room:background:set', requestId: 'background-second', background: 'black' }));
      assert.equal((await acknowledgement).ok, true);
      assert.equal((await gmState).background, 'black');
      assert.equal((await playerState).background, 'black');
    });

    await t.test('4. A player cannot change the shared background', async () => {
      const acknowledgement = nextMessage(playerConnection.socket, (message) => message.type === 'command:result' && message.requestId === 'player-background', 'player background denial');
      playerConnection.socket.send(JSON.stringify({ type: 'room:background:set', requestId: 'player-background', background: 'gray' }));
      const result = await acknowledgement;
      assert.equal(result.ok, false);
      assert.match(String(result.error), /только ведущий/i);
      assert.equal(store.boardBackground, 'black');
    });

    await t.test('3. The selected background is restored after restart', async () => {
      for (const socket of sockets) socket.close();
      await app.close();
      const reopened = new RoomStore(dataDir, config.roomName);
      try { assert.equal(reopened.boardBackground, 'black'); }
      finally { reopened.close(); }
    });
  } finally {
    for (const socket of sockets) if (socket.readyState !== WebSocket.CLOSED) socket.close();
    if (!app.server.listening) { /* app was already closed by scenario 3 */ }
    else await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('legacy rooms and note markers migrate without losing the default background or marker size', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tabletop-feature-migration-'));
  const legacy = new Database(join(dataDir, 'room.sqlite'));
  legacy.exec(`
    CREATE TABLE room (id INTEGER PRIMARY KEY CHECK (id = 1), name TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    INSERT INTO room (id, name) VALUES (1, 'Legacy');
    CREATE TABLE board_layers (id TEXT PRIMARY KEY, name TEXT NOT NULL, order_index INTEGER NOT NULL, visible INTEGER NOT NULL, locked INTEGER NOT NULL, audience TEXT NOT NULL);
    INSERT INTO board_layers VALUES ('layer-legacy', 'Main', 0, 1, 0, 'all-players');
    CREATE TABLE assets (id TEXT PRIMARY KEY, sha256 TEXT NOT NULL, mime_type TEXT NOT NULL, original_name TEXT NOT NULL, size INTEGER NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    INSERT INTO assets (id, sha256, mime_type, original_name, size, width, height) VALUES ('legacy-marker-asset', 'legacy-marker-hash', 'image/png', 'legacy.png', 10, 400, 200);
    CREATE TABLE notes (id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, access TEXT NOT NULL, selected_participant_ids TEXT NOT NULL DEFAULT '[]', marker_type TEXT NOT NULL DEFAULT 'text', marker_text TEXT, marker_asset_id TEXT REFERENCES assets(id), created_by TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    INSERT INTO notes (id, title, body, access, created_by, marker_type, marker_asset_id) VALUES ('legacy-note', 'Legacy marker', '', 'all-players', 'legacy-gm', 'image', 'legacy-marker-asset');
    CREATE TABLE note_markers (id TEXT PRIMARY KEY, note_id TEXT NOT NULL UNIQUE REFERENCES notes(id) ON DELETE CASCADE, layer_id TEXT NOT NULL REFERENCES board_layers(id), x REAL NOT NULL, y REAL NOT NULL, order_index INTEGER NOT NULL);
    INSERT INTO note_markers (id, note_id, layer_id, x, y, order_index) VALUES ('legacy-marker', 'legacy-note', 'layer-legacy', 10, 20, 0);
  `);
  legacy.close();
  const store = new RoomStore(dataDir, 'Ignored');
  try {
    assert.equal(store.boardBackground, 'gray');
    const marker = store.getNoteMarker('legacy-marker');
    assert.deepEqual({ width: marker?.width, height: marker?.height }, { width: 84, height: 42 });
  } finally { store.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test('character sheet scenarios 5-9: delete only unassigned sheets as GM and keep library images', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tabletop-sheet-delete-'));
  const store = new RoomStore(dataDir, 'Campaign');
  store.initializeSystem('pbta-2d6', '1.0.0');
  const sheetInput = (id: string, assignedPlayerId: string | null = null) => ({
    id, creatorId: gm.participantId, creatorName: gm.name, assignedPlayerId,
    assignedPlayerName: assignedPlayerId ? player.name : null, systemId: 'pbta-2d6', systemVersion: '1.0.0', schemaVersion: 1,
    characterName: 'Prepared', portraitAssetId: 'shared-image',
    characteristics: { might: 1, insight: 2, glory: 3, will: 4 }, fate: 5,
  });
  try {
    store.createAsset({ id: 'shared-image', sha256: 'shared-hash', mimeType: 'image/png', originalName: 'shared.png', size: 20, width: 4, height: 3 });
    store.createSheet(sheetInput('prepared-sheet'));
    store.createCounter('prepared-sheet', { id: 'prepared-counter', name: 'Charges', value: 2 });
    store.createAbility('prepared-sheet', {
      id: 'prepared-ability', name: 'Ability', description: 'Uses an image', assetId: 'shared-image',
      counterEnabled: true, counterName: 'Uses', counterValue: 1, checkboxEnabled: false, checkboxLabel: '', checked: false,
    });

    assert.doesNotThrow(() => executeSheetCommand(store, gm, { type: 'sheet:delete', id: 'prepared-sheet' }));
    assert.equal(store.getSheet('prepared-sheet'), undefined);
    assert.equal((store.db.prepare('SELECT COUNT(*) AS count FROM character_counters WHERE sheet_id = ?').get('prepared-sheet') as { count: number }).count, 0);
    assert.equal((store.db.prepare('SELECT COUNT(*) AS count FROM character_abilities WHERE sheet_id = ?').get('prepared-sheet') as { count: number }).count, 0);
    assert.ok(store.getAsset('shared-image'));

    store.createSheet(sheetInput('assigned-sheet', player.participantId));
    assert.throws(() => executeSheetCommand(store, gm, { type: 'sheet:delete', id: 'assigned-sheet' }), /назначен/i);
    assert.ok(store.getSheet('assigned-sheet'));
    store.assignSheet('assigned-sheet', null, null);
    store.createSheet(sheetInput('player-target'));
    assert.throws(() => executeSheetCommand(store, player, { type: 'sheet:delete', id: 'player-target' }), /только ведущий/i);
    assert.ok(store.getSheet('player-target'));
  } finally { store.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test('asset library scenarios 10-16: complete deletion, reference guards, isolation and rollback', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tabletop-asset-delete-'));
  const config = configFor(dataDir);
  const store = new RoomStore(dataDir, config.roomName);
  store.initializeSystem('pbta-2d6', '1.0.0');
  const app = await buildServer({ config, store, logger: false });
  try {
    const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    const { host } = new URL(baseUrl);
    const origin = `http://${host}`;
    const login = async (name: string, role: 'gm' | 'player') => {
      const response = await app.inject({ method: 'POST', url: '/api/session', headers: { origin, host }, payload: { name, role, roomCode: config.roomCode, gmPassword: role === 'gm' ? config.gmPassword : undefined } });
      assert.equal(response.statusCode, 200);
      return (response.headers['set-cookie'] as string).split(';')[0]!;
    };
    const gmCookie = await login('Keeper', 'gm');
    const playerCookie = await login('Ari', 'player');
    let boundaryCounter = 0;
    const upload = async (cookie: string, filename: string, data: Buffer) => {
      const boundary = `asset-delete-boundary-${boundaryCounter++}`;
      const response = await app.inject({
        method: 'POST', url: '/api/assets', headers: { origin, host, cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload: multipart(boundary, filename, 'image/png', data),
      });
      assert.equal(response.statusCode, 200);
      return response.json().asset as { id: string; originalName: string };
    };
    const deleteRequest = (cookie: string, id: string) => app.inject({ method: 'DELETE', url: `/api/assets/${id}`, headers: { origin, host, cookie } });
    const assetPath = (id: string) => join(dataDir, 'assets', id);

    await t.test('10-12. GM deletes an unused asset, its original and derived files', async () => {
      const asset = await upload(gmCookie, 'unused.png', pngFixture(10));
      assert.equal(existsSync(assetPath(asset.id)), true);
      writeFileSync(`${assetPath(asset.id)}-thumb`, 'thumbnail');
      writeFileSync(`${assetPath(asset.id)}.preview`, 'preview');
      const response = await deleteRequest(gmCookie, asset.id);
      assert.equal(response.statusCode, 204);
      assert.equal(store.getAsset(asset.id), undefined);
      assert.equal(existsSync(assetPath(asset.id)), false);
      assert.equal(existsSync(`${assetPath(asset.id)}-thumb`), false);
      assert.equal(existsSync(`${assetPath(asset.id)}.preview`), false);
    });

    await t.test('13-14. A used asset is blocked by references from every object type', async () => {
      const asset = await upload(gmCookie, 'used.png', pngFixture(30));
      const layer = store.getLayers()[0]!;
      store.createObject({
        id: 'usage-object', assetId: asset.id, layerId: layer.id, x: 0, y: 0, width: 10, height: 10,
        orderIndex: 0, flipX: false, flipY: false, crop: null, allowPlayerMove: false, freeStretch: false,
      });
      store.createNote({
        id: 'usage-note', title: 'Usage', body: '', access: 'all-players', selectedParticipantIds: [], creatorId: gm.participantId,
        assetIds: [asset.id], markerType: 'image', markerAssetId: asset.id,
      });
      store.createNoteMarker({ id: 'usage-marker', noteId: 'usage-note', layerId: layer.id, x: 1, y: 1 });
      store.createSheet({
        id: 'usage-sheet', creatorId: gm.participantId, creatorName: gm.name, assignedPlayerId: null, assignedPlayerName: null,
        systemId: 'pbta-2d6', systemVersion: '1.0.0', schemaVersion: 1, characterName: 'Usage', portraitAssetId: asset.id,
        characteristics: { might: 0, insight: 0, glory: 0, will: 0 }, fate: 0,
      });
      store.createAbility('usage-sheet', {
        id: 'usage-ability', name: 'Usage', description: '', assetId: asset.id,
        counterEnabled: false, counterName: '', counterValue: 0, checkboxEnabled: false, checkboxLabel: '', checked: false,
      });
      const usage = store.getAssetUsage(asset.id);
      assert.deepEqual(usage.map((entry) => entry.kind).sort(), ['board-object', 'note-attachment', 'note-marker', 'sheet-ability', 'sheet-portrait']);
      const usageResponse = await app.inject({ method: 'GET', url: `/api/assets/${asset.id}/usage`, headers: { origin, host, cookie: gmCookie } });
      assert.equal(usageResponse.statusCode, 200);
      assert.equal(usageResponse.json().usage.length, 5);
      const response = await deleteRequest(gmCookie, asset.id);
      assert.equal(response.statusCode, 409);
      assert.equal(response.json().usage.length, 5);
      assert.ok(store.getAsset(asset.id));
      assert.equal(existsSync(assetPath(asset.id)), true);
    });

    await t.test('15. Two different files with the same name do not affect each other', async () => {
      const first = await upload(gmCookie, 'same-name.png', pngFixture(60));
      const second = await upload(gmCookie, 'same-name.png', pngFixture(210));
      assert.notEqual(first.id, second.id);
      assert.equal((await deleteRequest(gmCookie, first.id)).statusCode, 204);
      assert.equal(store.getAsset(first.id), undefined);
      assert.ok(store.getAsset(second.id));
      assert.equal(existsSync(assetPath(first.id)), false);
      assert.equal(existsSync(assetPath(second.id)), true);
    });

    await t.test('server permissions: players cannot delete library assets', async () => {
      const asset = await upload(gmCookie, 'player-delete.png', pngFixture(90));
      const response = await deleteRequest(playerCookie, asset.id);
      assert.equal(response.statusCode, 403);
      assert.ok(store.getAsset(asset.id));
      assert.equal(existsSync(assetPath(asset.id)), true);
    });
  } finally {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('scenario 16: a failed file deletion preserves the database record and original file', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tabletop-asset-rollback-'));
  const store = new RoomStore(dataDir, 'Campaign');
  const id = randomUUID();
  try {
    store.createAsset({ id, sha256: 'rollback-hash', mimeType: 'image/png', originalName: 'rollback.png', size: 4, width: 1, height: 1 });
    const path = join(dataDir, 'assets', id);
    mkdirSync(join(dataDir, 'assets'), { recursive: true });
    await writeFile(path, 'data');
    await assert.rejects(
      deleteImageAsset(store, store.assetsDir, id, {
        unlink: async (candidate) => {
          if (candidate.endsWith(id) || candidate.includes(`${id}.deleting-`)) throw Object.assign(new Error('locked'), { code: 'EACCES' });
          await unlinkFile(candidate);
        },
      }),
      /locked/,
    );
    assert.ok(store.getAsset(id));
    assert.equal(await readFile(path, 'utf8'), 'data');
    await assert.rejects(deleteImageAsset(store, store.assetsDir, '../room.sqlite'), /идентификатор/i);
  } finally { store.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test('note marker resize scenarios 17-20, 22-23: text, image ratio, persistence and locked layers', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tabletop-marker-resize-'));
  let store = new RoomStore(dataDir, 'Campaign');
  const indexSource = readFileSync('src/pages/index.astro', 'utf8');
  const clientSource = readFileSync('src/client/app.ts', 'utf8');
  try {
    const layer = store.getLayers()[0]!;
    store.createAsset({ id: 'marker-image-asset', sha256: 'marker-image-hash', mimeType: 'image/png', originalName: 'marker.png', size: 20, width: 400, height: 200 });
    store.createNote({ id: 'text-note', title: 'Text marker', body: 'No body', access: 'all-players', selectedParticipantIds: [], creatorId: gm.participantId, assetIds: [], markerText: 'A long text marker' });
    store.createNoteMarker({ id: 'text-marker', noteId: 'text-note', layerId: layer.id, x: 10, y: 20 });
    store.createNote({ id: 'image-note', title: 'Image marker', body: '', access: 'all-players', selectedParticipantIds: [], creatorId: gm.participantId, assetIds: [], markerType: 'image', markerAssetId: 'marker-image-asset' });
    store.createNoteMarker({ id: 'image-marker', noteId: 'image-note', layerId: layer.id, x: 30, y: 40 });

    assert.match(indexSource, /id="marker-resize"[^>]*aria-pressed="false">Изменить размер/);
    assert.match(indexSource, /id="marker-edit"[\s\S]*id="marker-resize"[\s\S]*id="marker-delete"/);
    assert.match(clientSource, /markerTransformer = new Konva\.Transformer/);
    assert.match(clientSource, /function setMarkerResizeMode\(active: boolean\)/);
    assert.match(clientSource, /event\.key === 'Escape' && markerResizeMode\) cancelMarkerResize\(\)/);

    executeBoardCommand(store, gm, { type: 'note-marker:update', id: 'text-marker', changes: { width: 220, height: 90 } });
    assert.deepEqual(
      { width: store.getNoteMarker('text-marker')?.width, height: store.getNoteMarker('text-marker')?.height },
      { width: 220, height: 90 },
    );
    assert.throws(() => executeBoardCommand(store, gm, { type: 'note-marker:update', id: 'text-marker', changes: { width: 20 } }), /минимальная ширина/i);
    assert.throws(() => executeBoardCommand(store, gm, { type: 'note-marker:update', id: 'text-marker', changes: { height: 10 } }), /минимальная высота/i);

    executeBoardCommand(store, gm, { type: 'note-marker:update', id: 'image-marker', changes: { width: 200, height: 40 } });
    assert.deepEqual(
      { width: store.getNoteMarker('image-marker')?.width, height: store.getNoteMarker('image-marker')?.height },
      { width: 200, height: 100 },
    );

    store.updateLayer(layer.id, { locked: true });
    assert.throws(() => executeBoardCommand(store, gm, { type: 'note-marker:update', id: 'text-marker', changes: { width: 240 } }), /заблокирован/i);
    assert.equal(store.getNoteMarker('text-marker')?.width, 220);
    assert.throws(() => executeBoardCommand(store, player, { type: 'note-marker:update', id: 'text-marker', changes: { width: 240 } }), /только ведущему/i);
    store.updateLayer(layer.id, { locked: false });

    assert.match(clientSource, /wrap: 'word'/);
    assert.match(clientSource, /if \(!markerResizeMode\) void openNote\(marker\.noteId\)/);
    assert.doesNotMatch(clientSource, /noteDialog\.style\.(width|height)/);

    store.close();
    store = new RoomStore(dataDir, 'Campaign');
    assert.deepEqual(
      { width: store.getNoteMarker('text-marker')?.width, height: store.getNoteMarker('text-marker')?.height },
      { width: 220, height: 90 },
    );
    assert.deepEqual(
      { width: store.getNoteMarker('image-marker')?.width, height: store.getNoteMarker('image-marker')?.height },
      { width: 200, height: 100 },
    );
  } finally { store.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test('scenario 21: marker size changes synchronize to every participant over WebSocket', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tabletop-marker-sync-'));
  const config = configFor(dataDir);
  const store = new RoomStore(dataDir, config.roomName);
  const layer = store.getLayers()[0]!;
  store.createNote({ id: 'sync-note', title: 'Sync marker', body: '', access: 'all-players', selectedParticipantIds: [], creatorId: gm.participantId, assetIds: [], markerText: 'Sync' });
  store.createNoteMarker({ id: 'sync-marker', noteId: 'sync-note', layerId: layer.id, x: 10, y: 10 });
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
      await state;
      return socket;
    };
    const gmSocket = await connect(await login('Keeper', 'gm'));
    const playerSocket = await connect(await login('Ari', 'player'));
    const playerState = nextMessage(playerSocket, (message) => {
      const markers = message.noteMarkers as Array<{ id: string; width: number; height: number }> | undefined;
      return message.type === 'room:state' && markers?.some((marker) => marker.id === 'sync-marker' && marker.width === 240 && marker.height === 80) === true;
    }, 'synchronized marker size');
    const acknowledgement = nextMessage(gmSocket, (message) => message.type === 'command:result' && message.requestId === 'resize-marker', 'marker resize ack');
    gmSocket.send(JSON.stringify({ type: 'note-marker:update', requestId: 'resize-marker', id: 'sync-marker', changes: { width: 240, height: 80 } }));
    assert.equal((await acknowledgement).ok, true);
    const state = await playerState;
    const marker = (state.noteMarkers as Array<{ id: string; width: number; height: number }>).find((entry) => entry.id === 'sync-marker')!;
    assert.deepEqual({ width: marker.width, height: marker.height }, { width: 240, height: 80 });

    const denied = nextMessage(playerSocket, (message) => message.type === 'command:result' && message.requestId === 'player-resize', 'player resize denial');
    playerSocket.send(JSON.stringify({ type: 'note-marker:update', requestId: 'player-resize', id: 'sync-marker', changes: { width: 300 } }));
    assert.equal((await denied).ok, false);
  } finally {
    for (const socket of sockets) if (socket.readyState !== WebSocket.CLOSED) socket.close();
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('new controls are documented in the GM-only UI', () => {
  const indexSource = readFileSync('src/pages/index.astro', 'utf8');
  const clientSource = readFileSync('src/client/app.ts', 'utf8');
  assert.match(indexSource, /class="board-background-control gm-only"[^>]*>\s*Фон\s*<select id="board-background"><option value="gray">Серый<\/option><option value="black">Чёрный<\/option>/);
  assert.match(indexSource, /id="asset-delete-dialog"/);
  assert.match(indexSource, /id="asset-delete-thumb"/);
  assert.match(clientSource, /Содержимое листа будет удалено без возможности восстановления из приложения/);
  assert.match(clientSource, /ASSET_USAGE_LABELS/);
  assert.match(clientSource, /api\/assets\/\$\{encodeURIComponent\(asset\.id\)\}\/usage/);
});
