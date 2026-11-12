import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import WebSocket from 'ws';
import { executeBoardCommand } from './board.js';
import type { AppConfig } from './config.js';
import { buildServer } from './index.js';
import { RoomStore } from './store.js';

function configFor(dataDir: string): AppConfig {
  return {
    host: '127.0.0.1', port: 0, dataDir, roomName: 'Campaign',
    roomCode: 'room-code-with-enough-length', gmPassword: 'gm-password-with-enough-length',
    sessionDays: 30, cookieSecure: false, maxUploadBytes: 25 * 1024 * 1024,
  };
}

function nextSocketMessage(socket: WebSocket, predicate: (message: Record<string, unknown>) => boolean, label: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { socket.off('message', onMessage); reject(new Error(`Timed out waiting for ${label}.`)); }, 3000);
    const onMessage = (data: WebSocket.RawData) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      if (!predicate(message)) return;
      clearTimeout(timeout); socket.off('message', onMessage); resolve(message);
    };
    socket.on('message', onMessage);
  });
}

test('personal notes: owner and GM access, server filtering, markers and images', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tabletop-personal-notes-'));
  const config = configFor(dataDir);
  const store = new RoomStore(dataDir, config.roomName);
  let app: Awaited<ReturnType<typeof buildServer>> | undefined;
  let personalNoteId = '';
  try {
    app = await buildServer({ config, store, logger: false });
    const login = async (name: string, role: 'gm' | 'player') => {
      const response = await app!.inject({ method: 'POST', url: '/api/session', headers: { origin: 'http://localhost:80' }, payload: { name, role, roomCode: config.roomCode, gmPassword: role === 'gm' ? config.gmPassword : undefined } });
      assert.equal(response.statusCode, 200);
      return { cookie: (response.headers['set-cookie'] as string).split(';')[0]!, identity: response.json().identity as { participantId: string; name: string; role: 'gm' | 'player' } };
    };
    const gm = await login('Keeper', 'gm');
    const ari = await login('Ari', 'player');
    const bea = await login('Bea', 'player');
    const originHeaders = (cookie: string) => ({ origin: 'http://localhost:80', cookie });
    const readHeaders = (cookie: string) => ({ cookie });

    const assetId = '11111111-1111-4111-8111-111111111111';
    store.createAsset({ id: assetId, sha256: 'ari-personal-hash', mimeType: 'image/png', originalName: 'ari.png', size: 4, width: 1, height: 1 });
    store.recordAssetUploader(assetId, ari.identity.participantId);
    mkdirSync(join(dataDir, 'assets'), { recursive: true });
    writeFileSync(join(dataDir, 'assets', assetId), Buffer.from([137, 80, 78, 71]));

    const created = await app.inject({
      method: 'POST', url: '/api/personal-notes', headers: originHeaders(ari.cookie),
      payload: { title: 'Ari diary', body: 'secret-ari-body', assetIds: [assetId], fontFamily: 'default' },
    });
    assert.equal(created.statusCode, 200);
    const note = created.json().note as { id: string; noteType: string; ownerId: string; ownerName: string; access: string; assetIds: string[] };
    personalNoteId = note.id;
    assert.deepEqual(
      { noteType: note.noteType, ownerId: note.ownerId, ownerName: note.ownerName, access: note.access },
      { noteType: 'personal', ownerId: ari.identity.participantId, ownerName: 'Ari', access: 'gm-only' },
    );
    assert.deepEqual(note.assetIds, [assetId]);

    // Personal notes never appear on the board and cannot receive markers.
    assert.equal(store.getNoteMarkers().length, 0);
    assert.throws(() => executeBoardCommand(store, gm.identity, { type: 'note-marker:create', noteId: note.id, layerId: store.getLayers()[0]!.id, x: 10, y: 20 }), /Личные заметки/);
    assert.throws(() => store.createNoteMarker({ id: 'forbidden-marker', noteId: note.id, layerId: store.getLayers()[0]!.id, x: 10, y: 20 }), /Личные заметки/);

    // Owner access and foreign-player denial, including direct API requests.
    assert.equal((await app.inject({ method: 'GET', url: `/api/personal-notes/${note.id}`, headers: readHeaders(ari.cookie) })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: `/api/personal-notes/${note.id}`, headers: readHeaders(bea.cookie) })).statusCode, 404);
    assert.equal((await app.inject({ method: 'PUT', url: `/api/personal-notes/${note.id}`, headers: originHeaders(bea.cookie), payload: { title: 'stolen', body: '', assetIds: [] } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/personal-notes/${note.id}`, headers: originHeaders(bea.cookie) })).statusCode, 403);
    // The GM only reads other players' notes.
    assert.equal((await app.inject({ method: 'PUT', url: `/api/personal-notes/${note.id}`, headers: originHeaders(gm.cookie), payload: { title: 'gm edit', body: '', assetIds: [] } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/personal-notes/${note.id}`, headers: originHeaders(gm.cookie) })).statusCode, 403);
    // The legacy board-note endpoints cannot expose or mutate personal notes.
    assert.equal((await app.inject({ method: 'GET', url: `/api/notes/${note.id}`, headers: readHeaders(gm.cookie) })).statusCode, 404);
    assert.equal((await app.inject({ method: 'GET', url: `/api/notes/${note.id}`, headers: readHeaders(ari.cookie) })).statusCode, 404);
    assert.equal((await app.inject({ method: 'PUT', url: `/api/notes/${note.id}`, headers: originHeaders(gm.cookie), payload: { title: 'x', body: '', access: 'gm-only', selectedParticipantIds: [], assetIds: [] } })).statusCode, 404);
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/notes/${note.id}`, headers: originHeaders(gm.cookie) })).statusCode, 404);

    // Private images: only the owner and GM may read the original.
    assert.equal((await app.inject({ method: 'GET', url: `/api/assets/${assetId}`, headers: readHeaders(bea.cookie) })).statusCode, 404);
    assert.equal((await app.inject({ method: 'GET', url: `/api/assets/${assetId}`, headers: readHeaders(ari.cookie) })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: `/api/assets/${assetId}`, headers: readHeaders(gm.cookie) })).statusCode, 200);

    // Per-identity snapshots: owner sees own metadata, the GM sees all authors,
    // another player sees nothing, and no payload contains the private body.
    const ariBoard = await app.inject({ method: 'GET', url: '/api/board', headers: readHeaders(ari.cookie) });
    assert.deepEqual((ariBoard.json().personalNotes as Array<{ id: string }>).map((entry) => entry.id), [note.id]);
    assert.equal(ariBoard.body.includes('secret-ari-body'), false);
    const beaBoard = await app.inject({ method: 'GET', url: '/api/board', headers: readHeaders(bea.cookie) });
    assert.deepEqual((beaBoard.json().personalNotes as Array<{ id: string }>).map((entry) => entry.id), []);
    assert.equal(beaBoard.body.includes('secret-ari-body'), false);
    const gmBoard = await app.inject({ method: 'GET', url: '/api/board', headers: readHeaders(gm.cookie) });
    assert.deepEqual((gmBoard.json().personalNotes as Array<{ id: string; ownerName: string }>).map((entry) => ({ id: entry.id, ownerName: entry.ownerName })), [{ id: note.id, ownerName: 'Ari' }]);
    assert.equal(gmBoard.body.includes('secret-ari-body'), false);

    // Removing an attachment deletes only the reference, never the library original.
    const updated = await app.inject({ method: 'PUT', url: `/api/personal-notes/${note.id}`, headers: originHeaders(ari.cookie), payload: { title: 'Ari diary edited', body: 'updated body', assetIds: [], fontFamily: 'caveat' } });
    assert.equal(updated.statusCode, 200);
    assert.deepEqual(updated.json().note.assetIds, []);
    assert.ok(store.getAsset(assetId));
    assert.equal(store.getNote(note.id)?.title, 'Ari diary edited');

    // Existing GM board notes remain a separate list.
    const boardNote = await app.inject({ method: 'POST', url: '/api/notes', headers: originHeaders(gm.cookie), payload: { title: 'Board note', body: 'board body', access: 'all-players', selectedParticipantIds: [], assetIds: [], markerType: 'text', markerText: '' } });
    assert.equal(boardNote.statusCode, 200);
    const gmNotes = await app.inject({ method: 'GET', url: '/api/notes', headers: readHeaders(gm.cookie) });
    assert.deepEqual((gmNotes.json().notes as Array<{ id: string }>).map((entry) => entry.id), [boardNote.json().note.id]);
    assert.equal(gmNotes.body.includes(note.id), false);

    await app.close();
    app = undefined;

    // A restart keeps the personal note with its owner and type.
    const reopened = new RoomStore(dataDir, config.roomName);
    try {
      const persisted = reopened.getNote(personalNoteId);
      assert.equal(persisted?.noteType, 'personal');
      assert.equal(persisted?.ownerId, ari.identity.participantId);
      assert.equal(persisted?.ownerName, 'Ari');
      assert.equal(persisted?.body, 'updated body');
    } finally { reopened.close(); }
  } finally {
    if (app) await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('personal note WebSocket state reveals private records only to the owner and GM', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tabletop-personal-notes-ws-'));
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
      return { cookie: (response.headers['set-cookie'] as string).split(';')[0]!, identity: response.json().identity as { participantId: string } };
    };
    const connect = (cookie: string) => new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(`ws://${host}/ws`, { headers: { origin, cookie } });
      sockets.push(socket);
      socket.once('error', reject);
      socket.once('message', () => resolve(socket));
    });
    const gm = await login('Keeper', 'gm');
    const ari = await login('Ari', 'player');
    const bea = await login('Bea', 'player');
    const gmSocket = await connect(gm.cookie);
    const ariSocket = await connect(ari.cookie);
    const beaSocket = await connect(bea.cookie);

    const hasPrivateNote = (message: Record<string, unknown>): boolean =>
      message.type === 'room:state'
      && ((message.personalNotes as Array<{ title: string }> | undefined) ?? []).some((note) => note.title === 'Private WS note');
    const ownerState = nextSocketMessage(ariSocket, hasPrivateNote, 'owner personal note projection');
    const gmState = nextSocketMessage(gmSocket, hasPrivateNote, 'GM personal note projection');
    const otherPlayerState = nextSocketMessage(beaSocket, hasPrivateNote, 'other player leak');
    const created = await app.inject({ method: 'POST', url: '/api/personal-notes', headers: { origin, host, cookie: ari.cookie }, payload: { title: 'Private WS note', body: 'ws-secret-body', assetIds: [] } });
    assert.equal(created.statusCode, 200);
    const noteId = created.json().note.id as string;

    assert.equal((await ownerState).personalNotes instanceof Array, true);
    assert.equal((await gmState).personalNotes instanceof Array, true);
    const leak = await Promise.race([
      otherPlayerState.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 400)),
    ]);
    assert.equal(leak, false);
    // The shared broadcast must not contain private bodies for any identity.
    assert.equal(JSON.stringify(await ownerState).includes('ws-secret-body'), false);
    assert.equal(JSON.stringify(await gmState).includes('ws-secret-body'), false);
    assert.equal(JSON.stringify(await gmState).includes(noteId), true);
  } finally {
    for (const socket of sockets) socket.close();
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
