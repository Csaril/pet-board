import { randomUUID } from 'node:crypto';
import type { CharacterSheet, DiceRollEntry } from '../../../src/shared/board.js';
import { abilityEventSummary } from '../../../src/shared/ability-history.js';
import { DEFAULT_BOARD_FONT, isBoardFontFamily } from '../../../src/shared/fonts.js';
import type { BoardFontFamily, SheetCharacteristicKey } from '../../../src/shared/board.js';
import { defaultPbtACharacteristics, isPbtACharacteristicKey, pbtaSheetSchema } from '../../../src/modules/system/pbta-2d6/schema.js';
import { calculatePbtARoll, type SituationalModifier } from '../../../src/modules/system/pbta-2d6/roll.js';
import { BoardCommandError, SYSTEM_MISMATCH } from '../../board.js';
import type { RoomStore, Identity } from '../../store.js';
import type {
  SystemRollContext,
  SystemServerModule,
  SystemSheetChanges,
  SystemSheetCommandContext,
} from '../../system-contract.js';

const SYSTEM_ID = 'pbta-2d6';
const SYSTEM_VERSION = '1.0.0';
const MAX_VALUE = 1_000_000_000;
const CHARACTERISTIC_LIMIT = 1000;
const owns = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

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

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BoardCommandError(`${label} должен быть объектом.`);
  return value as Record<string, unknown>;
}

function fontFamilyValue(value: unknown): BoardFontFamily {
  if (!isBoardFontFamily(value)) throw new BoardCommandError('Недопустимый шрифт. Доступны «Стандартный» и «Caveat».');
  return value;
}

function changesObject(value: unknown, allowed: ReadonlySet<string>, label: string): Record<string, unknown> {
  const changes = objectValue(value, label);
  if (!Object.keys(changes).length) throw new BoardCommandError(`${label}: нет изменений.`);
  if (Object.keys(changes).some((key) => !allowed.has(key))) throw new BoardCommandError(`${label}: неизвестное поле.`);
  return changes;
}

function requirePbtASheet(sheet: CharacterSheet): void {
  if (sheet.systemId !== SYSTEM_ID || sheet.systemVersion !== SYSTEM_VERSION) {
    throw new BoardCommandError('Действие доступно только для листов PbtA.', { code: SYSTEM_MISMATCH, statusCode: 409 });
  }
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

function accessibleAssetId(value: unknown, store: RoomStore, identity: Identity, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !value || value.length > 64) throw new BoardCommandError(`${label}: выберите изображение.`);
  if (!store.getAsset(value) || !store.canReadAsset(value, identity)) {
    throw new BoardCommandError(`${label}: изображение недоступно.`);
  }
  return value;
}

