import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import WebSocket from 'ws';
import { deflateSync } from 'node:zlib';
import type { AppConfig } from './config.js';
import { buildServer } from './index.js';
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
const pngBytes = pngFixture();

function multipart(boundary: string, filename: string, mime: string, data: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`),
    data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
}

function nextSocketMessage(socket: WebSocket, predicate: (message: Record<string, unknown>) => boolean, label = 'WebSocket message'): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { socket.off('message', onMessage); reject(new Error(`Timed out waiting for ${label}.`)); }, 3000);
    const onMessage = (data: WebSocket.RawData) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      if (!predicate(message)) return;
      clearTimeout(timeout);
      socket.off('message', onMessage);
      resolve(message);
    };
    socket.on('message', onMessage);
  });
}

test('HTTP session endpoints enforce origin, set a protected cookie, and restore role', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tabletop-board-http-'));
  const config: AppConfig = {
    host: '127.0.0.1', port: 4321, dataDir, roomName: 'Campaign',
    roomCode: 'room-code-with-enough-length', gmPassword: 'gm-password-with-enough-length',
    sessionDays: 30, cookieSecure: false, maxUploadBytes: 25 * 1024 * 1024,
  };
  const store = new RoomStore(dataDir, config.roomName);
  const app = await buildServer({ config, store, logger: false });
  try {
    const rejectedOrigin = await app.inject({
      method: 'POST', url: '/api/session', headers: { origin: 'https://attacker.invalid' },
      payload: { name: 'Morgan', role: 'player', roomCode: config.roomCode },
    });
    assert.equal(rejectedOrigin.statusCode, 403);

    const login = await app.inject({
      method: 'POST', url: '/api/session', headers: { origin: 'http://localhost:80' },
      payload: { name: 'Morgan', role: 'player', roomCode: config.roomCode },
    });
    assert.equal(login.statusCode, 200);
    assert.deepEqual({ name: login.json().identity.name, role: login.json().identity.role }, { name: 'Morgan', role: 'player' });
    assert.match(login.json().identity.participantId, /^[0-9a-f]{64}$/);
    const cookie = login.headers['set-cookie'];
    assert.equal(typeof cookie, 'string');
    assert.match(cookie as string, /HttpOnly/);
    assert.match(cookie as string, /SameSite=Strict/i);

    const restored = await app.inject({ method: 'GET', url: '/api/session', headers: { cookie: (cookie as string).split(';')[0] } });
    assert.equal(restored.statusCode, 200);
    assert.deepEqual({ name: restored.json().identity.name, role: restored.json().identity.role }, { name: 'Morgan', role: 'player' });
    const logout = await app.inject({
      method: 'DELETE', url: '/api/session', headers: { origin: 'http://localhost:80', cookie: (cookie as string).split(';')[0] },
    });
    assert.equal(logout.statusCode, 204);
    const expired = await app.inject({ method: 'GET', url: '/api/session', headers: { cookie: (cookie as string).split(';')[0] } });
    assert.equal(expired.statusCode, 401);
  } finally {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('note HTTP endpoints keep bodies out of board state and enforce audience access', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tabletop-board-note-api-'));
  const config: AppConfig = {
    host: '127.0.0.1', port: 0, dataDir, roomName: 'Campaign',
    roomCode: 'room-code-with-enough-length', gmPassword: 'gm-password-with-enough-length',
    sessionDays: 30, cookieSecure: false, maxUploadBytes: 25 * 1024 * 1024,
  };
  const store = new RoomStore(dataDir, config.roomName);
  const app = await buildServer({ config, store, logger: false });
  try {
    const login = async (name: string, role: 'gm' | 'player') => {
      const response = await app.inject({ method: 'POST', url: '/api/session', headers: { origin: 'http://localhost:80' }, payload: { name, role, roomCode: config.roomCode, gmPassword: role === 'gm' ? config.gmPassword : undefined } });
      assert.equal(response.statusCode, 200);
      return { cookie: (response.headers['set-cookie'] as string).split(';')[0]!, identity: response.json().identity as { participantId: string } };
    };
    const gm = await login('Keeper', 'gm'); const ari = await login('Ari', 'player'); const bea = await login('Bea', 'player');
    const boundary = 'note-image-boundary';
    const uploaded = await app.inject({ method: 'POST', url: '/api/assets', headers: { origin: 'http://localhost:80', cookie: gm.cookie, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: multipart(boundary, 'note.png', 'image/png', pngBytes) });
    assert.equal(uploaded.statusCode, 200);
    const assetId = uploaded.json().asset.id as string;
    const secondBoundary = 'note-image-boundary-second';
    const secondUploaded = await app.inject({ method: 'POST', url: '/api/assets', headers: { origin: 'http://localhost:80', cookie: gm.cookie, 'content-type': `multipart/form-data; boundary=${secondBoundary}` }, payload: multipart(secondBoundary, 'note-second.png', 'image/png', pngFixture(90)) });
    assert.equal(secondUploaded.statusCode, 200);
    const secondAssetId = secondUploaded.json().asset.id as string;
    const create = async (access: string, selectedParticipantIds: string[] = [], extra: Record<string, unknown> = {}) => app.inject({
      method: 'POST', url: '/api/notes', headers: { origin: 'http://localhost:80', cookie: gm.cookie },
      payload: { title: `Note ${access}`, body: 'private-body-marker', access, selectedParticipantIds, assetIds: [], ...extra },
    });
    const all = await create('all-players', [], { markerType: 'image', markerAssetId: assetId, assetIds: [assetId, secondAssetId] }); assert.equal(all.statusCode, 200);
    assert.deepEqual(all.json().note.assetIds, [assetId, secondAssetId]);
    const selected = await create('selected-players', [ari.identity.participantId]); assert.equal(selected.statusCode, 200);
    const privateNote = await create('gm-only', [], { markerType: 'image', markerAssetId: assetId }); assert.equal(privateNote.statusCode, 200);
    const ids = [all.json().note.id, selected.json().note.id, privateNote.json().note.id] as string[];
    const publicLayer = store.getLayers()[0]!;
    store.createNoteMarker({ id: 'public-note-marker', noteId: ids[0]!, layerId: publicLayer.id, x: 30, y: 40 });
    store.createNoteMarker({ id: 'private-note-marker', noteId: ids[2]!, layerId: publicLayer.id, x: 50, y: 60 });
    const gmBoard = await app.inject({ method: 'GET', url: '/api/board', headers: { cookie: gm.cookie } });
    assert.equal(gmBoard.body.includes('private-body-marker'), false);
    assert.equal(gmBoard.json().noteMarkers.length, 2);
    const ariBoard = await app.inject({ method: 'GET', url: '/api/board', headers: { cookie: ari.cookie } });
    assert.equal(ariBoard.body.includes('private-body-marker'), false);
    assert.deepEqual(ariBoard.json().noteMarkers.map((marker: { id: string }) => marker.id), ['public-note-marker']);
    assert.equal(ariBoard.json().noteMarkers[0].type, 'image');
    const reloadedWithImages = await app.inject({ method: 'GET', url: `/api/notes/${ids[0]}`, headers: { cookie: bea.cookie } });
    assert.equal(reloadedWithImages.statusCode, 200);
    assert.deepEqual(reloadedWithImages.json().note.assetIds, [assetId, secondAssetId]);
    assert.equal((await app.inject({ method: 'GET', url: `/api/notes/${ids[1]}`, headers: { cookie: ari.cookie } })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: `/api/notes/${ids[1]}`, headers: { cookie: bea.cookie } })).statusCode, 404);
    assert.equal((await app.inject({ method: 'GET', url: `/api/notes/${ids[2]}`, headers: { cookie: ari.cookie } })).statusCode, 404);
    assert.equal((await app.inject({ method: 'GET', url: `/api/assets/${assetId}`, headers: { cookie: ari.cookie } })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/api/notes', headers: { cookie: ari.cookie } })).statusCode, 403);
    const noOrigin = await app.inject({ method: 'PUT', url: `/api/notes/${ids[0]}`, headers: { cookie: gm.cookie }, payload: { title: 'changed', body: '', access: 'gm-only', selectedParticipantIds: [], assetIds: [] } });
    assert.equal(noOrigin.statusCode, 403);
    const removeAttachment = await app.inject({ method: 'PUT', url: `/api/notes/${ids[0]}`, headers: { origin: 'http://localhost:80', cookie: gm.cookie }, payload: { title: 'Changed', body: '', access: 'gm-only', selectedParticipantIds: [], assetIds: [], markerType: 'text', markerText: '' } });
    assert.equal(removeAttachment.statusCode, 200);
    assert.ok(store.getAsset(assetId));
    assert.ok(store.getAsset(secondAssetId));
    assert.deepEqual(removeAttachment.json().note.assetIds, []);
    assert.equal((await app.inject({ method: 'GET', url: `/api/assets/${assetId}`, headers: { cookie: ari.cookie } })).statusCode, 404);
  } finally { await app.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test('GM and two player sessions connect over WebSocket and a player session can reconnect', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tabletop-board-ws-'));
  const config: AppConfig = {
    host: '127.0.0.1', port: 0, dataDir, roomName: 'Campaign',
    roomCode: 'room-code-with-enough-length', gmPassword: 'gm-password-with-enough-length',
    sessionDays: 30, cookieSecure: false, maxUploadBytes: 25 * 1024 * 1024,
  };
  const store = new RoomStore(dataDir, config.roomName);
  const app = await buildServer({ config, store, logger: false });
  const activeSockets: WebSocket[] = [];
  try {
    const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    const address = new URL(baseUrl);
    const host = address.host;
    const origin = `http://${host}`;
    const home = await app.inject({ method: 'GET', url: '/' });
    assert.equal(home.statusCode, 200);
    assert.match(home.body, /Подключиться к комнате/);
    const login = async (name: string, role: 'gm' | 'player') => {
      const response = await app.inject({
        method: 'POST', url: '/api/session', headers: { origin, host },
        payload: { name, role, roomCode: config.roomCode, gmPassword: role === 'gm' ? config.gmPassword : undefined },
      });
      assert.equal(response.statusCode, 200);
      return (response.headers['set-cookie'] as string).split(';')[0];
    };
    const connect = (cookie: string) => new Promise<{ socket: WebSocket; state: { identity: { participantId: string; name: string; role: string }; participants: unknown[] } }>((resolve, reject) => {
      const socket = new WebSocket(`ws://${host}/ws`, { headers: { origin, cookie } });
      activeSockets.push(socket);
      socket.once('error', reject);
      socket.once('message', (data) => resolve({ socket, state: JSON.parse(data.toString()) }));
    });

    const gmCookie = await login('Keeper', 'gm');
    const firstPlayerCookie = await login('Ari', 'player');
    const secondPlayerCookie = await login('Bea', 'player');
    const gm = await connect(gmCookie);
    const firstPlayer = await connect(firstPlayerCookie);
    const participantUpdates = Promise.all([
      nextSocketMessage(gm.socket, (message) => message.type === 'room:state' && Array.isArray(message.participants) && message.participants.length === 3, 'GM participant update'),
      nextSocketMessage(firstPlayer.socket, (message) => message.type === 'room:state' && Array.isArray(message.participants) && message.participants.length === 3, 'player participant update'),
    ]);
    const secondPlayer = await connect(secondPlayerCookie);
    assert.deepEqual({ name: gm.state.identity.name, role: gm.state.identity.role }, { name: 'Keeper', role: 'gm' });
    assert.deepEqual({ name: firstPlayer.state.identity.name, role: firstPlayer.state.identity.role }, { name: 'Ari', role: 'player' });
    assert.deepEqual({ name: secondPlayer.state.identity.name, role: secondPlayer.state.identity.role }, { name: 'Bea', role: 'player' });
    assert.equal(secondPlayer.state.participants.length, 3);
    await participantUpdates;

    const privateLayerMessage = nextSocketMessage(gm.socket, (message) => message.type === 'command:result' && message.requestId === 'private-layer', 'private layer acknowledgement');
    const gmPrivateProjection = nextSocketMessage(gm.socket, (message) => Boolean(message.type === 'room:state' && (message.layers as Array<{ name: string }> | undefined)?.some((layer) => layer.name === 'GM secrets')), 'GM private projection');
    const playerPrivateProjection = nextSocketMessage(firstPlayer.socket, (message) => message.type === 'room:state' && Array.isArray(message.participants) && message.participants.length === 3, 'player private projection');
    gm.socket.send(JSON.stringify({ type: 'layer:create', requestId: 'private-layer', name: 'GM secrets', audience: 'gm-only' }));
    assert.equal((await privateLayerMessage).ok, true);
    assert.equal(((await gmPrivateProjection).layers as Array<{ name: string }>).some((layer) => layer.name === 'GM secrets'), true);
    const playerProjection = await playerPrivateProjection;
    assert.equal((playerProjection.layers as Array<{ name: string }>).some((layer) => layer.name === 'GM secrets'), false);

    const publicLayer = store.getLayers().find((layer) => layer.audience === 'all-players')!;
    store.createAsset({ id: 'test-asset', sha256: 'test-hash', mimeType: 'image/png', originalName: 'test.png', size: 40, width: 4, height: 3 });
    const createAck = nextSocketMessage(gm.socket, (message) => message.type === 'command:result' && message.requestId === 'create-object', 'object create acknowledgement');
    const newObjectMessage = nextSocketMessage(firstPlayer.socket, (message) => message.type === 'room:state' && Array.isArray(message.objects) && message.objects.length === 1, 'new public object projection');
    gm.socket.send(JSON.stringify({ type: 'object:create', requestId: 'create-object', assetId: 'test-asset', layerId: publicLayer.id, x: 12, y: 24 }));
    assert.equal((await createAck).ok, true);
    const updatedPlayerState = await newObjectMessage;
    const boardObject = (updatedPlayerState.objects as Array<{ id: string; x: number; allowPlayerMove: boolean }>)[0]!;
    assert.equal(boardObject.x, 12);
    assert.equal(boardObject.allowPlayerMove, false);

    const deniedMove = nextSocketMessage(firstPlayer.socket, (message) => message.type === 'command:result' && message.requestId === 'forbidden-move', 'denied player move');
    firstPlayer.socket.send(JSON.stringify({ type: 'object:update', requestId: 'forbidden-move', id: boardObject.id, changes: { x: 999 } }));
    assert.equal((await deniedMove).ok, false);
    const enableMoveAck = nextSocketMessage(gm.socket, (message) => message.type === 'command:result' && message.requestId === 'enable-move', 'move permission acknowledgement');
    const movableState = nextSocketMessage(firstPlayer.socket, (message) => message.type === 'room:state' && Array.isArray(message.objects) && (message.objects as Array<{ allowPlayerMove: boolean }>)[0]?.allowPlayerMove === true, 'movable object projection');
    gm.socket.send(JSON.stringify({ type: 'object:update', requestId: 'enable-move', id: boardObject.id, changes: { allowPlayerMove: true } }));
    assert.equal((await enableMoveAck).ok, true);
    await movableState;
    const allowedMoveAck = nextSocketMessage(firstPlayer.socket, (message) => message.type === 'command:result' && message.requestId === 'allowed-move', 'allowed move acknowledgement');
    const movedState = nextSocketMessage(secondPlayer.socket, (message) => message.type === 'room:state' && Array.isArray(message.objects) && (message.objects as Array<{ x: number }>)[0]?.x === 999, 'synchronized moved object');
    firstPlayer.socket.send(JSON.stringify({ type: 'object:update', requestId: 'allowed-move', id: boardObject.id, changes: { x: 999 } }));
    assert.equal((await allowedMoveAck).ok, true);
    await movedState;

    const cropAck = nextSocketMessage(gm.socket, (message) => message.type === 'command:result' && message.requestId === 'shared-crop', 'crop update acknowledgement');
    const firstCroppedProjection = nextSocketMessage(firstPlayer.socket, (message) => message.type === 'room:state' && (message.objects as Array<{ crop?: { x: number }; width?: number }> | undefined)?.[0]?.crop?.x === 0.25, 'first player cropped object');
    const secondCroppedProjection = nextSocketMessage(secondPlayer.socket, (message) => message.type === 'room:state' && (message.objects as Array<{ crop?: { x: number }; width?: number }> | undefined)?.[0]?.crop?.x === 0.25, 'second player cropped object');
    gm.socket.send(JSON.stringify({ type: 'object:update', requestId: 'shared-crop', id: boardObject.id, changes: { crop: { x: 0.25, y: 0, width: 0.5, height: 1 }, width: 8, height: 6 } }));
    assert.equal((await cropAck).ok, true);
    for (const state of await Promise.all([firstCroppedProjection, secondCroppedProjection])) {
      const projected = (state.objects as Array<{ crop: { x: number; width: number }; width: number; height: number }>)[0]!;
      assert.deepEqual(projected.crop, { x: 0.25, y: 0, width: 0.5, height: 1 });
      assert.deepEqual({ width: projected.width, height: projected.height }, { width: 8, height: 6 });
    }

    const oldSocketClosed = new Promise<void>((resolve) => firstPlayer.socket.once('close', () => resolve()));
    firstPlayer.socket.close();
    await oldSocketClosed;
    const restoredPlayer = await connect(firstPlayerCookie);
    assert.deepEqual({ name: restoredPlayer.state.identity.name, role: restoredPlayer.state.identity.role }, { name: 'Ari', role: 'player' });
  } finally {
    await Promise.all(activeSockets.map((socket) => new Promise<void>((resolve) => {
      if (socket.readyState === WebSocket.CLOSED) return resolve();
      socket.once('close', () => resolve());
      socket.close();
    })));
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('WebSocket requires an allowed Origin and an authenticated session', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tabletop-board-ws-origin-'));
  const baseConfig: AppConfig = {
    host: '127.0.0.1', port: 0, dataDir, roomName: 'Campaign',
    roomCode: 'K7M2R9TX', gmPassword: 'quiet-forest', sessionDays: 30,
    cookieSecure: false, maxUploadBytes: 25 * 1024 * 1024,
  };
  const publicOrigin = 'https://demo.ngrok-free.app';
  const store = new RoomStore(dataDir, baseConfig.roomName);
  const app = await buildServer({ config: { ...baseConfig, publicOrigins: [publicOrigin] }, store, logger: false });
  const sockets: WebSocket[] = [];
  try {
    const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    const host = new URL(baseUrl).host;
    const login = await app.inject({
      method: 'POST', url: '/api/session', headers: { origin: publicOrigin, host },
      payload: { name: 'Keeper', role: 'gm', roomCode: baseConfig.roomCode, gmPassword: baseConfig.gmPassword },
    });
    assert.equal(login.statusCode, 200);
    const cookie = (login.headers['set-cookie'] as string).split(';')[0];

    const rejected = (origin: string | undefined, headers: Record<string, string> = {}): Promise<{ code: number; reason: string }> => new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://${host}/ws`, { headers: { ...(origin ? { origin } : {}), ...headers } });
      sockets.push(socket);
      socket.once('error', reject);
      socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    });

    assert.deepEqual(await rejected('https://attacker.invalid', { cookie }), { code: 1008, reason: 'Origin not allowed' });
    assert.deepEqual(await rejected(publicOrigin), { code: 1008, reason: 'Authentication required' });
  } finally {
    await Promise.all(sockets.map((socket) => new Promise<void>((resolve) => {
      if (socket.readyState === WebSocket.CLOSED) return resolve();
      socket.once('close', () => resolve());
      socket.close();
    })));
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('image upload deduplicates content and asset reads follow the current board projection', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tabletop-board-upload-'));
  const config: AppConfig = {
    host: '127.0.0.1', port: 4321, dataDir, roomName: 'Campaign',
    roomCode: 'K7M2R9TX', gmPassword: 'quiet-forest', sessionDays: 30,
    cookieSecure: false, maxUploadBytes: 1024,
  };
  const store = new RoomStore(dataDir, config.roomName);
  const app = await buildServer({ config, store, logger: false });
  try {
    const login = async (name: string, role: 'gm' | 'player') => {
      const response = await app.inject({
        method: 'POST', url: '/api/session', headers: { origin: 'http://localhost' },
        payload: { name, role, roomCode: 'k7m2r9tx', gmPassword: role === 'gm' ? config.gmPassword : undefined },
      });
      assert.equal(response.statusCode, 200);
      return (response.headers['set-cookie'] as string).split(';')[0]!;
    };
    const gmCookie = await login('Keeper', 'gm');
    const playerCookie = await login('Ari', 'player');
    const boundary = 'board-stage-two-boundary';
    const upload = async (cookie: string, filename: string, data = pngBytes, mime = 'image/png') => app.inject({
      method: 'POST', url: '/api/assets', headers: {
        origin: 'http://localhost', cookie, 'content-type': `multipart/form-data; boundary=${boundary}`,
      }, payload: multipart(boundary, filename, mime, data),
    });
    const first = await upload(gmCookie, 'map.png');
    assert.equal(first.statusCode, 200);
    const assetId = first.json().asset.id as string;
    const duplicate = await upload(gmCookie, 'renamed.png');
    assert.equal(duplicate.statusCode, 200);
    assert.equal(duplicate.json().deduplicated, true);
    assert.equal(duplicate.json().asset.id, assetId);
    const batch = await Promise.all([
      upload(gmCookie, 'batch-a.png', pngBytes),
      upload(gmCookie, 'batch-b.png', pngFixture(90)),
    ]);
    assert.deepEqual(batch.map((response) => response.statusCode), [200, 200]);
    assert.deepEqual(batch.map((response) => response.json().deduplicated), [true, false]);
    assert.equal(readdirSync(join(dataDir, 'assets')).length, 2);
    assert.equal((await upload(gmCookie, 'misleading.jpg', pngBytes, 'image/jpeg')).statusCode, 415);
    assert.equal((await upload(gmCookie, 'oversized.png', Buffer.alloc(1025))).statusCode, 413);

    const hiddenAsset = await app.inject({ method: 'GET', url: `/api/assets/${assetId}`, headers: { cookie: playerCookie } });
    assert.equal(hiddenAsset.statusCode, 404);
    const publicLayer = store.getLayers()[0]!;
    store.createObject({
      id: 'object-public', assetId, layerId: publicLayer.id, x: 0, y: 0, width: 1, height: 1,
      orderIndex: 0, flipX: false, flipY: false, crop: null, allowPlayerMove: false, freeStretch: false,
    });
    const visibleAsset = await app.inject({ method: 'GET', url: `/api/assets/${assetId}`, headers: { cookie: playerCookie } });
    assert.equal(visibleAsset.statusCode, 200);
    assert.deepEqual(visibleAsset.rawPayload, pngBytes);
    store.updateLayer(publicLayer.id, { audience: 'gm-only' });
    const privateBoard = await app.inject({ method: 'GET', url: '/api/board', headers: { cookie: playerCookie } });
    assert.equal(privateBoard.statusCode, 200);
    assert.deepEqual(privateBoard.json().layers, []);
    assert.deepEqual(privateBoard.json().objects, []);
    assert.equal('assets' in privateBoard.json(), false);
    const deniedAsset = await app.inject({ method: 'GET', url: `/api/assets/${assetId}`, headers: { cookie: playerCookie } });
    assert.equal(deniedAsset.statusCode, 404);
    const gmAsset = await app.inject({ method: 'GET', url: `/api/assets/${assetId}`, headers: { cookie: gmCookie } });
    assert.equal(gmAsset.statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/api/board', headers: { cookie: gmCookie } })).json().assets.length, 2);

    const playerUpload = await upload(playerCookie, 'player-own.png', pngFixture(210));
    assert.equal(playerUpload.statusCode, 200);
    assert.equal(playerUpload.json().deduplicated, false);
    const playerAssetId = playerUpload.json().asset.id as string;
    assert.equal((await app.inject({ method: 'GET', url: `/api/assets/${playerAssetId}`, headers: { cookie: playerCookie } })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: `/api/assets/${playerAssetId}`, headers: { cookie: gmCookie } })).statusCode, 200);
  } finally {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('configured public origin works through ngrok while spoofed forwarded headers are ignored by default', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tabletop-board-origin-'));
  const baseConfig: AppConfig = {
    host: '127.0.0.1', port: 0, dataDir, roomName: 'Campaign',
    roomCode: 'K7M2R9TX', gmPassword: 'quiet-forest', sessionDays: 30,
    cookieSecure: true, maxUploadBytes: 25 * 1024 * 1024,
  };
  const publicOrigin = 'https://demo.ngrok-free.app';
  const store = new RoomStore(dataDir, baseConfig.roomName);
  const app = await buildServer({ config: { ...baseConfig, publicOrigins: [publicOrigin] }, store, logger: false });
  const payload = { name: 'Ari', role: 'player', roomCode: baseConfig.roomCode };
  try {
    const publicLogin = await app.inject({
      method: 'POST', url: '/api/session', headers: { origin: publicOrigin, host: '127.0.0.1:4321' }, payload,
    });
    assert.equal(publicLogin.statusCode, 200);
    assert.match(publicLogin.headers['set-cookie'] as string, /; Secure/);
    const foreignOrigin = await app.inject({
      method: 'POST', url: '/api/session', headers: { origin: 'https://attacker.invalid' }, payload,
    });
    assert.equal(foreignOrigin.statusCode, 403);

    const spoofed = await app.inject({
      method: 'POST', url: '/api/session',
      headers: { origin: 'https://other.ngrok-free.app', host: '127.0.0.1:4321', 'x-forwarded-host': 'other.ngrok-free.app', 'x-forwarded-proto': 'https' },
      payload,
    });
    assert.equal(spoofed.statusCode, 403);
  } finally {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('trusted proxy uses forwarded HTTPS headers only when explicitly enabled', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tabletop-board-proxy-'));
  const baseConfig: AppConfig = {
    host: '127.0.0.1', port: 0, dataDir, roomName: 'Campaign',
    roomCode: 'K7M2R9TX', gmPassword: 'quiet-forest', sessionDays: 30,
    cookieSecure: true, maxUploadBytes: 25 * 1024 * 1024,
  };
  const publicOrigin = 'https://demo.ngrok-free.app';
  const store = new RoomStore(dataDir, baseConfig.roomName);
  const app = await buildServer({ config: { ...baseConfig, trustProxy: true }, store, logger: false });
  try {
    const login = await app.inject({
      method: 'POST', url: '/api/session',
      headers: { origin: publicOrigin, host: '127.0.0.1:4321', 'x-forwarded-host': 'demo.ngrok-free.app', 'x-forwarded-proto': 'https' },
      payload: { name: 'Ari', role: 'player', roomCode: baseConfig.roomCode },
    });
    assert.equal(login.statusCode, 200);
    assert.match(login.headers['set-cookie'] as string, /; Secure/);
  } finally {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
