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

function pngFixture(): Buffer {
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
    chunk('IDAT', deflateSync(Buffer.from([0, 180, 45, 60, 255]))), chunk('IEND', Buffer.alloc(0)),
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
  const app = await buildServer({ config, store: new RoomStore(dataDir, config.roomName), logger: false });
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
    assert.deepEqual(login.json().identity, { name: 'Morgan', role: 'player' });
    const cookie = login.headers['set-cookie'];
    assert.equal(typeof cookie, 'string');
    assert.match(cookie as string, /HttpOnly/);
    assert.match(cookie as string, /SameSite=Strict/i);

    const restored = await app.inject({ method: 'GET', url: '/api/session', headers: { cookie: (cookie as string).split(';')[0] } });
    assert.equal(restored.statusCode, 200);
    assert.deepEqual(restored.json().identity, { name: 'Morgan', role: 'player' });
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
    const connect = (cookie: string) => new Promise<{ socket: WebSocket; state: { identity: { name: string; role: string }; participants: unknown[] } }>((resolve, reject) => {
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
    const secondPlayer = await connect(secondPlayerCookie);
    assert.deepEqual(gm.state.identity, { name: 'Keeper', role: 'gm' });
    assert.deepEqual(firstPlayer.state.identity, { name: 'Ari', role: 'player' });
    assert.deepEqual(secondPlayer.state.identity, { name: 'Bea', role: 'player' });
    assert.equal(secondPlayer.state.participants.length, 3);
    await Promise.all([
      nextSocketMessage(gm.socket, (message) => message.type === 'room:state' && Array.isArray(message.participants) && message.participants.length === 3, 'GM participant update'),
      nextSocketMessage(firstPlayer.socket, (message) => message.type === 'room:state' && Array.isArray(message.participants) && message.participants.length === 3, 'player participant update'),
    ]);

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

    const oldSocketClosed = new Promise<void>((resolve) => firstPlayer.socket.once('close', () => resolve()));
    firstPlayer.socket.close();
    await oldSocketClosed;
    const restoredPlayer = await connect(firstPlayerCookie);
    assert.deepEqual(restoredPlayer.state.identity, { name: 'Ari', role: 'player' });
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
    assert.equal(readdirSync(join(dataDir, 'assets')).length, 1);
    assert.equal((await upload(gmCookie, 'misleading.jpg', pngBytes, 'image/jpeg')).statusCode, 415);
    assert.equal((await upload(gmCookie, 'oversized.png', Buffer.alloc(1025))).statusCode, 413);
    assert.equal((await upload(playerCookie, 'forbidden.png')).statusCode, 403);

    const hiddenAsset = await app.inject({ method: 'GET', url: `/api/assets/${assetId}`, headers: { cookie: playerCookie } });
    assert.equal(hiddenAsset.statusCode, 404);
    const publicLayer = store.getLayers()[0]!;
    store.createObject({
      id: 'object-public', assetId, layerId: publicLayer.id, x: 0, y: 0, width: 1, height: 1,
      orderIndex: 0, flipX: false, flipY: false, crop: null, allowPlayerMove: false,
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
    assert.equal((await app.inject({ method: 'GET', url: '/api/board', headers: { cookie: gmCookie } })).json().assets.length, 1);
  } finally {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