function createRoll(context: SystemRollContext): DiceRollEntry {
  const { store, identity, command, activeSystem, randomInt } = context;
  let original: DiceRollEntry | undefined;
  if (command.type === 'dice:reroll') {
    if (Object.keys(command).some((key) => !['type', 'requestId', 'rollId'].includes(key)) || typeof command.rollId !== 'string') {
      throw new BoardCommandError('Некорректная команда повторного броска.');
    }
    original = store.getDiceRolls().find((roll) => roll.id === command.rollId);
    if (!original || original.kind !== 'pbta' || original.actorId !== identity.participantId && identity.role !== 'gm') {
      throw new BoardCommandError('Этот бросок нельзя повторить.');
    }
  } else if (command.type !== 'dice:pbta') {
    throw new BoardCommandError('Неизвестная команда броска.');
  }

  const bonus = original?.characteristicBonus ?? command.characteristicBonus;
  const modifier = original?.situationalModifier ?? command.situationalModifier;
  const disadvantage = original?.disadvantage ?? command.disadvantage;
  const characteristicName = original?.characteristicName
    ?? (typeof command.characteristicName === 'string' ? command.characteristicName.trim().slice(0, 80) || null : null);
  const characterId = original?.characterId ?? (typeof command.characterId === 'string' ? command.characterId : null);
  const characterOwnerId = original?.characterOwnerId ?? (typeof command.characterOwnerId === 'string' ? command.characterOwnerId : null);
  if (original && Object.keys(command).some((key) => !['type', 'requestId', 'rollId'].includes(key))) {
    throw new BoardCommandError('Повторный бросок сохраняет условия исходного.');
  }
  if (!Number.isSafeInteger(bonus) || typeof bonus !== 'number' || Math.abs(bonus) > 1000) {
    throw new BoardCommandError('Некорректный бонус характеристики.');
  }
  if (modifier !== -1 && modifier !== 0 && modifier !== 1) throw new BoardCommandError('Некорректный ситуационный модификатор.');
  if (typeof disadvantage !== 'boolean') throw new BoardCommandError('Некорректное состояние Помехи.');
  if (command.characteristicName !== undefined && (typeof command.characteristicName !== 'string' || command.characteristicName.length > 80)) {
    throw new BoardCommandError('Некорректное название характеристики.');
  }
  if (!original && Object.keys(command).some((key) => !['type', 'requestId', 'characteristicBonus', 'situationalModifier', 'disadvantage', 'characteristicName', 'characterId', 'characterOwnerId', 'actorId'].includes(key))) {
    throw new BoardCommandError('Некорректная команда броска.');
  }
  if ((command.characterId !== undefined && (typeof command.characterId !== 'string' || !command.characterId || command.characterId.length > 128))
    || (command.characterOwnerId !== undefined && (typeof command.characterOwnerId !== 'string' || command.characterOwnerId.length > 128))) {
    throw new BoardCommandError('Некорректная ссылка на персонажа.');
  }
  if ((characterId === null) !== (characterOwnerId === null)) throw new BoardCommandError('Нужны и ID персонажа, и ID владельца.');
  if (!activeSystem || activeSystem.id !== SYSTEM_ID || activeSystem.version !== SYSTEM_VERSION) {
    throw new BoardCommandError('В комнате не закреплена доступная система PbtA.', { code: SYSTEM_MISMATCH, statusCode: 409 });
  }
  if (original && (original.systemId !== activeSystem.id || original.systemVersion !== activeSystem.version)) {
    throw new BoardCommandError('Историческую запись нельзя повторить через текущую системную механику.', { code: SYSTEM_MISMATCH, statusCode: 409 });
  }

  let actor: Identity;
  if (original) {
    actor = { participantId: original.actorId, name: original.actorName, role: 'player' };
  } else if (identity.role === 'gm') {
    if (typeof command.actorId !== 'string' || !store.isPlayerParticipant(command.actorId)) {
      throw new BoardCommandError('Выберите игрока, за которого выполняется бросок.');
    }
    const target = store.getParticipant(command.actorId);
    if (!target || target.role !== 'player') throw new BoardCommandError('Выбранный игрок больше не подключён.');
    actor = target;
  } else {
    if (command.actorId !== undefined && command.actorId !== identity.participantId) {
      throw new BoardCommandError('Игрок может совершать бросок только за себя.');
    }
    actor = identity;
  }
  if (characterOwnerId && characterOwnerId !== actor.participantId) {
    throw new BoardCommandError('Владелец характеристики не совпадает с участником броска.');
  }
  if (original && identity.role !== 'gm' && original.authorId !== identity.participantId) {
    throw new BoardCommandError('Повторный бросок может выполнить его автор.');
  }
  if (!original && characterId && characterOwnerId) {
    const sheet = store.getSheet(characterId);
    if (sheet) {
      if (sheet.systemId !== activeSystem.id || sheet.systemVersion !== activeSystem.version) {
        throw new BoardCommandError('Лист не относится к закреплённой системе PbtA.', { code: SYSTEM_MISMATCH, statusCode: 409 });
      }
      if (!sheet.assignedPlayerId || sheet.assignedPlayerId !== characterOwnerId || sheet.assignedPlayerId !== actor.participantId) {
        throw new BoardCommandError('Лист персонажа не назначен участнику броска.');
      }
      const characteristic = pbtaSheetSchema.characteristics.find((entry) => entry.name === characteristicName);
      if (!characteristic || sheet.characteristics[characteristic.key] !== bonus) {
        throw new BoardCommandError('Бонус не совпадает со значением характеристики в листе персонажа.');
      }
    }
  }
  const result = calculatePbtARoll({
    characteristicBonus: bonus as number,
    situationalModifier: modifier as SituationalModifier,
    disadvantage: disadvantage as boolean,
  }, randomInt);
  return {
    id: randomUUID(),
    authorId: identity.participantId,
    authorName: identity.name,
    actorId: actor.participantId,
    actorName: actor.name,
    createdAt: new Date().toISOString(),
    kind: 'pbta',
    systemId: activeSystem.id,
    systemVersion: activeSystem.version,
    ...result,
    characteristicName,
    characterId,
    characterOwnerId,
    sides: 6,
    disadvantage: disadvantage as boolean,
    rerollOf: original?.id ?? null,
    abilityId: null,
    abilitySheetId: null,
    abilityCharacterName: null,
    abilityName: null,
    abilityAssetId: null,
    abilitySummary: null,
    abilityDescription: null,
    abilityFontFamily: null,
  };
}

