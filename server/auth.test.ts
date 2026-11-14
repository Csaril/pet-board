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

test('authentication validates room and GM secret and reuses a participant across sessions', () => {
  const { dataDir, store, config } = fixture();
  try {
    assert.equal(authenticate({ name: 'A', role: 'player', roomCode: 'wrong-room-code-123' }, config, store), undefined);
    assert.equal(authenticate({ name: 'GM', role: 'gm', roomCode: config.roomCode, gmPassword: 'wrong-password-12345' }, config, store), undefined);
    const result = authenticate({ name: '  Morgan  ', role: 'player', roomCode: config.roomCode }, config, store);
    assert.ok(result);
    assert.deepEqual({ name: result.identity.name, role: result.identity.role }, { name: 'Morgan', role: 'player' });
    // The participant is a stable entity, independent of the browser session.
    assert.notEqual(result.identity.participantId, sessionDigest(result.sessionId));
    assert.deepEqual(store.getSession(sessionDigest(result.sessionId)), result.identity);
    assert.deepEqual(store.getParticipant(result.identity.participantId), result.identity);

    const reconnect = authenticate({ name: 'Morgan', role: 'player', roomCode: config.roomCode }, config, store);
    assert.ok(reconnect);
    assert.equal(reconnect.identity.participantId, result.identity.participantId);
    assert.notEqual(reconnect.sessionId, result.sessionId);
    assert.deepEqual(store.getSession(sessionDigest(reconnect.sessionId)), result.identity);

    // Closing one browser session does not invalidate the other one.
    store.deleteSession(sessionDigest(result.sessionId));
    assert.equal(store.getSession(sessionDigest(result.sessionId)), undefined);
    assert.deepEqual(store.getSession(sessionDigest(reconnect.sessionId)), result.identity);

    // A second GM browser is an independent session of the same participant.
    const gmOne = authenticate({ name: 'GM', role: 'gm', roomCode: config.roomCode, gmPassword: config.gmPassword }, config, store);
    const gmTwo = authenticate({ name: 'GM', role: 'gm', roomCode: config.roomCode, gmPassword: config.gmPassword }, config, store);
    assert.ok(gmOne);
    assert.ok(gmTwo);
    assert.equal(gmOne.identity.participantId, gmTwo.identity.participantId);
    assert.notEqual(gmOne.sessionId, gmTwo.sessionId);
    assert.ok(store.getSession(sessionDigest(gmOne.sessionId)));
    assert.ok(store.getSession(sessionDigest(gmTwo.sessionId)));
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
