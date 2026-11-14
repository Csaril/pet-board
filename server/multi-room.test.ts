import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import WebSocket from 'ws';
import type { AppConfig } from './config.js';
import { buildServer } from './index.js';
import { RoomCatalog } from './catalog.js';
import { RoomManager } from './room-manager.js';
import { createRoom, setRoomStatus } from './room-admin.js';

const ASSET_ID = '11111111-1111-4111-8111-111111111111';

function nextMessage(socket: WebSocket, predicate: (message: Record<string, unknown>) => boolean, label: string, timeoutMs = 6000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { socket.off('message', listener); reject(new Error(`${label}: таймаут`)); }, timeoutMs);
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

function configFor(dataDir: string): AppConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    dataDir,
    roomName: '',
    roomCode: '',
    gmPassword: '',
    sessionDays: 30,
    cookieSecure: false,
    maxUploadBytes: 25 * 1024 * 1024,
    maxOpenRooms: 4,
  };
}

interface Client {
  socket: WebSocket;
  cookie: string;
  participantId: string;
}

test('two independent rooms work through one server without leaking HTTP or WebSocket state', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tabletop-board-multi-room-'));
  let app!: Awaited<ReturnType<typeof buildServer>>;
  const sockets: WebSocket[] = [];
  try {
    RoomCatalog.initialize(dataDir).close();
    const pbta = await createRoom({ dataDir, name: 'PbtA Campaign', systemId: 'pbta-2d6', gmPassword: 'pbta-password-123' });
    const nechronica = await createRoom({ dataDir, name: 'Nechronica Campaign', systemId: 'nechronica', gmPassword: 'nechronica-password-123' });

    const catalog = RoomCatalog.open(dataDir);
    const manager = new RoomManager({ dataDir, catalog, maxOpenRooms: 4 });
    app = await buildServer({ config: configFor(dataDir), roomManager: manager, logger: false });
    const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    const { host } = new URL(baseUrl);
    const origin = `http://${host}`;

    const login = async (roomId: string, code: string, name: string, role: 'gm' | 'player', password?: string) => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/session',
        headers: { origin, host },
        payload: { name, role, roomCode: code, gmPassword: password },
      });
      assert.equal(response.statusCode, 200, response.body);
      const setCookie = response.headers['set-cookie'] as string;
      assert.match(setCookie, new RegExp(`tb_session_${roomId}=`));
      assert.match(setCookie, /HttpOnly/);
      assert.match(setCookie, /SameSite=Strict/i);
      return {
        cookie: setCookie.split(';')[0]!,
        roomId: response.json().room.id as string,
        participantId: response.json().identity.participantId as string,
      };
    };

    const board = async (cookie: string, roomId: string) => app.inject({
      method: 'GET', url: `/api/board?roomId=${encodeURIComponent(roomId)}`, headers: { cookie },
    });

    const connect = async (roomId: string, cookie: string): Promise<Client> => {
      const socket = new WebSocket(`ws://${host}/ws?roomId=${encodeURIComponent(roomId)}`, { headers: { origin, cookie } });
      sockets.push(socket);
      const state = nextMessage(socket, (message) => message.type === 'room:state', 'первичное состояние комнаты');
      await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
      const first = await state;
      assert.equal(first.roomId, roomId);
      return { socket, cookie, participantId: (first.identity as { participantId: string }).participantId };
    };

    const pbtaGm = await login(pbta.room.id, pbta.code, 'Keeper', 'gm', 'pbta-password-123');
    const nechronicaGm = await login(nechronica.room.id, nechronica.code, 'Keeper', 'gm', 'nechronica-password-123');
    assert.notEqual(pbtaGm.cookie, nechronicaGm.cookie);

    await t.test('1. A room cookie cannot be used for another room', async () => {
      const wrongRoom = await board(pbtaGm.cookie, nechronica.room.id);
      assert.equal(wrongRoom.statusCode, 401);
      const wrongRoomWs = new WebSocket(`ws://${host}/ws?roomId=${encodeURIComponent(nechronica.room.id)}`, {
        headers: { origin, cookie: pbtaGm.cookie },
      });
      sockets.push(wrongRoomWs);
      const code = await new Promise<number>((resolve, reject) => {
        wrongRoomWs.once('close', (value) => resolve(value));
        wrongRoomWs.once('error', reject);
      });
      assert.equal(code, 1008);
    });

    await t.test('2. HTTP board, notes and images are isolated per room', async () => {
      const pbtaBoard = await board(pbtaGm.cookie, pbta.room.id);
      const nechronicaBoard = await board(nechronicaGm.cookie, nechronica.room.id);
      assert.equal(pbtaBoard.statusCode, 200);
      assert.equal(nechronicaBoard.statusCode, 200);
      assert.notEqual(pbtaBoard.json().layers[0]?.id, nechronicaBoard.json().layers[0]?.id);

      const createNote = async (cookie: string, roomId: string, title: string) => app.inject({
        method: 'POST', url: `/api/notes?roomId=${encodeURIComponent(roomId)}`,
        headers: { origin: 'http://localhost:80', cookie },
        payload: { title, body: `${title} body`, access: 'gm-only', selectedParticipantIds: [], assetIds: [], markerType: 'text', markerText: '' },
      });
      const noteA = await createNote(pbtaGm.cookie, pbta.room.id, 'PbtA secret');
      const noteB = await createNote(nechronicaGm.cookie, nechronica.room.id, 'Nechronica secret');
      assert.equal(noteA.statusCode, 200, noteA.body);
      assert.equal(noteB.statusCode, 200, noteB.body);
      const idA = noteA.json().note.id as string;
      assert.equal((await app.inject({ method: 'GET', url: `/api/notes/${idA}?roomId=${pbta.room.id}`, headers: { cookie: pbtaGm.cookie } })).statusCode, 200);
      assert.equal((await app.inject({ method: 'GET', url: `/api/notes/${idA}?roomId=${nechronica.room.id}`, headers: { cookie: nechronicaGm.cookie } })).statusCode, 404);
      const listA = await app.inject({ method: 'GET', url: `/api/notes?roomId=${pbta.room.id}`, headers: { cookie: pbtaGm.cookie } });
      const listB = await app.inject({ method: 'GET', url: `/api/notes?roomId=${nechronica.room.id}`, headers: { cookie: nechronicaGm.cookie } });
      assert.deepEqual(listA.json().notes.map((note: { title: string }) => note.title), ['PbtA secret']);
      assert.deepEqual(listB.json().notes.map((note: { title: string }) => note.title), ['Nechronica secret']);

      // The same asset id exists in both rooms with different bytes. It must remain room-local.
      for (const [roomId, byte] of [[pbta.room.id, 11], [nechronica.room.id, 22]] as const) {
        const assets = join(dataDir, 'rooms', roomId, 'assets');
        mkdirSync(assets, { recursive: true, mode: 0o700 });
        writeFileSync(join(assets, ASSET_ID), Buffer.from([byte, byte, byte, byte]), { mode: 0o600 });
        const lease = manager.acquire(roomId);
        try {
          lease.store.createAsset({ id: ASSET_ID, sha256: `hash-${byte}`, mimeType: 'image/png', originalName: `same-${byte}.png`, size: 4, width: 1, height: 1 });
        } finally { lease.release(); }
      }
      const imageA = await app.inject({ method: 'GET', url: `/api/assets/${ASSET_ID}?roomId=${pbta.room.id}`, headers: { cookie: pbtaGm.cookie } });
      const imageB = await app.inject({ method: 'GET', url: `/api/assets/${ASSET_ID}?roomId=${nechronica.room.id}`, headers: { cookie: nechronicaGm.cookie } });
      assert.equal(imageA.statusCode, 200);
      assert.equal(imageB.statusCode, 200);
      assert.deepEqual([...imageA.rawPayload], [11, 11, 11, 11]);
      assert.deepEqual([...imageB.rawPayload], [22, 22, 22, 22]);
      assert.equal((await app.inject({ method: 'GET', url: `/api/assets/${ASSET_ID}?roomId=${nechronica.room.id}`, headers: { cookie: pbtaGm.cookie } })).statusCode, 401);
    });

    await t.test('3. WebSocket sheets and dice stay inside their room', async () => {
      const clientA = await connect(pbta.room.id, pbtaGm.cookie);
      const clientB = await connect(nechronica.room.id, nechronicaGm.cookie);

      const sheetStateA = nextMessage(clientA.socket, (message) => message.type === 'room:state' && (message.sheets as unknown[])?.length === 1, 'лист PbtA');
      clientA.socket.send(JSON.stringify({ type: 'sheet:create', requestId: 'a-sheet', characterName: 'PbtA Hero' }));
      assert.equal((await nextMessage(clientA.socket, (message) => message.type === 'command:result' && message.requestId === 'a-sheet', 'подтверждение листа PbtA')).ok, true);
      const stateA = await sheetStateA;

      const sheetStateB = nextMessage(clientB.socket, (message) => message.type === 'room:state' && (message.sheets as unknown[])?.length === 1, 'лист Nechronica');
      clientB.socket.send(JSON.stringify({ type: 'sheet:create', requestId: 'b-sheet', characterName: 'Nechronica Hero' }));
      assert.equal((await nextMessage(clientB.socket, (message) => message.type === 'command:result' && message.requestId === 'b-sheet', 'подтверждение листа Nechronica')).ok, true);
      const stateB = await sheetStateB;
      assert.deepEqual((stateA.sheets as Array<{ characterName: string }>).map((sheet) => sheet.characterName), ['PbtA Hero']);
      assert.deepEqual((stateB.sheets as Array<{ characterName: string }>).map((sheet) => sheet.characterName), ['Nechronica Hero']);

      const diceStateA = nextMessage(clientA.socket, (message) => message.type === 'room:state' && (message.diceRolls as unknown[])?.length === 1, 'бросок PbtA');
      clientA.socket.send(JSON.stringify({ type: 'dice:free', requestId: 'a-dice', count: 2, sides: 6 }));
      assert.equal((await nextMessage(clientA.socket, (message) => message.type === 'command:result' && message.requestId === 'a-dice', 'подтверждение броска')).ok, true);
      await diceStateA;
      assert.equal(((await board(pbtaGm.cookie, pbta.room.id)).json().diceRolls as unknown[]).length, 1);
      assert.equal(((await board(nechronicaGm.cookie, nechronica.room.id)).json().diceRolls as unknown[]).length, 0);

      const deniedBattle = nextMessage(clientA.socket, (message) => message.type === 'command:result' && message.requestId === 'a-battle', 'запрет боевой карты');
      clientA.socket.send(JSON.stringify({ type: 'room:scene:set', requestId: 'a-battle', scene: 'battle' }));
      const denied = await deniedBattle;
      assert.deepEqual({ ok: denied.ok, code: denied.code }, { ok: false, code: 'SYSTEM_MISMATCH' });

      const battleStateB = nextMessage(clientB.socket, (message) => message.type === 'room:state' && message.activeScene === 'battle', 'боевая карта Nechronica');
      clientB.socket.send(JSON.stringify({ type: 'room:scene:set', requestId: 'b-battle', scene: 'battle' }));
      assert.equal((await nextMessage(clientB.socket, (message) => message.type === 'command:result' && message.requestId === 'b-battle', 'подтверждение боевой карты')).ok, true);
      await battleStateB;
      assert.equal((await board(pbtaGm.cookie, pbta.room.id)).json().activeScene, 'board');
      clientA.socket.close();
      clientB.socket.close();
    });

    await t.test('4. Disabling one room closes only its sockets and leaves the other room untouched', async () => {
      const clientA = await connect(pbta.room.id, pbtaGm.cookie);
      const clientB = await connect(nechronica.room.id, nechronicaGm.cookie);
      const closedA = nextMessage(clientA.socket, (message) => message.type === 'room:closed', 'закрытие отключённой комнаты', 8000);
      setRoomStatus(dataDir, pbta.room.id, 'disabled');
      assert.equal((await closedA).reason, 'disabled');
      const disabledBoard = await board(pbtaGm.cookie, pbta.room.id);
      assert.equal(disabledBoard.statusCode, 403);
      assert.equal(disabledBoard.json().code, 'ROOM_DISABLED');
      assert.equal((await board(nechronicaGm.cookie, nechronica.room.id)).statusCode, 200);
      setRoomStatus(dataDir, pbta.room.id, 'active');
      const enabledBoard = await board(pbtaGm.cookie, pbta.room.id);
      assert.equal(enabledBoard.statusCode, 200);
      clientB.socket.close();
    });

    await t.test('5. A room created after server start is discovered without restarting', async () => {
      const created = await createRoom({ dataDir, name: 'Late Room', systemId: 'pbta-2d6', gmPassword: 'late-password-123' });
      const late = await login(created.room.id, created.code, 'Late Keeper', 'gm', 'late-password-123');
      assert.equal(late.roomId, created.room.id);
      assert.equal((await board(late.cookie, created.room.id)).statusCode, 200);
    });

    await t.test('6. Logout clears only the selected room cookie', async () => {
      const logout = await app.inject({
        method: 'DELETE', url: `/api/session?roomId=${pbta.room.id}`,
        headers: { origin: 'http://localhost:80', cookie: pbtaGm.cookie },
      });
      assert.equal(logout.statusCode, 204);
      assert.equal((await board(pbtaGm.cookie, pbta.room.id)).statusCode, 401);
      assert.equal((await board(nechronicaGm.cookie, nechronica.room.id)).statusCode, 200);
    });

    for (const socket of sockets) if (socket.readyState === 1) socket.close();
    await app.close();

    await t.test('7. Restarting the server preserves each room independently', async () => {
      const reopenedCatalog = RoomCatalog.open(dataDir);
      const reopenedManager = new RoomManager({ dataDir, catalog: reopenedCatalog, maxOpenRooms: 4 });
      const restarted = await buildServer({ config: configFor(dataDir), roomManager: reopenedManager, logger: false });
      try {
        const pbtaBoard = await restarted.inject({
          method: 'GET', url: `/api/board?roomId=${pbta.room.id}`, headers: { cookie: pbtaGm.cookie },
        });
        assert.equal(pbtaBoard.statusCode, 401, 'сессия PbtA была завершена явным выходом');
        const fresh = await restarted.inject({
          method: 'POST', url: '/api/session', headers: { origin: 'http://localhost:80' },
          payload: { name: 'After restart', role: 'gm', roomCode: pbta.code, gmPassword: 'pbta-password-123' },
        });
        assert.equal(fresh.statusCode, 200);
        const cookie = (fresh.headers['set-cookie'] as string).split(';')[0]!;
        const state = await restarted.inject({ method: 'GET', url: `/api/board?roomId=${pbta.room.id}`, headers: { cookie } });
        assert.equal(state.statusCode, 200);
        assert.equal(state.json().diceRolls.length, 1);
        assert.deepEqual(state.json().sheets.map((sheet: { characterName: string }) => sheet.characterName), ['PbtA Hero']);
        assert.equal(state.json().activeScene, 'board');
        const notes = await restarted.inject({ method: 'GET', url: `/api/notes?roomId=${pbta.room.id}`, headers: { cookie } });
        assert.deepEqual(notes.json().notes.map((note: { title: string }) => note.title), ['PbtA secret']);

        const nechronicaState = await restarted.inject({
          method: 'GET', url: `/api/board?roomId=${nechronica.room.id}`, headers: { cookie: nechronicaGm.cookie },
        });
        assert.equal(nechronicaState.statusCode, 200);
        assert.equal(nechronicaState.json().activeScene, 'battle');
        assert.deepEqual(nechronicaState.json().sheets.map((sheet: { characterName: string }) => sheet.characterName), ['Nechronica Hero']);
      } finally {
        await restarted.close();
      }
    });
  } finally {
    for (const socket of sockets) if (socket.readyState === 1) socket.close();
    if (app) await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
