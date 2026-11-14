import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { RoomStore } from './store.js';

test('legacy sessions are migrated into participants without changing participant IDs', () => {
  const roomDir = mkdtempSync(join(tmpdir(), 'tabletop-participant-migration-'));
  const expiresAt = Date.now() + 60_000;
  try {
    const legacy = new Database(join(roomDir, 'room.sqlite'));
    legacy.exec(`
      CREATE TABLE room (id INTEGER PRIMARY KEY CHECK (id = 1), name TEXT NOT NULL);
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('gm', 'player')),
        expires_at INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    legacy.prepare('INSERT INTO sessions (id, name, role, expires_at) VALUES (?, ?, ?, ?)').run('legacy-gm', 'Keeper', 'gm', expiresAt);
    legacy.prepare('INSERT INTO sessions (id, name, role, expires_at) VALUES (?, ?, ?, ?)').run('legacy-player', 'Ari', 'player', expiresAt);
    legacy.close();

    const store = new RoomStore(roomDir, 'Legacy room');
    try {
      // Old session IDs become the stable participant IDs referenced by sheets,
      // notes, assets and dice history.
      assert.deepEqual(store.getParticipant('legacy-gm'), { participantId: 'legacy-gm', name: 'Keeper', role: 'gm' });
      assert.deepEqual(store.getParticipant('legacy-player'), { participantId: 'legacy-player', name: 'Ari', role: 'player' });
      assert.deepEqual(store.getSession('legacy-gm'), { participantId: 'legacy-gm', name: 'Keeper', role: 'gm' });
      assert.deepEqual(store.getSession('legacy-player'), { participantId: 'legacy-player', name: 'Ari', role: 'player' });
      assert.equal(store.isPlayerParticipant('legacy-player'), true);
      assert.equal(store.isPlayerParticipant('legacy-gm'), false);

      const participants = (store.db.prepare('SELECT COUNT(*) AS count FROM participants').get() as { count: number }).count;
      const sessions = (store.db.prepare('SELECT COUNT(*) AS count FROM sessions').get() as { count: number }).count;
      assert.equal(participants, 2);
      assert.equal(sessions, 2);

      // A later sign-in reuses the migrated participant instead of duplicating it.
      assert.equal(store.createSession('new-gm-session', { name: 'Keeper', role: 'gm' }, expiresAt), true);
      assert.deepEqual(store.getSession('new-gm-session'), { participantId: 'legacy-gm', name: 'Keeper', role: 'gm' });
      assert.equal((store.db.prepare('SELECT COUNT(*) AS count FROM participants').get() as { count: number }).count, 2);
    } finally { store.close(); }
  } finally { rmSync(roomDir, { recursive: true, force: true }); }
});

test('one participant can hold several independent sessions and closing one keeps the other', () => {
  const roomDir = mkdtempSync(join(tmpdir(), 'tabletop-participant-sessions-'));
  const expiresAt = Date.now() + 60_000;
  try {
    const store = new RoomStore(roomDir, 'Room');
    try {
      assert.equal(store.createSession('desktop', { name: 'Ari', role: 'player' }, expiresAt), true);
      assert.equal(store.createSession('laptop', { name: 'Ari', role: 'player' }, expiresAt), true);
      const desktop = store.getSession('desktop')!;
      const laptop = store.getSession('laptop')!;
      assert.equal(desktop.participantId, laptop.participantId);
      assert.equal((store.db.prepare('SELECT COUNT(*) AS count FROM participants').get() as { count: number }).count, 1);
      assert.equal((store.db.prepare('SELECT COUNT(*) AS count FROM sessions').get() as { count: number }).count, 2);

      store.deleteSession('desktop');
      assert.equal(store.getSession('desktop'), undefined);
      assert.deepEqual(store.getSession('laptop'), desktop);
      assert.ok(store.getParticipant(desktop.participantId));
    } finally { store.close(); }
  } finally { rmSync(roomDir, { recursive: true, force: true }); }
});
