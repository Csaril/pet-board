import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { deflateSync } from 'node:zlib';
import Database from 'better-sqlite3';
import WebSocket from 'ws';
import type { CharacterSheet } from '../src/shared/board.js';
import {
  buildSheetRollContext, canChangeSheetStructure, clampFloatingPosition, DEFAULT_SHEET_PANEL_MODE, formatSigned,
  readCollapsedAbilities, readSheetPanelPreference, readSheetRollPanelPreference, setAbilityCollapsed,
  sheetPanelStorageKey, sheetRollPanelStorageKey, toggleSheetMode, writeSheetPanelPreference, writeSheetRollPanelPreference,
} from '../src/shared/sheet-ui.js';
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

function multipart(boundary: string, filename: string, mime: string, data: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`),
    data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
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

const sheetById = (state: Record<string, unknown>, id: string): CharacterSheet | undefined =>
  (state.sheets as CharacterSheet[]).find((sheet) => sheet.id === id);
const sheetNamed = (state: Record<string, unknown>, name: string): CharacterSheet | undefined =>
  (state.sheets as CharacterSheet[]).find((sheet) => sheet.characterName === name);

const indexSource = readFileSync('src/pages/index.astro', 'utf8');
const clientSource = readFileSync('src/client/app.ts', 'utf8');
const styleSource = readFileSync('src/styles/global.css', 'utf8');

test('multi-sheet PbtA workflow covers acceptance scenarios 1-31', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tabletop-board-sheets-'));
  const config: AppConfig = {
    host: '127.0.0.1', port: 0, dataDir, roomName: 'Campaign', roomCode: 'room-code-with-enough-length',
    gmPassword: 'gm-password-with-enough-length', sessionDays: 30, cookieSecure: false, maxUploadBytes: 25 * 1024 * 1024,
  };
  const store = new RoomStore(dataDir, config.roomName);
  const randomValues = [1, 2, 3, 4, 5, 6];
  let randomIndex = 0;
  const app = await buildServer({ config, store, logger: false, randomInt: (_min, max) => {
    const candidate = randomValues[randomIndex++ % randomValues.length]!;
    return candidate < max ? candidate : max - 1;
  } });
  const sockets: WebSocket[] = [];
  const socketCookies = new WeakMap<WebSocket, string>();
  let completed = false;
  let ownerSheet: CharacterSheet | undefined;
  let preparedOne: CharacterSheet | undefined;
  let preparedTwo: CharacterSheet | undefined;
  let secondOwnSheet: CharacterSheet | undefined;
  let viewerParticipantId: string | undefined;
  try {
    const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    const { host } = new URL(baseUrl);
    const origin = `http://${host}`;
    const login = async (name: string, role: 'gm' | 'player') => {
      const response = await app.inject({ method: 'POST', url: '/api/session', headers: { origin, host }, payload: { name, role, roomCode: config.roomCode, gmPassword: role === 'gm' ? config.gmPassword : undefined } });
      assert.equal(response.statusCode, 200);
      return { cookie: (response.headers['set-cookie'] as string).split(';')[0]!, participantId: response.json().identity.participantId as string, name };
    };
    const connect = async (cookie: string) => {
      const socket = new WebSocket(`ws://${host}/ws`, { headers: { origin, cookie } }); sockets.push(socket);
      socketCookies.set(socket, cookie);
      const initialState = nextMessage(socket, (message) => message.type === 'room:state', 'initial room state');
      await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
      return { socket, state: await initialState };
    };
    const board = async (cookie: string) => {
      const response = await app.inject({ method: 'GET', url: '/api/board', headers: { cookie } });
      assert.equal(response.statusCode, 200);
      return response.json() as Record<string, unknown>;
    };
    const command = async (socket: WebSocket, input: Record<string, unknown>, requestId: string, target: WebSocket = socket, expectState = true) => {
      const ack = nextMessage(socket, (message) => message.type === 'command:result' && message.requestId === requestId, `ack ${requestId}`);
      socket.send(JSON.stringify({ ...input, requestId }));
      const ackMessage = await ack;
      const state = expectState ? await board(socketCookies.get(target)!) : undefined;
      return { ack: ackMessage, state };
    };
    const upload = async (cookie: string, filename: string, data: Buffer) => {
      const boundary = `sheet-boundary-${filename}`;
      return app.inject({
        method: 'POST', url: '/api/assets', headers: { origin, host, cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload: multipart(boundary, filename, 'image/png', data),
      });
    };

    const gm = await login('Keeper', 'gm');
    const owner = await login('Ari', 'player');
    const viewer = await login('Bea', 'player');
    viewerParticipantId = viewer.participantId;
    const gmSocket = await connect(gm.cookie);
    const ownerSocket = await connect(owner.cookie);
    const viewerSocket = await connect(viewer.cookie);

    const system = await command(gmSocket.socket, { type: 'room:system:set', systemId: 'pbta-2d6', version: '1.0.0' }, 'system', viewerSocket.socket);
    assert.equal(system.ack.ok, true);

    await t.test('1. Лист по умолчанию открывается в режиме просмотра', () => {
      assert.equal(DEFAULT_SHEET_PANEL_MODE, 'view');
      assert.match(clientSource, /sheetDialogMode = DEFAULT_SHEET_PANEL_MODE/);
      assert.match(indexSource, /id="sheet-panel"/);
    });

    await t.test('2. Режим редактирования включается отдельной кнопкой', () => {
      assert.equal(toggleSheetMode('view'), 'edit');
      assert.equal(toggleSheetMode('edit'), 'view');
      assert.match(indexSource, /id="sheet-edit-toggle"/);
      assert.match(clientSource, /sheetEditToggle\.addEventListener\('click'/);
    });

    await t.test('3. Структурные изменения недоступны в режиме просмотра', () => {
      assert.equal(canChangeSheetStructure('view', true), false);
      assert.equal(canChangeSheetStructure('view', false), false);
      assert.equal(canChangeSheetStructure('edit', true), true);
      assert.match(clientSource, /const editing = canChangeSheetStructure\(sheetDialogMode, canEdit\)/);
    });

    await t.test('4. Сила Судьбы изменяется в режиме просмотра владельцем', async () => {
      const created = await command(ownerSocket.socket, { type: 'sheet:create', characterName: 'Ари' }, 'create-owner', viewerSocket.socket);
      assert.equal(created.ack.ok, true);
      ownerSheet = sheetNamed(created.state!, 'Ари')!;
      assert.equal(ownerSheet.creatorId, owner.participantId);
      assert.equal(ownerSheet.creatorName, 'Ari');
      assert.equal(ownerSheet.assignedPlayerId, owner.participantId);
      assert.equal(ownerSheet.assignedPlayerName, 'Ari');
      assert.equal('ownerId' in ownerSheet, false);
      const fate = await command(ownerSocket.socket, { type: 'sheet:fate:update', sheetId: ownerSheet.id, value: 3 }, 'view-fate', viewerSocket.socket);
      assert.equal(fate.ack.ok, true);
      assert.equal(sheetById(fate.state!, ownerSheet.id)!.fate, 3);
    });

    await t.test('5. Дополнительные счётчики изменяются в режиме просмотра владельцем', async () => {
      const energy = await command(ownerSocket.socket, { type: 'sheet:counter:create', sheetId: ownerSheet!.id, name: 'Энергия', value: 1 }, 'counter-energy', viewerSocket.socket);
      assert.equal(energy.ack.ok, true);
      ownerSheet = sheetById(energy.state!, ownerSheet!.id)!;
      const energyId = ownerSheet.counters.find((counter) => counter.name === 'Энергия')!.id;
      const value = await command(ownerSocket.socket, { type: 'sheet:counter:value', sheetId: ownerSheet.id, id: energyId, value: 5 }, 'view-counter', viewerSocket.socket);
      assert.equal(value.ack.ok, true);
      assert.equal(sheetById(value.state!, ownerSheet.id)!.counters.find((counter) => counter.id === energyId)!.value, 5);
      const renameInView = await command(ownerSocket.socket, { type: 'sheet:counter:value', sheetId: ownerSheet.id, id: energyId, name: 'Взлом' }, 'view-counter-name', ownerSocket.socket, false);
      assert.equal(renameInView.ack.ok, false);
    });

    await t.test('6. Счётчики способностей и чекбоксы работают в режиме просмотра', async () => {
      const shield = await command(ownerSocket.socket, {
        type: 'sheet:ability:create', sheetId: ownerSheet!.id, name: 'Щит', description: 'Первая строка\nВторая строка',
        counterEnabled: true, counterName: 'Заряды', counterValue: 3, checkboxEnabled: true, checkboxLabel: 'Использовано', checked: false,
      }, 'ability-shield', viewerSocket.socket);
      assert.equal(shield.ack.ok, true);
      ownerSheet = sheetById(shield.state!, ownerSheet!.id)!;
      const shieldId = ownerSheet.abilities[0]!.id;
      const value = await command(ownerSocket.socket, { type: 'sheet:ability:value', sheetId: ownerSheet.id, id: shieldId, counterValue: 2, checked: true }, 'view-ability-value', viewerSocket.socket);
      assert.equal(value.ack.ok, true);
      ownerSheet = sheetById(value.state!, ownerSheet.id)!;
      assert.equal(ownerSheet.abilities[0]!.counterValue, 2);
      assert.equal(ownerSheet.abilities[0]!.checked, true);
      const forged = await command(ownerSocket.socket, { type: 'sheet:ability:value', sheetId: ownerSheet.id, id: shieldId, name: 'Взлом' }, 'view-ability-name', ownerSocket.socket, false);
      assert.equal(forged.ack.ok, false);
    });

    await t.test('7. Чужие счётчики недоступны для изменения обычным игрокам', async () => {
      const counterId = ownerSheet!.counters[0]!.id;
      const abilityId = ownerSheet!.abilities[0]!.id;
      const fate = await command(viewerSocket.socket, { type: 'sheet:fate:update', sheetId: ownerSheet!.id, value: 99 }, 'viewer-fate', viewerSocket.socket, false);
      const counter = await command(viewerSocket.socket, { type: 'sheet:counter:value', sheetId: ownerSheet!.id, id: counterId, value: 99 }, 'viewer-counter', viewerSocket.socket, false);
      const ability = await command(viewerSocket.socket, { type: 'sheet:ability:value', sheetId: ownerSheet!.id, id: abilityId, checked: false }, 'viewer-ability', viewerSocket.socket, false);
      assert.equal(fate.ack.ok, false);
      assert.equal(counter.ack.ok, false);
      assert.equal(ability.ack.ok, false);
    });

    await t.test('8. Нажатие на характеристику открывает окно броска поверх листа', () => {
      assert.match(indexSource, /id="sheet-roll-panel"/);
      assert.match(indexSource, /id="sheet-roll-controls"/);
      assert.match(clientSource, /function prepareSheetRoll/);
      assert.match(clientSource, /openSheetRollPanel\(characteristicName\)/);
      assert.match(clientSource, /name\.addEventListener\('click', \(\) => prepareSheetRoll/);
    });

    await t.test('9. Лист остаётся открытым при окне броска', () => {
      const rollOpen = clientSource.slice(clientSource.indexOf('function openSheetRollPanel'), clientSource.indexOf('function closeSheetRollPanel'));
      assert.doesNotMatch(rollOpen, /sheetPanel\.hidden = true/);
      assert.match(clientSource, /if \(!sheetPanel\.hidden\) sheetPanel\.style\.zIndex/);
    });

    await t.test('10. Бонус и название характеристики передаются в существующую систему', async () => {
      const context = buildSheetRollContext({ id: 'sheet-1', assignedPlayerId: 'owner-1', characteristics: { might: -2, insight: 0, glory: 1, will: 3 } }, 'might', 'Могущество');
      assert.deepEqual(context, { characteristicName: 'Могущество', characteristicBonus: -2, characterId: 'sheet-1', characterOwnerId: 'owner-1' });
      const traits = await command(ownerSocket.socket, { type: 'sheet:update', id: ownerSheet!.id, changes: { characteristics: { might: 2, insight: -1, glory: 1, will: 3 } } }, 'traits', viewerSocket.socket);
      assert.equal(traits.ack.ok, true);
      const roll = await command(ownerSocket.socket, {
        type: 'dice:pbta', characteristicName: 'Могущество', characteristicBonus: 2,
        characterId: ownerSheet!.id, characterOwnerId: owner.participantId, situationalModifier: 1, disadvantage: true,
      }, 'roll-might', viewerSocket.socket);
      assert.equal(roll.ack.ok, true);
      const entry = (roll.state!.diceRolls as Array<Record<string, unknown>>)[0]!;
      assert.equal(entry.characteristicName, 'Могущество');
      assert.equal(entry.characteristicBonus, 2);
      assert.equal(entry.situationalModifier, 1);
      assert.equal(entry.disadvantage, true);
      assert.equal(entry.characterOwnerId, owner.participantId);
      const forged = await command(ownerSocket.socket, {
        type: 'dice:pbta', characteristicName: 'Могущество', characteristicBonus: 5,
        characterId: ownerSheet!.id, characterOwnerId: owner.participantId, situationalModifier: 0, disadvantage: false,
      }, 'roll-forged', ownerSocket.socket, false);
      assert.equal(forged.ack.ok, false);
    });

    await t.test('11. Окно броска не закрывается за панелью персонажа', () => {
      const sheetRule = styleSource.match(/\.floating-sheet-panel \{[^}]*z-index:\s*(\d+)/);
      const rollRule = styleSource.match(/\.sheet-roll-panel \{[^}]*z-index:\s*(\d+)/);
      assert.ok(sheetRule && rollRule);
      assert.ok(Number(rollRule![1]) > Number(sheetRule![1]));
    });

    await t.test('12. Панель не блокирует поле за пределами своих границ', () => {
      assert.doesNotMatch(indexSource, /<dialog id="sheet-dialog"/);
      assert.doesNotMatch(styleSource, /\.floating-sheet-panel::backdrop/);
      assert.match(indexSource, /class="floating-sheet-panel"/);
    });

    await t.test('13. Панель можно перемещать за заголовок', () => {
      assert.match(indexSource, /class="sheet-panel-heading" data-panel-drag-handle/);
      assert.match(clientSource, /makeFloatingPanelDraggable\(sheetPanel, 'sheet'\)/);
    });

    await t.test('14. Панель можно сворачивать и разворачивать', () => {
      assert.match(indexSource, /id="sheet-collapse"/);
      assert.match(clientSource, /function setSheetCollapsed/);
      assert.match(styleSource, /\.floating-sheet-panel\.is-collapsed #sheet-panel-body/);
    });

    await t.test('15. Положение сохраняется локально', () => {
      const values = new Map<string, string>();
      const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
      writeSheetPanelPreference(storage, 'participant-a', { version: 1, open: true, collapsed: true, x: 120, y: 80, sheetId: 'sheet-1' });
      assert.deepEqual(readSheetPanelPreference(storage, 'participant-a'), { version: 1, open: true, collapsed: true, x: 120, y: 80, sheetId: 'sheet-1' });
      assert.deepEqual(clampFloatingPosition(900, 700, 300, 200, 1000, 800), { x: 700, y: 600 });
    });

    await t.test('16. Настройки двух разных участников не пересекаются', () => {
      const values = new Map<string, string>();
      const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
      writeSheetPanelPreference(storage, 'participant-a', { version: 1, open: true, collapsed: false, x: 10, y: 20, sheetId: 'sheet-a' });
      writeSheetPanelPreference(storage, 'participant-b', { version: 1, open: false, collapsed: true, x: 30, y: 40, sheetId: 'sheet-b' });
      assert.notEqual(sheetPanelStorageKey('participant-a'), sheetPanelStorageKey('participant-b'));
      assert.equal(readSheetPanelPreference(storage, 'participant-a')!.x, 10);
      assert.equal(readSheetPanelPreference(storage, 'participant-b')!.y, 40);
    });

    await t.test('16a. Окно броска перетаскивается, сбрасывается и хранит позицию отдельно для каждого пользователя', () => {
      assert.match(indexSource, /class="sheet-roll-heading" data-panel-drag-handle/);
      assert.match(indexSource, /id="sheet-roll-reset"/);
      assert.match(clientSource, /makeFloatingPanelDraggable\(sheetRollPanel, 'sheet-roll'\)/);
      assert.match(styleSource, /\.sheet-roll-heading\[data-panel-drag-handle\]/);
      const values = new Map<string, string>();
      const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
      assert.equal(readSheetRollPanelPreference(storage, 'participant-a'), undefined);
      writeSheetRollPanelPreference(storage, 'participant-a', 210, 140);
      assert.deepEqual(readSheetRollPanelPreference(storage, 'participant-a'), { x: 210, y: 140 });
      writeSheetRollPanelPreference(storage, 'participant-a', null, null);
      assert.equal(readSheetRollPanelPreference(storage, 'participant-a'), undefined);
      assert.notEqual(sheetRollPanelStorageKey('participant-a'), sheetRollPanelStorageKey('participant-b'));
    });

    await t.test('16b. Поля характеристик имеют достаточную ширину и не сжимаются', () => {
      assert.match(styleSource, /grid-template-columns: repeat\(auto-fit, minmax\(148px, 1fr\)\)/);
      assert.match(styleSource, /\.sheet-stepper input \{[^}]*min-width: 56px[^}]*flex: 1 1 56px[^}]*appearance: textfield/s);
      assert.match(styleSource, /font-variant-numeric: tabular-nums/);
    });

    await t.test('17. Камера доски не перемещается при перетаскивании листа', () => {
      const dragFunction = clientSource.slice(clientSource.indexOf('function makeFloatingPanelDraggable'), clientSource.indexOf('function updateBoard'));
      assert.doesNotMatch(dragFunction, /stage\.|camera\./);
      assert.match(dragFunction, /panel\.style\.left/);
      assert.match(dragFunction, /panel\.style\.top/);
    });

    await t.test('18. Игрок может создать два и более листа', async () => {
      const created = await command(ownerSocket.socket, { type: 'sheet:create', characterName: 'Ари Вторая' }, 'create-second', ownerSocket.socket);
      assert.equal(created.ack.ok, true);
      secondOwnSheet = sheetNamed(created.state!, 'Ари Вторая')!;
      assert.equal(secondOwnSheet.assignedPlayerId, owner.participantId);
      const response = await app.inject({ method: 'GET', url: '/api/sheets', headers: { cookie: owner.cookie } });
      const sheets = response.json().sheets as CharacterSheet[];
      assert.ok(sheets.filter((sheet) => sheet.assignedPlayerId === owner.participantId).length >= 2);
    });

    await t.test('19. Ведущий может создать несколько неназначенных листов', async () => {
      const first = await command(gmSocket.socket, { type: 'sheet:create', characterName: 'Первый заготовка' }, 'gm-create-1', gmSocket.socket);
      const second = await command(gmSocket.socket, { type: 'sheet:create', characterName: 'Вторая заготовка' }, 'gm-create-2', gmSocket.socket);
      assert.equal(first.ack.ok, true);
      assert.equal(second.ack.ok, true);
      const gmState = await board(gm.cookie);
      preparedOne = sheetNamed(gmState, 'Первый заготовка')!;
      preparedTwo = sheetNamed(gmState, 'Вторая заготовка')!;
      assert.equal(preparedOne.assignedPlayerId, null);
      assert.equal(preparedTwo.assignedPlayerId, null);
      assert.equal(preparedOne.creatorId, gm.participantId);
    });

    await t.test('20. Неназначенные листы видны только ведущему', async () => {
      const uploadResponse = await upload(gm.cookie, 'draft-portrait.png', pngFixture(60));
      const portraitId = uploadResponse.json().asset.id as string;
      const update = await command(gmSocket.socket, { type: 'sheet:update', id: preparedOne!.id, changes: { portraitAssetId: portraitId } }, 'draft-portrait-update', gmSocket.socket);
      assert.equal(update.ack.ok, true);
      preparedOne = sheetById(await board(gm.cookie), preparedOne!.id)!;
      const ownerBoard = await board(owner.cookie);
      assert.equal(sheetById(ownerBoard, preparedOne.id), undefined);
      assert.equal(sheetNamed(ownerBoard, 'Первый заготовка'), undefined);
      const viewerList = await app.inject({ method: 'GET', url: '/api/sheets', headers: { cookie: viewer.cookie } });
      assert.equal((viewerList.json().sheets as CharacterSheet[]).some((sheet) => sheet.id === preparedOne!.id), false);
      const detail = await app.inject({ method: 'GET', url: `/api/sheets/${preparedOne.id}`, headers: { cookie: owner.cookie } });
      assert.equal(detail.statusCode, 404);
      const asset = await app.inject({ method: 'GET', url: `/api/assets/${portraitId}`, headers: { cookie: owner.cookie } });
      assert.equal(asset.statusCode, 404);
    });

    await t.test('21. Ведущий может назначить лист игроку', async () => {
      const assigned = await command(gmSocket.socket, { type: 'sheet:assign', id: preparedOne!.id, playerId: owner.participantId }, 'assign-first', ownerSocket.socket);
      assert.equal(assigned.ack.ok, true);
      preparedOne = sheetById(assigned.state!, preparedOne!.id)!;
      assert.equal(preparedOne.assignedPlayerId, owner.participantId);
      assert.equal(preparedOne.assignedPlayerName, 'Ari');
      assert.ok(sheetById(assigned.state!, preparedOne.id), 'assigned player sees the sheet');
      const ownerBoardState = await board(owner.cookie);
      assert.ok(sheetById(ownerBoardState, preparedOne.id));
      const asset = await app.inject({ method: 'GET', url: `/api/assets/${preparedOne.portraitAssetId}`, headers: { cookie: owner.cookie } });
      assert.equal(asset.statusCode, 200);
    });

    await t.test('22. Назначенный игрок видит и редактирует лист', async () => {
      const edit = await command(ownerSocket.socket, { type: 'sheet:update', id: preparedOne!.id, changes: { characterName: 'Первый назначенный' } }, 'owner-edit-assigned', ownerSocket.socket);
      assert.equal(edit.ack.ok, true);
      assert.equal(sheetById(edit.state!, preparedOne!.id)!.characterName, 'Первый назначенный');
    });

    await t.test('23. Один игрок может иметь несколько назначенных листов', async () => {
      const assigned = await command(gmSocket.socket, { type: 'sheet:assign', id: preparedTwo!.id, playerId: owner.participantId }, 'assign-second', ownerSocket.socket);
      assert.equal(assigned.ack.ok, true);
      const ownerSheets = await app.inject({ method: 'GET', url: '/api/sheets', headers: { cookie: owner.cookie } });
      const assignedToOwner = (ownerSheets.json().sheets as CharacterSheet[]).filter((sheet) => sheet.assignedPlayerId === owner.participantId);
      assert.ok(assignedToOwner.length >= 4);
      assert.ok(assignedToOwner.some((sheet) => sheet.id === ownerSheet!.id));
      assert.ok(assignedToOwner.some((sheet) => sheet.id === secondOwnSheet!.id));
      assert.ok(assignedToOwner.some((sheet) => sheet.id === preparedTwo!.id));
    });

    await t.test('24. Другие игроки могут просматривать назначенный лист', async () => {
      const viewerBoard = await board(viewer.cookie);
      assert.ok(sheetById(viewerBoard, preparedOne!.id));
      const detail = await app.inject({ method: 'GET', url: `/api/sheets/${preparedOne!.id}`, headers: { cookie: viewer.cookie } });
      assert.equal(detail.statusCode, 200);
      assert.equal(detail.json().sheet.characterName, 'Первый назначенный');
    });

    await t.test('25. Другие игроки не могут редактировать чужой лист', async () => {
      const edit = await command(viewerSocket.socket, { type: 'sheet:update', id: preparedOne!.id, changes: { characterName: 'Взлом' } }, 'viewer-edit-foreign', viewerSocket.socket, false);
      const value = await command(viewerSocket.socket, { type: 'sheet:fate:update', sheetId: preparedOne!.id, value: 999 }, 'viewer-value-foreign', viewerSocket.socket, false);
      assert.equal(edit.ack.ok, false);
      assert.equal(value.ack.ok, false);
    });

    await t.test('26. Ведущий может переназначить лист', async () => {
      const assigned = await command(gmSocket.socket, { type: 'sheet:assign', id: preparedOne!.id, playerId: viewer.participantId }, 'reassign-first', viewerSocket.socket);
      assert.equal(assigned.ack.ok, true);
      preparedOne = sheetById(assigned.state!, preparedOne!.id)!;
      assert.equal(preparedOne.assignedPlayerId, viewer.participantId);
      assert.equal(preparedOne.assignedPlayerName, 'Bea');
      assert.equal(sheetById(assigned.state!, preparedOne.id)!.characterName, 'Первый назначенный');
    });

    await t.test('27. После переназначения старый игрок теряет права редактирования', async () => {
      const denied = await command(ownerSocket.socket, { type: 'sheet:update', id: preparedOne!.id, changes: { characterName: 'Взлом' } }, 'old-owner-edit', ownerSocket.socket, false);
      assert.equal(denied.ack.ok, false);
      const allowed = await command(viewerSocket.socket, { type: 'sheet:update', id: preparedOne!.id, changes: { characterName: 'Теперь у Би' } }, 'new-owner-edit', viewerSocket.socket);
      assert.equal(allowed.ack.ok, true);
      const ownerBoard = await board(owner.cookie);
      assert.ok(sheetById(ownerBoard, preparedOne!.id), 'другие игроки сохраняют просмотр назначенного листа');
    });

    await t.test('28. Ведущий может снять назначение', async () => {
      const cleared = await command(gmSocket.socket, { type: 'sheet:assign', id: preparedTwo!.id, playerId: null }, 'clear-assignment', gmSocket.socket);
      assert.equal(cleared.ack.ok, true);
      preparedTwo = sheetById(cleared.state!, preparedTwo!.id)!;
      assert.equal(preparedTwo.assignedPlayerId, null);
      assert.equal(preparedTwo.assignedPlayerName, null);
    });

    await t.test('29. После снятия назначения лист становится доступным только ведущему', async () => {
      const ownerBoard = await board(owner.cookie);
      const viewerBoard = await board(viewer.cookie);
      assert.equal(sheetById(ownerBoard, preparedTwo!.id), undefined);
      assert.equal(sheetById(viewerBoard, preparedTwo!.id), undefined);
      const detail = await app.inject({ method: 'GET', url: `/api/sheets/${preparedTwo!.id}`, headers: { cookie: owner.cookie } });
      assert.equal(detail.statusCode, 404);
      const gmBoard = await board(gm.cookie);
      assert.ok(sheetById(gmBoard, preparedTwo!.id));
      assert.equal(sheetById(gmBoard, preparedTwo!.id)!.characterName, 'Вторая заготовка');
    });

    completed = true;
  } finally {
    await Promise.all(sockets.map((socket) => new Promise<void>((resolve) => {
      if (socket.readyState === WebSocket.CLOSED) return resolve();
      socket.once('close', () => resolve()); socket.close();
    })));
    await app.close();
  }

  try {
    if (completed) {
      await t.test('30. Существующие листы корректно сохраняются после миграции', () => {
        const migrationDir = mkdtempSync(join(tmpdir(), 'tabletop-board-sheet-migration-'));
        try {
          const legacy = new Database(join(migrationDir, 'room.sqlite'));
          legacy.exec(`
            CREATE TABLE room (
              id INTEGER PRIMARY KEY CHECK (id = 1),
              name TEXT NOT NULL,
              created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            INSERT INTO room (id, name) VALUES (1, 'Legacy campaign');
            CREATE TABLE character_sheets (
              id TEXT PRIMARY KEY,
              owner_id TEXT NOT NULL,
              owner_name TEXT NOT NULL,
              system_id TEXT NOT NULL,
              system_version TEXT NOT NULL,
              schema_version INTEGER NOT NULL,
              character_name TEXT NOT NULL DEFAULT '',
              portrait_asset_id TEXT,
              characteristics_json TEXT NOT NULL,
              fate INTEGER NOT NULL DEFAULT 0,
              created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
              updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
              UNIQUE (owner_id, system_id)
            );
            CREATE TABLE character_counters (
              id TEXT PRIMARY KEY, sheet_id TEXT NOT NULL REFERENCES character_sheets(id) ON DELETE CASCADE,
              name TEXT NOT NULL, value INTEGER NOT NULL, order_index INTEGER NOT NULL
            );
            CREATE TABLE character_abilities (
              id TEXT PRIMARY KEY, sheet_id TEXT NOT NULL REFERENCES character_sheets(id) ON DELETE CASCADE,
              name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', asset_id TEXT,
              counter_enabled INTEGER NOT NULL DEFAULT 0, counter_name TEXT NOT NULL DEFAULT '',
              counter_value INTEGER NOT NULL DEFAULT 0, checkbox_enabled INTEGER NOT NULL DEFAULT 0,
              checkbox_label TEXT NOT NULL DEFAULT '', checked INTEGER NOT NULL DEFAULT 0, order_index INTEGER NOT NULL
            );
            INSERT INTO character_sheets (id, owner_id, owner_name, system_id, system_version, schema_version, character_name, characteristics_json, fate)
            VALUES ('legacy-sheet-1', 'legacy-owner-1', 'Old Ari', 'pbta-2d6', '1.0.0', 1, 'Старый Ари', '{"might":2,"insight":1,"glory":0,"will":-1}', 4);
            INSERT INTO character_sheets (id, owner_id, owner_name, system_id, system_version, schema_version, character_name, characteristics_json, fate)
            VALUES ('legacy-sheet-2', 'legacy-owner-2', 'Old Bea', 'pbta-2d6', '1.0.0', 1, 'Старая Би', '{"might":0,"insight":2,"glory":1,"will":0}', 1);
            INSERT INTO character_counters VALUES ('legacy-counter-1', 'legacy-sheet-1', 'Энергия', 3, 0);
            INSERT INTO character_abilities VALUES ('legacy-ability-1', 'legacy-sheet-1', 'Щит', 'Описание', NULL, 1, 'Заряды', 2, 1, 'Использовано', 1, 0);
          `);
          legacy.close();
          const migrated = new RoomStore(migrationDir, 'Fallback name');
          try {
            const sheets = migrated.getSheets();
            assert.equal(sheets.length, 2);
            const first = sheets.find((sheet) => sheet.id === 'legacy-sheet-1')!;
            const second = sheets.find((sheet) => sheet.id === 'legacy-sheet-2')!;
            assert.equal(first.creatorId, 'legacy-owner-1');
            assert.equal(first.assignedPlayerId, 'legacy-owner-1');
            assert.equal(first.assignedPlayerName, 'Old Ari');
            assert.equal(first.characterName, 'Старый Ари');
            assert.deepEqual(first.characteristics, { might: 2, insight: 1, glory: 0, will: -1 });
            assert.equal(first.fate, 4);
            assert.equal(first.counters[0]!.name, 'Энергия');
            assert.equal(first.abilities[0]!.name, 'Щит');
            assert.equal(second.assignedPlayerId, 'legacy-owner-2');
            assert.equal(new Set(sheets.map((sheet) => sheet.id)).size, 2);
            const schema = migrated.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'character_sheets'").get() as { sql: string };
            assert.doesNotMatch(schema.sql, /UNIQUE\s*\(\s*owner_id/i);
            assert.doesNotThrow(() => migrated.createSheet({
              id: 'legacy-sheet-3', creatorId: 'legacy-owner-1', creatorName: 'Old Ari',
              assignedPlayerId: 'legacy-owner-1', assignedPlayerName: 'Old Ari',
              systemId: 'pbta-2d6', systemVersion: '1.0.0', schemaVersion: 1,
              characterName: 'Второй лист того же игрока', portraitAssetId: null,
              characteristics: { might: 0, insight: 0, glory: 0, will: 0 }, fate: 0,
            }));
            assert.equal(migrated.getSheets().length, 3);
            assert.deepEqual(migrated.db.pragma('foreign_key_check'), []);
          } finally {
            migrated.close();
          }
        } finally {
          rmSync(migrationDir, { recursive: true, force: true });
        }
      });

      await t.test('31. Все листы восстанавливаются после перезапуска', () => {
        const reopened = new RoomStore(dataDir, config.roomName);
        try {
          const sheets = reopened.getSheets();
          assert.equal(sheets.length, 4);
          const first = sheets.find((sheet) => sheet.id === ownerSheet!.id)!;
          assert.equal(first.characterName, 'Ари');
          assert.equal(first.fate, 3);
          assert.equal(first.counters[0]!.name, 'Энергия');
          assert.equal(first.abilities[0]!.name, 'Щит');
          assert.equal(first.abilities[0]!.description.includes('\n'), true);
          const prepared = sheets.find((sheet) => sheet.id === preparedOne!.id)!;
          assert.equal(prepared.assignedPlayerId, viewerParticipantId);
          assert.equal(prepared.characterName, 'Теперь у Би');
          const cleared = sheets.find((sheet) => sheet.id === preparedTwo!.id)!;
          assert.equal(cleared.assignedPlayerId, null);
          assert.equal(cleared.characterName, 'Вторая заготовка');
          assert.equal(readdirSync(join(dataDir, 'assets')).length >= 1, true);
        } finally {
          reopened.close();
        }
      });
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('local sheet panel preferences and ability collapse are per participant', () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  assert.equal(formatSigned(4), '+4');
  assert.equal(formatSigned(0), '0');
  assert.equal(formatSigned(-3), '-3');
  setAbilityCollapsed(storage, 'participant-a', 'sheet-1', 'ability-1', true);
  setAbilityCollapsed(storage, 'participant-b', 'sheet-1', 'ability-2', true);
  assert.deepEqual([...readCollapsedAbilities(storage, 'participant-a', 'sheet-1')], ['ability-1']);
  assert.deepEqual([...readCollapsedAbilities(storage, 'participant-b', 'sheet-1')], ['ability-2']);
  setAbilityCollapsed(storage, 'participant-a', 'sheet-1', 'ability-1', false);
  assert.deepEqual([...readCollapsedAbilities(storage, 'participant-a', 'sheet-1')], []);
});
