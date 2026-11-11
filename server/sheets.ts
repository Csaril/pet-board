import { randomUUID } from 'node:crypto';
import type { BoardFontFamily, CharacterSheet, DiceRollEntry, SheetCharacteristicKey } from '../src/shared/board.js';
import { abilityEventSummary } from '../src/shared/ability-history.js';
import { DEFAULT_BOARD_FONT, isBoardFontFamily } from '../src/shared/fonts.js';
import { defaultPbtACharacteristics, isPbtACharacteristicKey, pbtaSheetSchema, pbtaSystemModule } from '../src/modules/system/pbta-2d6/module.js';
import { BoardCommandError } from './board.js';
import type { RoomStore, Identity } from './store.js';

type Command = Record<string, unknown> & { type?: string; requestId?: unknown };
const owns = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
const MAX_VALUE = 1_000_000_000;
const CHARACTERISTIC_LIMIT = 1000;

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BoardCommandError(`${label} должен быть объектом.`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, maxLength: number, allowEmpty = false): string {
  if (typeof value !== 'string') throw new BoardCommandError(`${label}: ожидается текст.`);
  const trimmed = value.trim();
  if ((!allowEmpty && trimmed.length < 1) || trimmed.length > maxLength) {
    throw new BoardCommandError(`${label}: допустимо ${allowEmpty ? 'до' : 'от 1 до'} ${maxLength} символов.`);
  }
  return trimmed;
}

function integer(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new BoardCommandError(`Недопустимое значение ${label}.`);
  }
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new BoardCommandError(`Недопустимое значение ${label}.`);
  return value;
}

function fontFamilyValue(value: unknown): BoardFontFamily {
  if (!isBoardFontFamily(value)) throw new BoardCommandError('Недопустимый шрифт. Доступны «Стандартный» и «Caveat».');
  return value;
}

function activePbtASystem(store: RoomStore): { id: string; version: string } {
  const active = store.activeSystem;
  if (!active || active.id !== pbtaSystemModule.id || active.version !== pbtaSystemModule.version) {
    throw new BoardCommandError('Листы доступны при активной системе PbtA.');
  }
  return active;
}

function editableSheet(store: RoomStore, identity: Identity, value: unknown): CharacterSheet {
  const id = text(value, 'ID листа', 64);
  const sheet = store.getSheet(id);
  if (!sheet) throw new BoardCommandError('Лист персонажа не найден.');
  if (identity.role !== 'gm' && sheet.assignedPlayerId !== identity.participantId) {
    throw new BoardCommandError('Можно изменять только назначенный вам лист персонажа.');
  }
  return sheet;
}

function accessibleAssetId(value: unknown, store: RoomStore, identity: Identity, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !value || value.length > 64) throw new BoardCommandError(`${label}: выберите изображение.`);
  if (!store.getAsset(value) || !store.canReadAsset(value, identity)) {
    throw new BoardCommandError(`${label}: изображение недоступно.`);
  }
  return value;
}

function changesObject(value: unknown, allowed: ReadonlySet<string>, label: string): Record<string, unknown> {
  const changes = objectValue(value, label);
  if (!Object.keys(changes).length) throw new BoardCommandError(`${label}: нет изменений.`);
  if (Object.keys(changes).some((key) => !allowed.has(key))) throw new BoardCommandError(`${label}: неизвестное поле.`);
  return changes;
}

function characteristicsFrom(value: unknown, current: Record<SheetCharacteristicKey, number>): Record<SheetCharacteristicKey, number> {
  const input = objectValue(value, 'Характеристики');
  if (Object.keys(input).some((key) => !isPbtACharacteristicKey(key))) throw new BoardCommandError('Характеристики содержат неизвестное поле.');
  const result: Record<SheetCharacteristicKey, number> = { ...current };
  for (const [key, raw] of Object.entries(input)) {
    if (!isPbtACharacteristicKey(key)) continue;
    result[key] = integer(raw, `характеристики «${key}»`, -CHARACTERISTIC_LIMIT, CHARACTERISTIC_LIMIT);
  }
  return result;
}

function requireCounter(sheet: CharacterSheet, value: unknown) {
  const id = text(value, 'ID счётчика', 64);
  const counter = sheet.counters.find((entry) => entry.id === id);
  if (!counter) throw new BoardCommandError('Счётчик не найден.');
  return counter;
}

function requireAbility(sheet: CharacterSheet, value: unknown) {
  const id = text(value, 'ID способности', 64);
  const ability = sheet.abilities.find((entry) => entry.id === id);
  if (!ability) throw new BoardCommandError('Способность не найдена.');
  return ability;
}

