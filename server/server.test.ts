import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import WebSocket from 'ws';
import type { AppConfig } from './config.js';
import { buildServer } from './index.js';
import { RoomStore } from './store.js';

test('HTTP session endpoints enforce origin, set a protected cookie, and restore role', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tabletop-board-http-'));
  const config: AppConfig = {
    host: '127.0.0.1', port: 4321, dataDir, roomName: 'Campaign',
    roomCode: 'room-code-with-enough-length', gmPassword: 'gm-password-with-enough-length',
    sessionDays: 30, cookieSecure: false,
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
    sessionDays: 30, cookieSecure: false,
  };
  const app = await buildServer({ config, store: new RoomStore(dataDir, config.roomName), logger: false });
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