function executeSheetCommand(context: SystemSheetCommandContext): boolean {
  const { store, identity, command, sheet } = context;
  switch (command.type) {
    case 'sheet:fate:update': {
      requirePbtASheet(sheet);
      if (Object.keys(command).some((key) => !['type', 'requestId', 'sheetId', 'value'].includes(key))) {
        throw new BoardCommandError('Некорректная команда изменения Силы Судьбы.');
      }
      store.updateSheet(sheet.id, { fate: integer(command.value, 'Сила Судьбы', -MAX_VALUE, MAX_VALUE) });
      return true;
    }
    case 'sheet:counter:value': {
      requirePbtASheet(sheet);
      if (Object.keys(command).some((key) => !['type', 'requestId', 'sheetId', 'id', 'value'].includes(key))) {
        throw new BoardCommandError('Некорректная команда изменения счётчика.');
      }
      const counter = requireCounter(sheet, command.id);
      store.updateCounter(sheet.id, counter.id, { value: integer(command.value, 'значение счётчика', -MAX_VALUE, MAX_VALUE) });
      return true;
    }
    case 'sheet:ability:value': {
      requirePbtASheet(sheet);
      if (Object.keys(command).some((key) => !['type', 'requestId', 'sheetId', 'id', 'counterValue', 'checked'].includes(key))) {
        throw new BoardCommandError('Некорректная команда значения способности.');
      }
      if (!owns(command, 'counterValue') && !owns(command, 'checked')) {
        throw new BoardCommandError('Укажите значение счётчика или состояние чекбокса.');
      }
      const ability = requireAbility(sheet, command.id);
      store.updateAbility(sheet.id, ability.id, {
        ...(owns(command, 'counterValue') ? { counterValue: integer(command.counterValue, 'значение счётчика способности', -MAX_VALUE, MAX_VALUE) } : {}),
        ...(owns(command, 'checked') ? { checked: boolean(command.checked, 'состояние чекбокса') } : {}),
      });
      return true;
    }
    case 'sheet:counter:create': {
      requirePbtASheet(sheet);
      if (Object.keys(command).some((key) => !['type', 'requestId', 'sheetId', 'name', 'value'].includes(key))) {
        throw new BoardCommandError('Некорректная команда счётчика.');
      }
      const value = command.value === undefined ? 0 : integer(command.value, 'значение счётчика', -MAX_VALUE, MAX_VALUE);
      store.createCounter(sheet.id, { id: randomUUID(), name: text(command.name, 'Название счётчика', 80), value });
      return true;
    }
    case 'sheet:counter:update': {
      requirePbtASheet(sheet);
      const counter = requireCounter(sheet, command.id);
      const changes = changesObject(command.changes, new Set(['name', 'value']), 'Изменения счётчика');
      store.updateCounter(sheet.id, counter.id, {
        ...(owns(changes, 'name') ? { name: text(changes.name, 'Название счётчика', 80) } : {}),
        ...(owns(changes, 'value') ? { value: integer(changes.value, 'значение счётчика', -MAX_VALUE, MAX_VALUE) } : {}),
      });
      return true;
    }
    case 'sheet:counter:delete': {
      requirePbtASheet(sheet);
      const counter = requireCounter(sheet, command.id);
      store.deleteCounter(sheet.id, counter.id);
      return true;
    }
    case 'sheet:counter:reorder': {
      requirePbtASheet(sheet);
      store.reorderCounters(sheet.id, orderedIds(command.ids, sheet.counters.map((counter) => counter.id), 'Порядок счётчиков'));
      return true;
    }
    case 'sheet:ability:create': {
      requirePbtASheet(sheet);
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
      return true;
    }
    case 'sheet:ability:update': {
      requirePbtASheet(sheet);
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
      return true;
    }
    case 'sheet:ability:apply': {
      requirePbtASheet(sheet);
      if (Object.keys(command).some((key) => !['type', 'requestId', 'sheetId', 'id'].includes(key))) {
        throw new BoardCommandError('Некорректная команда применения способности.');
      }
      const ability = requireAbility(sheet, command.id);
      const characterName = sheet.characterName || sheet.assignedPlayerName || sheet.creatorName || 'Без имени';
      const entry: DiceRollEntry = {
        id: randomUUID(),
        authorId: identity.participantId,
        authorName: identity.name,
        actorId: sheet.assignedPlayerId ?? identity.participantId,
        actorName: sheet.assignedPlayerName ?? identity.name,
        createdAt: new Date().toISOString(),
        kind: 'ability-use',
        systemId: SYSTEM_ID,
        systemVersion: SYSTEM_VERSION,
        dice: [],
        keptDice: [],
        discardedDie: null,
        characteristicName: null,
        characterId: sheet.id,
        characterOwnerId: sheet.assignedPlayerId,
        characteristicBonus: null,
        situationalModifier: 0,
        disadvantage: false,
        sides: null,
        total: 0,
        category: null,
        critical: null,
        rerollOf: null,
        abilityId: ability.id,
        abilitySheetId: sheet.id,
        abilityCharacterName: characterName,
        abilityName: ability.name || 'Без названия',
        abilityAssetId: ability.assetId,
        abilitySummary: abilityEventSummary(ability.description),
        abilityDescription: ability.description,
        abilityFontFamily: ability.fontFamily,
      };
      store.saveDiceRoll(entry);
      return true;
    }
    case 'sheet:ability:delete': {
      requirePbtASheet(sheet);
      const ability = requireAbility(sheet, command.id);
      store.deleteAbility(sheet.id, ability.id);
      return true;
    }
    case 'sheet:ability:reorder': {
      requirePbtASheet(sheet);
      store.reorderAbilities(sheet.id, orderedIds(command.ids, sheet.abilities.map((ability) => ability.id), 'Порядок способностей'));
      return true;
    }
    default:
      return false;
  }
}

export const systemServerModule: SystemServerModule = {
  id: SYSTEM_ID,
  version: SYSTEM_VERSION,
  advancedSheet: true,
  sheetDefaults() {
    return { characteristics: defaultPbtACharacteristics(), fate: 0 };
  },
  applySheetChanges(sheet, changes): SystemSheetChanges {
    requirePbtASheet(sheet);
    const patch: SystemSheetChanges = {};
    if (owns(changes, 'characteristics')) patch.characteristics = characteristicsFrom(changes.characteristics, sheet.characteristics);
    if (owns(changes, 'fate')) patch.fate = integer(changes.fate, 'Сила Судьбы', -MAX_VALUE, MAX_VALUE);
    return patch;
  },
  executeSheetCommand,
  handlesRollCommand(type) {
    return type === 'dice:pbta' || type === 'dice:reroll';
  },
  createRoll,
};