function orderedIds(value: unknown, currentIds: string[], label: string): string[] {
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string')) throw new BoardCommandError(`${label}: некорректный порядок.`);
  const ids = value as string[];
  if (ids.length !== currentIds.length || new Set(ids).size !== ids.length || ids.some((id) => !currentIds.includes(id))) {
    throw new BoardCommandError(`${label}: укажите каждый элемент ровно один раз.`);
  }
  return ids;
}

export function executeSheetCommand(store: RoomStore, identity: Identity, raw: unknown): void {
  const command = objectValue(raw, 'Команда') as Command;
  switch (command.type) {
    case 'sheet:create': {
      if (Object.keys(command).some((key) => !['type', 'requestId', 'characterName'].includes(key))) throw new BoardCommandError('Некорректная команда создания листа.');
      const active = activePbtASystem(store);
      const characterName = command.characterName === undefined ? '' : text(command.characterName, 'Имя персонажа', 80, true);
      const assignedPlayerId = identity.role === 'player' ? identity.participantId : null;
      store.createSheet({
        id: randomUUID(), creatorId: identity.participantId, creatorName: identity.name,
        assignedPlayerId, assignedPlayerName: assignedPlayerId ? identity.name : null,
        systemId: active.id, systemVersion: active.version, schemaVersion: pbtaSheetSchema.version,
        characterName, portraitAssetId: null, characteristics: defaultPbtACharacteristics(), fate: 0,
      });
      return;
    }
    case 'sheet:delete': {
      if (identity.role !== 'gm') throw new BoardCommandError('Удалять листы может только ведущий.');
      if (Object.keys(command).some((key) => !['type', 'requestId', 'id'].includes(key))) throw new BoardCommandError('Некорректная команда удаления листа.');
      const sheet = store.getSheet(text(command.id, 'ID листа', 64));
      if (!sheet) throw new BoardCommandError('Лист персонажа не найден.');
      if (sheet.assignedPlayerId !== null) throw new BoardCommandError('Нельзя удалить лист, назначенный игроку. Сначала снимите назначение.');
      if (!store.deleteUnassignedSheet(sheet.id)) throw new BoardCommandError('Лист не удалось удалить: он уже назначен или отсутствует.');
      return;
    }
    case 'sheet:assign': {
      if (identity.role !== 'gm') throw new BoardCommandError('Назначать листы может только ведущий.');
      if (Object.keys(command).some((key) => !['type', 'requestId', 'id', 'playerId'].includes(key))) throw new BoardCommandError('Некорректная команда назначения листа.');
      const sheet = store.getSheet(text(command.id, 'ID листа', 64));
      if (!sheet) throw new BoardCommandError('Лист персонажа не найден.');
      if (command.playerId === null) {
        store.assignSheet(sheet.id, null, null);
        return;
      }
      if (typeof command.playerId !== 'string' || command.playerId.length > 128) throw new BoardCommandError('Выберите игрока для назначения.');
      const player = store.getSession(command.playerId);
      if (!player || player.role !== 'player') throw new BoardCommandError('Выбранный участник не является игроком комнаты.');
      store.assignSheet(sheet.id, player.participantId, player.name);
      return;
    }
    case 'sheet:update': {
      const sheet = editableSheet(store, identity, command.id);
      const changes = changesObject(command.changes, new Set(['characterName', 'portraitAssetId', 'characteristics', 'fate', 'fontFamily']), 'Изменения листа');
      const patch: Parameters<RoomStore['updateSheet']>[1] = {};
      if (owns(changes, 'characterName')) patch.characterName = text(changes.characterName, 'Имя персонажа', 80, true);
      if (owns(changes, 'portraitAssetId')) patch.portraitAssetId = accessibleAssetId(changes.portraitAssetId, store, identity, 'Портрет');
      if (owns(changes, 'characteristics')) patch.characteristics = characteristicsFrom(changes.characteristics, sheet.characteristics);
      if (owns(changes, 'fate')) patch.fate = integer(changes.fate, 'Сила Судьбы', -MAX_VALUE, MAX_VALUE);
      if (owns(changes, 'fontFamily')) patch.fontFamily = fontFamilyValue(changes.fontFamily);
      store.updateSheet(sheet.id, patch);
      return;
    }
    case 'sheet:fate:update': {
      const sheet = editableSheet(store, identity, command.sheetId);
      if (Object.keys(command).some((key) => !['type', 'requestId', 'sheetId', 'value'].includes(key))) throw new BoardCommandError('Некорректная команда изменения Силы Судьбы.');
      store.updateSheet(sheet.id, { fate: integer(command.value, 'Сила Судьбы', -MAX_VALUE, MAX_VALUE) });
      return;
    }
    case 'sheet:counter:value': {
      const sheet = editableSheet(store, identity, command.sheetId);
      if (Object.keys(command).some((key) => !['type', 'requestId', 'sheetId', 'id', 'value'].includes(key))) throw new BoardCommandError('Некорректная команда изменения счётчика.');
      const counter = requireCounter(sheet, command.id);
      store.updateCounter(sheet.id, counter.id, { value: integer(command.value, 'значение счётчика', -MAX_VALUE, MAX_VALUE) });
      return;
    }
    case 'sheet:ability:value': {
      const sheet = editableSheet(store, identity, command.sheetId);
      if (Object.keys(command).some((key) => !['type', 'requestId', 'sheetId', 'id', 'counterValue', 'checked'].includes(key))) throw new BoardCommandError('Некорректная команда значения способности.');
      if (!owns(command, 'counterValue') && !owns(command, 'checked')) throw new BoardCommandError('Укажите значение счётчика или состояние чекбокса.');
      const ability = requireAbility(sheet, command.id);
      store.updateAbility(sheet.id, ability.id, {
        ...(owns(command, 'counterValue') ? { counterValue: integer(command.counterValue, 'значение счётчика способности', -MAX_VALUE, MAX_VALUE) } : {}),
        ...(owns(command, 'checked') ? { checked: boolean(command.checked, 'состояние чекбокса') } : {}),
      });
      return;
    }
    case 'sheet:counter:create': {
      const sheet = editableSheet(store, identity, command.sheetId);
      if (Object.keys(command).some((key) => !['type', 'requestId', 'sheetId', 'name', 'value'].includes(key))) throw new BoardCommandError('Некорректная команда счётчика.');
      const value = command.value === undefined ? 0 : integer(command.value, 'значение счётчика', -MAX_VALUE, MAX_VALUE);
      store.createCounter(sheet.id, { id: randomUUID(), name: text(command.name, 'Название счётчика', 80), value });
      return;
    }
    case 'sheet:counter:update': {
      const sheet = editableSheet(store, identity, command.sheetId);
      const counter = requireCounter(sheet, command.id);
      const changes = changesObject(command.changes, new Set(['name', 'value']), 'Изменения счётчика');
      store.updateCounter(sheet.id, counter.id, {
        ...(owns(changes, 'name') ? { name: text(changes.name, 'Название счётчика', 80) } : {}),
        ...(owns(changes, 'value') ? { value: integer(changes.value, 'значение счётчика', -MAX_VALUE, MAX_VALUE) } : {}),
      });
      return;
    }
    case 'sheet:counter:delete': {
      const sheet = editableSheet(store, identity, command.sheetId);
      const counter = requireCounter(sheet, command.id);
      store.deleteCounter(sheet.id, counter.id);
      return;
    }
    case 'sheet:counter:reorder': {
      const sheet = editableSheet(store, identity, command.sheetId);
      store.reorderCounters(sheet.id, orderedIds(command.ids, sheet.counters.map((counter) => counter.id), 'Порядок счётчиков'));
      return;
    }
    case 'sheet:ability:create': {
      const sheet = editableSheet(store, identity, command.sheetId);
      const allowed = new Set(['type', 'requestId', 'sheetId', 'name', 'description', 'assetId', 'counterEnabled', 'counterName', 'counterValue', 'checkboxEnabled', 'checkboxLabel', 'checked', 'fontFamily']);
      if (Object.keys(command).some((key) => !allowed.has(key))) throw new BoardCommandError('Некорректная команда способности.');
      const id = randomUUID();
      store.createAbility(sheet.id, {
        id,
        name: command.name === undefined ? 'Новая способность' : text(command.name, 'Название способности', 80),
        description: command.description === undefined ? '' : text(command.description, 'Описание способности', 8000, true),
        assetId: command.assetId === undefined ? null : accessibleAssetId(command.assetId, store, identity, 'Изображение способности'),
        counterEnabled: command.counterEnabled === undefined ? false : boolean(command.counterEnabled, 'счётчик способности'),
        counterName: command.counterName === undefined ? '' : text(command.counterName, 'Название счётчика способности', 80, true),
        counterValue: command.counterValue === undefined ? 0 : integer(command.counterValue, 'значение счётчика способности', -MAX_VALUE, MAX_VALUE),
        checkboxEnabled: command.checkboxEnabled === undefined ? false : boolean(command.checkboxEnabled, 'чекбокс способности'),
        checkboxLabel: command.checkboxLabel === undefined ? '' : text(command.checkboxLabel, 'Подпись чекбокса', 80, true),
        checked: command.checked === undefined ? false : boolean(command.checked, 'состояние чекбокса'),
        fontFamily: command.fontFamily === undefined ? DEFAULT_BOARD_FONT : fontFamilyValue(command.fontFamily),
      });
      return;
    }
    case 'sheet:ability:update': {
      const sheet = editableSheet(store, identity, command.sheetId);
      const ability = requireAbility(sheet, command.id);
      const changes = changesObject(command.changes, new Set(['name', 'description', 'assetId', 'counterEnabled', 'counterName', 'counterValue', 'checkboxEnabled', 'checkboxLabel', 'checked', 'fontFamily']), 'Изменения способности');
      const patch: Parameters<RoomStore['updateAbility']>[2] = {};
      if (owns(changes, 'name')) patch.name = text(changes.name, 'Название способности', 80);
      if (owns(changes, 'description')) patch.description = text(changes.description, 'Описание способности', 8000, true);
      if (owns(changes, 'assetId')) patch.assetId = accessibleAssetId(changes.assetId, store, identity, 'Изображение способности');
      if (owns(changes, 'counterEnabled')) patch.counterEnabled = boolean(changes.counterEnabled, 'счётчик способности');
      if (owns(changes, 'counterName')) patch.counterName = text(changes.counterName, 'Название счётчика способности', 80, true);
      if (owns(changes, 'counterValue')) patch.counterValue = integer(changes.counterValue, 'значение счётчика способности', -MAX_VALUE, MAX_VALUE);
      if (owns(changes, 'checkboxEnabled')) patch.checkboxEnabled = boolean(changes.checkboxEnabled, 'чекбокс способности');
      if (owns(changes, 'checkboxLabel')) patch.checkboxLabel = text(changes.checkboxLabel, 'Подпись чекбокса', 80, true);
      if (owns(changes, 'checked')) patch.checked = boolean(changes.checked, 'состояние чекбокса');
      if (owns(changes, 'fontFamily')) patch.fontFamily = fontFamilyValue(changes.fontFamily);
      store.updateAbility(sheet.id, ability.id, patch);
      return;
    }
    case 'sheet:ability:apply': {
      const sheet = editableSheet(store, identity, command.sheetId);
      if (Object.keys(command).some((key) => !['type', 'requestId', 'sheetId', 'id'].includes(key))) throw new BoardCommandError('Некорректная команда применения способности.');
      const ability = requireAbility(sheet, command.id);
      const characterName = sheet.characterName || sheet.assignedPlayerName || sheet.creatorName || 'Без имени';
      const entry: DiceRollEntry = {
        id: randomUUID(), authorId: identity.participantId, authorName: identity.name,
        actorId: sheet.assignedPlayerId ?? identity.participantId,
        actorName: sheet.assignedPlayerName ?? identity.name,
        createdAt: new Date().toISOString(), kind: 'ability-use',
        dice: [], keptDice: [], discardedDie: null, characteristicName: null, characterId: sheet.id,
        characterOwnerId: sheet.assignedPlayerId, characteristicBonus: null, situationalModifier: 0,
        disadvantage: false, sides: null, total: 0, category: null, critical: null, rerollOf: null,
        abilityId: ability.id, abilitySheetId: sheet.id, abilityCharacterName: characterName,
        abilityName: ability.name || 'Без названия', abilityAssetId: ability.assetId,
        abilitySummary: abilityEventSummary(ability.description), abilityDescription: ability.description,
        abilityFontFamily: ability.fontFamily,
      };
      store.saveDiceRoll(entry);
      return;
    }
    case 'sheet:ability:delete': {
      const sheet = editableSheet(store, identity, command.sheetId);
      const ability = requireAbility(sheet, command.id);
      store.deleteAbility(sheet.id, ability.id);
      return;
    }
    case 'sheet:ability:reorder': {
      const sheet = editableSheet(store, identity, command.sheetId);
      store.reorderAbilities(sheet.id, orderedIds(command.ids, sheet.abilities.map((ability) => ability.id), 'Порядок способностей'));
      return;
    }
    default:
      throw new BoardCommandError('Неизвестная команда листа персонажа.');
  }
}
