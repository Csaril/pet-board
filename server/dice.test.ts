import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import WebSocket from 'ws';
import type { AppConfig } from './config.js';
import { buildServer } from './index.js';
import { RoomStore } from './store.js';

function nextMessage(socket: WebSocket, predicate: (message: Record<string, unknown>) => boolean, label = 'WebSocket response'): Promise<Record<string, unknown>> {
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

test('dice commands use server randomness, enforce roles, synchronize, reroll and retain only ten persisted records', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tabletop-board-dice-'));
  const config: AppConfig = {
    host: '127.0.0.1', port: 0, dataDir, roomName: 'Campaign', roomCode: 'room-code-with-enough-length',
    gmPassword: 'gm-password-with-enough-length', sessionDays: 30, cookieSecure: false, maxUploadBytes: 1024,
  };
  const store = new RoomStore(dataDir, config.roomName);
  const randomValues = [1, 1, 6, 2, 3, 4, 5, 6];
  let randomIndex = 0;
  const app = await buildServer({ config, store, logger: false, randomInt: (_min, max) => {
    const candidate = randomValues[randomIndex++ % randomValues.length]!;
    return candidate < max ? candidate : max - 1;
  } });
  const sockets: WebSocket[] = [];
  let completed = false;
  let reopenedStore: RoomStore | undefined;
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
      const socket = new WebSocket(`ws://${host}/ws`, { headers: { origin, cookie } }); sockets.push(socket);
      const initialState = nextMessage(socket, (message) => message.type === 'room:state', 'initial room state');
      await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
      const state = await initialState;
      return { socket, state };
    };
    const gmCookie = await login('Keeper', 'gm'); const playerCookie = await login('Ari', 'player');
    const gm = await connect(gmCookie); const player = await connect(playerCookie);
    const actorId = (player.state.identity as { participantId: string }).participantId;
    const command = async (socket: WebSocket, input: Record<string, unknown>, requestId: string, target: WebSocket = socket, expectState = true) => {
      const ack = nextMessage(socket, (message) => message.type === 'command:result' && message.requestId === requestId, `ack ${requestId}`);
      const state = expectState ? nextMessage(target, (message) => message.type === 'room:state' && Array.isArray(message.diceRolls), `state ${requestId}`) : undefined;
      socket.send(JSON.stringify({ ...input, requestId }));
      return { ack: await ack, state: state ? await state : undefined };
    };

    const setSystem = await command(gm.socket, { type: 'room:system:set', systemId: 'pbta-2d6', version: '1.0.0' }, 'system', player.socket);
    assert.equal(setSystem.ack.ok, true);
    assert.deepEqual(setSystem.state!.activeSystem, { id: 'pbta-2d6', version: '1.0.0' });
    const deniedSetting = await command(player.socket, { type: 'room:system:set', systemId: null, version: null }, 'player-system', player.socket, false);
    assert.equal(deniedSetting.ack.ok, false);

    const forged = await command(player.socket, { type: 'dice:pbta', characteristicBonus: 0, situationalModifier: 0, disadvantage: false, dice: [6, 6], total: 12 }, 'forged', player.socket, false);
    assert.equal(forged.ack.ok, false);
    const first = await command(player.socket, { type: 'dice:pbta', characteristicName: 'Focus', characterId: 'character-ari', characterOwnerId: actorId, actorId, characteristicBonus: -10, situationalModifier: 0, disadvantage: false }, 'first', gm.socket);
    assert.equal(first.ack.ok, true);
    const original = (first.state!.diceRolls as Array<Record<string, unknown>>)[0]!;
    assert.deepEqual(original.dice, [1, 1]); assert.equal(original.total, -8); assert.equal(original.category, 'failure'); assert.equal(original.critical, 'critical-failure');
    assert.equal(original.characteristicName, 'Focus'); assert.equal(original.characterId, 'character-ari'); assert.equal(original.characterOwnerId, actorId);

    const repeated = await command(player.socket, { type: 'dice:reroll', rollId: original.id }, 'reroll', gm.socket);
    const reroll = (repeated.state!.diceRolls as Array<Record<string, unknown>>)[0]!;
    assert.equal(reroll.rerollOf, original.id); assert.equal(reroll.characteristicBonus, original.characteristicBonus);
    assert.notDeepEqual(reroll.dice, original.dice); assert.equal((repeated.state!.diceRolls as Array<Record<string, unknown>>).some((entry) => entry.id === original.id), true);

    const disadvantageRoll = await command(player.socket, { type: 'dice:pbta', characteristicBonus: 3, situationalModifier: -1, disadvantage: true }, 'disadvantage', gm.socket);
    const disadvantageEntry = (disadvantageRoll.state!.diceRolls as Array<Record<string, unknown>>)[0]!;
    const disadvantageReroll = await command(player.socket, { type: 'dice:reroll', rollId: disadvantageEntry.id }, 'disadvantage-reroll', gm.socket);
    const repeatedConditions = (disadvantageReroll.state!.diceRolls as Array<Record<string, unknown>>)[0]!;
    assert.deepEqual({ characteristicBonus: repeatedConditions.characteristicBonus, situationalModifier: repeatedConditions.situationalModifier, disadvantage: repeatedConditions.disadvantage, rerollOf: repeatedConditions.rerollOf }, {
      characteristicBonus: 3, situationalModifier: -1, disadvantage: true, rerollOf: disadvantageEntry.id,
    });

    const gmForPlayer = await command(gm.socket, { type: 'dice:pbta', actorId, characteristicBonus: 2, situationalModifier: -1, disadvantage: true }, 'gm-for-player', player.socket);
    assert.equal(gmForPlayer.ack.ok, true);
    const gmEntry = (gmForPlayer.state!.diceRolls as Array<Record<string, unknown>>)[0]!;
    assert.equal(gmEntry.authorName, 'Keeper'); assert.equal(gmEntry.actorName, 'Ari'); assert.equal((gmEntry.keptDice as number[]).length, 2);

    const free = await command(gm.socket, { type: 'dice:free', count: 2, sides: 20 }, 'free', player.socket);
    assert.equal(free.ack.ok, true);
    assert.equal((free.state!.diceRolls as Array<Record<string, unknown>>)[0]!.kind, 'free');
    const beforeLimit = (free.state!.diceRolls as Array<Record<string, unknown>>).at(-1)!.id;

    for (let index = 0; index < 8; index += 1) {
      const response = await command(player.socket, { type: 'dice:free', count: 1, sides: 6 }, `free-${index}`, gm.socket);
      assert.equal(response.ack.ok, true);
    }
    const board = await app.inject({ method: 'GET', url: '/api/board', headers: { cookie: playerCookie } });
    assert.equal(board.statusCode, 200); assert.equal(board.json().diceRolls.length, 10);
    assert.equal(board.json().diceRolls.some((entry: { id: string }) => entry.id === beforeLimit), false);
    completed = true;
  } finally {
    await Promise.all(sockets.map((socket) => new Promise<void>((resolve) => {
      if (socket.readyState === WebSocket.CLOSED) return resolve();
      socket.once('close', () => resolve()); socket.close();
    })));
    await app.close();
    if (completed) {
      reopenedStore = new RoomStore(dataDir, config.roomName);
      assert.equal(reopenedStore.getDiceRolls().length, 10);
      assert.deepEqual(reopenedStore.activeSystem, { id: 'pbta-2d6', version: '1.0.0' });
      reopenedStore.close(); reopenedStore = undefined;
    }
    rmSync(dataDir, { recursive: true, force: true });
  }
});
