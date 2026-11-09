import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { authenticate, sessionDigest } from './auth.js';
import type { AppConfig } from './config.js';
import { RoomStore } from './store.js';

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), 'tabletop-board-'));
  const store = new RoomStore(dataDir, 'Test room');
  const config: AppConfig = {
    host: '127.0.0.1', port: 4321, dataDir, roomName: 'Test room',
    roomCode: 'room-code-with-enough-length', gmPassword: 'gm-password-with-enough-length',
    sessionDays: 30, cookieSecure: false, maxUploadBytes: 25 * 1024 * 1024,
  };
  return { dataDir, store, config };
}

test('authentication validates room and GM secret on server and persists role', () => {
  const { dataDir, store, config } = fixture();
  try {
    assert.equal(authenticate({ name: 'A', role: 'player', roomCode: 'wrong-room-code-123' }, config, store), undefined);
    assert.equal(authenticate({ name: 'GM', role: 'gm', roomCode: config.roomCode, gmPassword: 'wrong-password-12345' }, config, store), undefined);
    const result = authenticate({ name: '  Morgan  ', role: 'player', roomCode: config.roomCode }, config, store);
    assert.ok(result);
    assert.deepEqual(result.identity, { name: 'Morgan', role: 'player' });
    assert.deepEqual(store.getSession(sessionDigest(result.sessionId)), result.identity);
    assert.equal(store.createSession('another-gm', { name: 'GM', role: 'gm' }, Date.now() + 60_000), true);
    assert.equal(authenticate({ name: 'GM 2', role: 'gm', roomCode: config.roomCode, gmPassword: config.gmPassword }, config, store), undefined);
  } finally { store.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test('session restoration expires and logout removes the server-side session', () => {
  const { dataDir, store, config } = fixture();
  try {
    const result = authenticate({ name: 'Player', role: 'player', roomCode: config.roomCode }, config, store);
    assert.ok(result);
    assert.deepEqual(store.getSession(sessionDigest(result.sessionId)), result.identity);
    store.deleteSession(sessionDigest(result.sessionId));
    assert.equal(store.getSession(sessionDigest(result.sessionId)), undefined);
    assert.equal(sessionDigest('token').length, 64);
  } finally { store.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test('room name and session survive reopening the SQLite database', () => {
  const { dataDir, store, config } = fixture();
  let currentStore = store;
  try {
    const result = authenticate({ name: 'Persisted', role: 'player', roomCode: config.roomCode }, config, currentStore);
    assert.ok(result);
    const digest = sessionDigest(result.sessionId);
    currentStore.close();
    currentStore = new RoomStore(dataDir, 'Changed name is ignored for an existing room');
    assert.equal(currentStore.roomName, 'Test room');
    assert.deepEqual(currentStore.getSession(digest), result.identity);
  } finally { currentStore.close(); rmSync(dataDir, { recursive: true, force: true }); }
});
