import { randomUUID } from 'node:crypto';
import type { CharacterSheet, DiceRollEntry, SheetCharacteristicKey, SheetReferenceSnapshot } from '../../../src/shared/board.js';
import { BoardCommandError, SYSTEM_MISMATCH } from '../../board.js';
import type { Identity, RoomStore } from '../../store.js';
import {
  createDefaultNechronicaSheetData,
  isCurrentNechronicaSheetData,
  isNechronicaBodyZone,
  isNechronicaDeployment,
  migrateNechronicaSheetData,
  NECHRONICA_LIMITS,
  NECHRONICA_SHEET_SCHEMA_VERSION,
  NechronicaSheetSchemaError,
  parseNechronicaSheetData,
  type NechronicaAbility,
  type NechronicaBodyPart,
  type NechronicaBodyZone,
  type NechronicaDeployment,
  type NechronicaFetter,
  type NechronicaMemory,
  type NechronicaSheetData,
} from '../../../src/modules/system/nechronica/schema-1.1.0.js';
import type {
  SystemRoomMigrationContext,
  SystemRoomMigrationReport,
  SystemRoomVerificationContext,
  SystemServerModule,
  SystemSheetChanges,
  SystemSheetCommandContext,
} from '../../system-contract.js';

const SYSTEM_ID = 'nechronica';
const SYSTEM_VERSION = '1.1.0';
const MAX_VALUE = 1_000_000_000;
const owns = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

type Collection = 'abilities' | 'body' | 'fetters' | 'memories';
const COLLECTIONS: readonly Collection[] = ['abilities', 'body', 'fetters', 'memories'];

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BoardCommandError(`${label} должен быть объектом.`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, maxLength: number, allowEmpty = true): string {
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

function assertKeys(command: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set(['type', 'requestId', 'sheetId', ...allowed]);
  if (Object.keys(command).some((key) => !allowedSet.has(key))) {
    throw new BoardCommandError('Некорректная команда листа Nechronica.');
  }
}

function changesObject(value: unknown, allowed: ReadonlySet<string>, label: string): Record<string, unknown> {
  const changes = objectValue(value, label);
  if (!Object.keys(changes).length) throw new BoardCommandError(`${label}: нет изменений.`);
  if (Object.keys(changes).some((key) => !allowed.has(key))) throw new BoardCommandError(`${label}: неизвестное поле.`);
  return changes;
}

function requireNechronicaSheet(sheet: CharacterSheet): void {
  if (sheet.systemId !== SYSTEM_ID || sheet.systemVersion !== SYSTEM_VERSION) {
    throw new BoardCommandError('Действие доступно только для листов Nechronica 1.1.0.', { code: SYSTEM_MISMATCH, statusCode: 409 });
  }
}

function readData(sheet: CharacterSheet): NechronicaSheetData {
  try {
    return parseNechronicaSheetData(sheet.systemData);
  } catch (error) {
    if (error instanceof NechronicaSheetSchemaError) {
      throw new BoardCommandError(error.message, { code: error.code, statusCode: 409 });
    }
    throw error;
  }
}

function saveData(context: SystemSheetCommandContext, data: NechronicaSheetData): void {
  context.store.updateSheetSystemData(context.sheet.id, data);
}

function collectionValue(value: unknown): Collection {
  if (typeof value !== 'string' || !(COLLECTIONS as readonly string[]).includes(value)) {
    throw new BoardCommandError('Неизвестная коллекция листа Nechronica.');
  }
  return value as Collection;
}

function zoneValue(value: unknown): NechronicaBodyZone {
  if (!isNechronicaBodyZone(value)) throw new BoardCommandError('Неизвестная зона тела.');
  return value;
}

function assetIdValue(value: unknown, store: RoomStore, identity: Identity, label: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !value || value.length > 64) throw new BoardCommandError(`${label}: выберите изображение.`);
  if (!store.getAsset(value) || !store.canReadAsset(value, identity)) {
    throw new BoardCommandError(`${label}: изображение недоступно.`);
  }
  return value;
}

function orderedIds(value: unknown, currentIds: string[], label: string): string[] {
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string')) throw new BoardCommandError(`${label}: некорректный порядок.`);
  const ids = value as string[];
  if (ids.length !== currentIds.length || new Set(ids).size !== ids.length || ids.some((id) => !currentIds.includes(id))) {
    throw new BoardCommandError(`${label}: укажите каждый элемент ровно один раз.`);
  }
  return ids;
}

function itemId(value: unknown): string {
  return text(value, 'ID элемента', 64, false);
}

function requireAbility(data: NechronicaSheetData, value: unknown): NechronicaAbility {
  const id = itemId(value);
  const ability = data.abilities.find((entry) => entry.id === id);
  if (!ability) throw new BoardCommandError('Способность не найдена.');
  return ability;
}

function requireBodyPart(data: NechronicaSheetData, zone: NechronicaBodyZone, value: unknown): NechronicaBodyPart {
  const id = itemId(value);
  const part = data.bodyParts[zone].find((entry) => entry.id === id);
  if (!part) throw new BoardCommandError('Часть тела не найдена в выбранной зоне.');
  return part;
}

function requireFetter(data: NechronicaSheetData, value: unknown): NechronicaFetter {
  const id = itemId(value);
  const fetter = data.fetters.find((entry) => entry.id === id);
  if (!fetter) throw new BoardCommandError('Уза не найдена.');
  return fetter;
}

function requireMemory(data: NechronicaSheetData, value: unknown): NechronicaMemory {
  const id = itemId(value);
  const memory = data.memories.find((entry) => entry.id === id);
  if (!memory) throw new BoardCommandError('Воспоминание не найдено.');
  return memory;
}

/* ---------- Item validation ---------- */

function newAbility(input: Record<string, unknown>, store: RoomStore, identity: Identity): NechronicaAbility {
  return {
    id: randomUUID(),
    imageAssetId: assetIdValue(input.imageAssetId, store, identity, 'Изображение способности'),
    name: text(input.name ?? '', 'Название способности', NECHRONICA_LIMITS.name),
    source: text(input.source ?? '', 'Источник способности', NECHRONICA_LIMITS.source),
    type: text(input.type ?? '', 'Тип способности', NECHRONICA_LIMITS.type),
    timing: text(input.timing ?? '', 'Тайминг способности', NECHRONICA_LIMITS.timing),
    cost: text(input.cost ?? '', 'Цена способности', NECHRONICA_LIMITS.cost),
    range: text(input.range ?? '', 'Дистанция способности', NECHRONICA_LIMITS.range),
    effect: text(input.effect ?? '', 'Эффект способности', NECHRONICA_LIMITS.effect),
    used: false,
  };
}

function applyAbilityChanges(
  ability: NechronicaAbility,
  changes: Record<string, unknown>,
  store: RoomStore,
  identity: Identity,
): NechronicaAbility {
  const next = { ...ability };
  if (owns(changes, 'imageAssetId')) next.imageAssetId = assetIdValue(changes.imageAssetId, store, identity, 'Изображение способности');
  if (owns(changes, 'name')) next.name = text(changes.name, 'Название способности', NECHRONICA_LIMITS.name);
  if (owns(changes, 'source')) next.source = text(changes.source, 'Источник способности', NECHRONICA_LIMITS.source);
  if (owns(changes, 'type')) next.type = text(changes.type, 'Тип способности', NECHRONICA_LIMITS.type);
  if (owns(changes, 'timing')) next.timing = text(changes.timing, 'Тайминг способности', NECHRONICA_LIMITS.timing);
  if (owns(changes, 'cost')) next.cost = text(changes.cost, 'Цена способности', NECHRONICA_LIMITS.cost);
  if (owns(changes, 'range')) next.range = text(changes.range, 'Дистанция способности', NECHRONICA_LIMITS.range);
  if (owns(changes, 'effect')) next.effect = text(changes.effect, 'Эффект способности', NECHRONICA_LIMITS.effect);
  return next;
}

function newBodyPart(input: Record<string, unknown>, store: RoomStore, identity: Identity): NechronicaBodyPart {
  return {
    id: randomUUID(),
    imageAssetId: assetIdValue(input.imageAssetId, store, identity, 'Изображение части тела'),
    name: text(input.name ?? '', 'Название части тела', NECHRONICA_LIMITS.name),
    timing: text(input.timing ?? '', 'Тайминг части тела', NECHRONICA_LIMITS.timing),
    cost: text(input.cost ?? '', 'Цена части тела', NECHRONICA_LIMITS.cost),
    range: text(input.range ?? '', 'Дистанция части тела', NECHRONICA_LIMITS.range),
    effect: text(input.effect ?? '', 'Эффект части тела', NECHRONICA_LIMITS.effect),
    used: false,
    destroyed: false,
  };
}

function applyBodyPartChanges(
  part: NechronicaBodyPart,
  changes: Record<string, unknown>,
  store: RoomStore,
  identity: Identity,
): NechronicaBodyPart {
  const next = { ...part };
  if (owns(changes, 'imageAssetId')) next.imageAssetId = assetIdValue(changes.imageAssetId, store, identity, 'Изображение части тела');
  if (owns(changes, 'name')) next.name = text(changes.name, 'Название части тела', NECHRONICA_LIMITS.name);
  if (owns(changes, 'timing')) next.timing = text(changes.timing, 'Тайминг части тела', NECHRONICA_LIMITS.timing);
  if (owns(changes, 'cost')) next.cost = text(changes.cost, 'Цена части тела', NECHRONICA_LIMITS.cost);
  if (owns(changes, 'range')) next.range = text(changes.range, 'Дистанция части тела', NECHRONICA_LIMITS.range);
  if (owns(changes, 'effect')) next.effect = text(changes.effect, 'Эффект части тела', NECHRONICA_LIMITS.effect);
  return next;
}

function newFetter(input: Record<string, unknown>, store: RoomStore, identity: Identity): NechronicaFetter {
  return {
    id: randomUUID(),
    imageAssetId: assetIdValue(input.imageAssetId, store, identity, 'Изображение узы'),
    target: text(input.target ?? '', 'Имя или цель узы', NECHRONICA_LIMITS.target),
    fetter: text(input.fetter ?? '', 'Уза', NECHRONICA_LIMITS.fetter),
    madness: text(input.madness ?? '', 'Безумие', NECHRONICA_LIMITS.madness),
    description: text(input.description ?? '', 'Описание узы', NECHRONICA_LIMITS.description),
    spentMadness: [false, false, false, false],
  };
}

function applyFetterChanges(
  fetter: NechronicaFetter,
  changes: Record<string, unknown>,
  store: RoomStore,
  identity: Identity,
): NechronicaFetter {
  const next = { ...fetter };
  if (owns(changes, 'imageAssetId')) next.imageAssetId = assetIdValue(changes.imageAssetId, store, identity, 'Изображение узы');
  if (owns(changes, 'target')) next.target = text(changes.target, 'Имя или цель узы', NECHRONICA_LIMITS.target);
  if (owns(changes, 'fetter')) next.fetter = text(changes.fetter, 'Уза', NECHRONICA_LIMITS.fetter);
  if (owns(changes, 'madness')) next.madness = text(changes.madness, 'Безумие', NECHRONICA_LIMITS.madness);
  if (owns(changes, 'description')) next.description = text(changes.description, 'Описание узы', NECHRONICA_LIMITS.description);
  return next;
}

function newMemory(input: Record<string, unknown>): NechronicaMemory {
  return {
    id: randomUUID(),
    name: text(input.name ?? '', 'Название воспоминания', NECHRONICA_LIMITS.memoryName),
    number: integer(input.number ?? 0, 'Номер воспоминания', 0, NECHRONICA_LIMITS.number),
    content: text(input.content ?? '', 'Описание воспоминания', NECHRONICA_LIMITS.memoryContent),
  };
}

function applyMemoryChanges(memory: NechronicaMemory, changes: Record<string, unknown>): NechronicaMemory {
  const next = { ...memory };
  if (owns(changes, 'name')) next.name = text(changes.name, 'Название воспоминания', NECHRONICA_LIMITS.memoryName);
  if (owns(changes, 'number')) next.number = integer(changes.number, 'Номер воспоминания', 0, NECHRONICA_LIMITS.number);
  if (owns(changes, 'content')) next.content = text(changes.content, 'Описание воспоминания', NECHRONICA_LIMITS.memoryContent);
  return next;
}

/* ---------- History reference cards ---------- */

function referenceForAbility(ability: NechronicaAbility): SheetReferenceSnapshot {
  return {
    type: 'ability',
    imageAssetId: ability.imageAssetId,
    name: ability.name,
    source: ability.source || null,
    timing: ability.timing || null,
    cost: ability.cost || null,
    range: ability.range || null,
    target: null,
    fetter: null,
    madness: null,
    madnessSpent: null,
    description: ability.effect,
  };
}

function referenceForBodyPart(part: NechronicaBodyPart): SheetReferenceSnapshot {
  return {
    type: 'body',
    imageAssetId: part.imageAssetId,
    name: part.name,
    source: null,
    timing: part.timing || null,
    cost: part.cost || null,
    range: part.range || null,
    target: null,
    fetter: null,
    madness: null,
    madnessSpent: null,
    description: part.effect,
  };
}

function referenceForFetter(fetter: NechronicaFetter): SheetReferenceSnapshot {
  return {
    type: 'fetter',
    imageAssetId: fetter.imageAssetId,
    name: fetter.target || fetter.fetter || 'Уза',
    source: null,
    timing: null,
    cost: null,
    range: null,
    target: fetter.target || null,
    fetter: fetter.fetter || null,
    madness: fetter.madness || null,
    madnessSpent: fetter.spentMadness.filter(Boolean).length,
    description: fetter.description,
  };
}

function saveReferenceCard(
  store: RoomStore,
  identity: Identity,
  sheet: CharacterSheet,
  snapshot: SheetReferenceSnapshot,
): void {
  const entry: DiceRollEntry = {
    id: randomUUID(),
    authorId: identity.participantId,
    authorName: identity.name,
    actorId: sheet.assignedPlayerId ?? identity.participantId,
    actorName: sheet.assignedPlayerName ?? identity.name,
    createdAt: new Date().toISOString(),
    kind: 'sheet-reference',
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
    abilityId: null,
    abilitySheetId: null,
    abilityCharacterName: null,
    abilityName: null,
    abilityAssetId: null,
    abilitySummary: null,
    abilityDescription: null,
    abilityFontFamily: null,
    reference: snapshot,
  };
  store.saveDiceRoll(entry);
}

/* ---------- Command dispatch ---------- */

function executeSheetCommand(context: SystemSheetCommandContext): boolean {
  const { store, identity, command, sheet } = context;
  const data = readData(sheet);
  switch (command.type) {
    case 'sheet:nechronica:ap': {
      assertKeys(command, ['maxAp', 'currentAp']);
      if (!owns(command, 'maxAp') && !owns(command, 'currentAp')) throw new BoardCommandError('Укажите Maximum AP или Current AP.');
      if (owns(command, 'maxAp')) data.profile.maxAp = integer(command.maxAp, 'Maximum AP', 0, MAX_VALUE);
      if (owns(command, 'currentAp')) data.profile.currentAp = integer(command.currentAp, 'Current AP', 0, MAX_VALUE);
      saveData(context, data);
      return true;
    }
    case 'sheet:nechronica:profile': {
      assertKeys(command, ['deployment', 'approval']);
      if (!owns(command, 'deployment') && !owns(command, 'approval')) throw new BoardCommandError('Укажите Deployment или Одобрение.');
      if (owns(command, 'deployment')) {
        if (command.deployment !== null && !isNechronicaDeployment(command.deployment)) throw new BoardCommandError('Неизвестное значение Deployment.');
        data.profile.deployment = command.deployment as NechronicaDeployment | null;
      }
      if (owns(command, 'approval')) data.profile.approval = integer(command.approval, 'Одобрение', 0, MAX_VALUE);
      saveData(context, data);
      return true;
    }
    case 'sheet:nechronica:info': {
      assertKeys(command, ['changes']);
      const changes = changesObject(command.changes, new Set(['position', 'mainClass', 'secondaryClass', 'premonition', 'armaments', 'mutations', 'enhancements', 'notes']), 'Информация персонажа');
      if (owns(changes, 'position')) data.info.position = text(changes.position, 'Позиция', NECHRONICA_LIMITS.position);
      if (owns(changes, 'mainClass')) data.info.mainClass = text(changes.mainClass, 'Основной класс', NECHRONICA_LIMITS.className);
      if (owns(changes, 'secondaryClass')) data.info.secondaryClass = text(changes.secondaryClass, 'Побочный класс', NECHRONICA_LIMITS.className);
      if (owns(changes, 'premonition')) data.info.premonition = text(changes.premonition, 'Предчувствие', NECHRONICA_LIMITS.premonition);
      if (owns(changes, 'armaments')) data.info.armaments = integer(changes.armaments, 'Вооружение', 0, MAX_VALUE);
      if (owns(changes, 'mutations')) data.info.mutations = integer(changes.mutations, 'Мутации', 0, MAX_VALUE);
      if (owns(changes, 'enhancements')) data.info.enhancements = integer(changes.enhancements, 'Улучшения', 0, MAX_VALUE);
      if (owns(changes, 'notes')) data.info.notes = text(changes.notes, 'Заметки персонажа', NECHRONICA_LIMITS.notes);
      saveData(context, data);
      return true;
    }
    case 'sheet:nechronica:used': {
      assertKeys(command, ['collection', 'zone', 'id', 'used']);
      const collection = collectionValue(command.collection);
      const used = boolean(command.used, 'Used');
      if (collection === 'body') {
        const zone = zoneValue(command.zone);
        const part = requireBodyPart(data, zone, command.id);
        part.used = used;
      } else if (collection === 'abilities') {
        requireAbility(data, command.id).used = used;
      } else {
        throw new BoardCommandError('Used относится только к способностям и частям тела.');
      }
      saveData(context, data);
      return true;
    }
    case 'sheet:nechronica:destroyed': {
      assertKeys(command, ['zone', 'id', 'destroyed']);
      const zone = zoneValue(command.zone);
      const part = requireBodyPart(data, zone, command.id);
      part.destroyed = boolean(command.destroyed, 'Destroyed');
      saveData(context, data);
      return true;
    }
    case 'sheet:nechronica:madness': {
      assertKeys(command, ['id', 'index', 'checked']);
      const fetter = requireFetter(data, command.id);
      const index = integer(command.index, 'ячейка безумия', 0, 3);
      fetter.spentMadness[index] = boolean(command.checked, 'ячейка безумия');
      saveData(context, data);
      return true;
    }
    case 'sheet:nechronica:reset-used': {
      assertKeys(command, ['collection', 'zone']);
      const collection = collectionValue(command.collection);
      if (collection === 'abilities') {
        for (const ability of data.abilities) ability.used = false;
      } else if (collection === 'body') {
        const zones: NechronicaBodyZone[] = owns(command, 'zone') ? [zoneValue(command.zone)] : ['head', 'arms', 'torso', 'legs'];
        for (const zone of zones) for (const part of data.bodyParts[zone]) part.used = false;
      } else {
        throw new BoardCommandError('Сброс Used относится только к способностям и частям тела.');
      }
      saveData(context, data);
      return true;
    }
    case 'sheet:nechronica:create': {
      assertKeys(command, ['collection', 'zone', 'item']);
      const collection = collectionValue(command.collection);
      const item = objectValue(command.item, 'Элемент');
      if (collection === 'abilities') {
        data.abilities.push(newAbility(item, store, identity));
      } else if (collection === 'body') {
        const zone = zoneValue(command.zone);
        data.bodyParts[zone].push(newBodyPart(item, store, identity));
      } else if (collection === 'fetters') {
        data.fetters.push(newFetter(item, store, identity));
      } else {
        data.memories.push(newMemory(item));
      }
      saveData(context, data);
      return true;
    }
    case 'sheet:nechronica:update': {
      assertKeys(command, ['collection', 'zone', 'id', 'changes']);
      const collection = collectionValue(command.collection);
      const changes = objectValue(command.changes, 'Изменения элемента');
      if (collection === 'abilities') {
        const ability = requireAbility(data, command.id);
        const allowed = new Set(['imageAssetId', 'name', 'source', 'type', 'timing', 'cost', 'range', 'effect']);
        if (Object.keys(changes).some((key) => !allowed.has(key))) throw new BoardCommandError('Изменения способности содержат неизвестное поле.');
        Object.assign(ability, applyAbilityChanges(ability, changes, store, identity));
      } else if (collection === 'body') {
        const zone = zoneValue(command.zone);
        const part = requireBodyPart(data, zone, command.id);
        const allowed = new Set(['imageAssetId', 'name', 'timing', 'cost', 'range', 'effect']);
        if (Object.keys(changes).some((key) => !allowed.has(key))) throw new BoardCommandError('Изменения части тела содержат неизвестное поле.');
        Object.assign(part, applyBodyPartChanges(part, changes, store, identity));
      } else if (collection === 'fetters') {
        const fetter = requireFetter(data, command.id);
        const allowed = new Set(['imageAssetId', 'target', 'fetter', 'madness', 'description']);
        if (Object.keys(changes).some((key) => !allowed.has(key))) throw new BoardCommandError('Изменения узы содержат неизвестное поле.');
        Object.assign(fetter, applyFetterChanges(fetter, changes, store, identity));
      } else {
        const memory = requireMemory(data, command.id);
        const allowed = new Set(['name', 'number', 'content']);
        if (Object.keys(changes).some((key) => !allowed.has(key))) throw new BoardCommandError('Изменения воспоминания содержат неизвестное поле.');
        Object.assign(memory, applyMemoryChanges(memory, changes));
      }
      saveData(context, data);
      return true;
    }
    case 'sheet:nechronica:delete': {
      assertKeys(command, ['collection', 'zone', 'id']);
      const collection = collectionValue(command.collection);
      if (collection === 'abilities') {
        const ability = requireAbility(data, command.id);
        data.abilities = data.abilities.filter((entry) => entry.id !== ability.id);
      } else if (collection === 'body') {
        const zone = zoneValue(command.zone);
        const part = requireBodyPart(data, zone, command.id);
        data.bodyParts[zone] = data.bodyParts[zone].filter((entry) => entry.id !== part.id);
      } else if (collection === 'fetters') {
        const fetter = requireFetter(data, command.id);
        data.fetters = data.fetters.filter((entry) => entry.id !== fetter.id);
      } else {
        const memory = requireMemory(data, command.id);
        data.memories = data.memories.filter((entry) => entry.id !== memory.id);
      }
      saveData(context, data);
      return true;
    }
    case 'sheet:nechronica:reorder': {
      assertKeys(command, ['collection', 'zone', 'ids']);
      const collection = collectionValue(command.collection);
      if (collection === 'abilities') {
        const ids = orderedIds(command.ids, data.abilities.map((entry) => entry.id), 'Порядок способностей');
        const byId = new Map(data.abilities.map((entry) => [entry.id, entry]));
        data.abilities = ids.map((id) => byId.get(id)!);
      } else if (collection === 'body') {
        const zone = zoneValue(command.zone);
        const ids = orderedIds(command.ids, data.bodyParts[zone].map((entry) => entry.id), 'Порядок частей тела');
        const byId = new Map(data.bodyParts[zone].map((entry) => [entry.id, entry]));
        data.bodyParts[zone] = ids.map((id) => byId.get(id)!);
      } else if (collection === 'fetters') {
        const ids = orderedIds(command.ids, data.fetters.map((entry) => entry.id), 'Порядок уз');
        const byId = new Map(data.fetters.map((entry) => [entry.id, entry]));
        data.fetters = ids.map((id) => byId.get(id)!);
      } else {
        const ids = orderedIds(command.ids, data.memories.map((entry) => entry.id), 'Порядок воспоминаний');
        const byId = new Map(data.memories.map((entry) => [entry.id, entry]));
        data.memories = ids.map((id) => byId.get(id)!);
      }
      saveData(context, data);
      return true;
    }
    case 'sheet:nechronica:reference': {
      assertKeys(command, ['kind', 'zone', 'id']);
      const kind = command.kind;
      if (kind === 'ability') {
        saveReferenceCard(store, identity, sheet, referenceForAbility(requireAbility(data, command.id)));
      } else if (kind === 'body') {
        const zone = zoneValue(command.zone);
        saveReferenceCard(store, identity, sheet, referenceForBodyPart(requireBodyPart(data, zone, command.id)));
      } else if (kind === 'fetter') {
        saveReferenceCard(store, identity, sheet, referenceForFetter(requireFetter(data, command.id)));
      } else {
        throw new BoardCommandError('Неизвестный тип справочной карточки.');
      }
      return true;
    }
    default:
      return false;
  }
}

function applySheetChanges(sheet: CharacterSheet, changes: Record<string, unknown>): SystemSheetChanges {
  requireNechronicaSheet(sheet);
  if (owns(changes, 'characteristics') || owns(changes, 'fate')) {
    throw new BoardCommandError('Nechronica не использует характеристики и Силу Судьбы PbtA.', { code: SYSTEM_MISMATCH, statusCode: 409 });
  }
  return {};
}

/**
 * Room-level migration for the exact target pair. Sheets already on the target
 * schema are left byte-identical; a future schema aborts the whole transaction.
 */
function migrateRoomSheets(context: SystemRoomMigrationContext): SystemRoomMigrationReport {
  const { store, target } = context;
  if (target.id !== SYSTEM_ID || target.version !== SYSTEM_VERSION) {
    throw new BoardCommandError('Модуль Nechronica 1.1.0 не может мигрировать другую системную пару.', { code: SYSTEM_MISMATCH, statusCode: 409 });
  }
  return store.migrateRoomSystemAndSheets({
    targetVersion: target.version,
    targetSchemaVersion: target.schemaVersion,
    migrateSheet(sheet, rawSystemData) {
      if (
        sheet.systemVersion === target.version
        && sheet.schemaVersion === target.schemaVersion
        && isCurrentNechronicaSheetData(sheet.systemData)
      ) {
        return null;
      }
      return {
        schemaVersion: NECHRONICA_SHEET_SCHEMA_VERSION,
        // Use the exact stored JSON: `null` means "never written", while corrupt
        // JSON must abort the migration instead of being replaced with defaults.
        systemData: migrateNechronicaSheetData(rawSystemData),
      };
    },
  });
}

/** Read-only post-migration check used on a staged database copy. */
function verifyRoomSheets(context: SystemRoomVerificationContext): string[] {
  const { store, target } = context;
  const problems: string[] = [];
  for (const sheet of store.getSheetsBySystem(SYSTEM_ID)) {
    const label = `Лист ${sheet.id} (${sheet.characterName || 'без имени'})`;
    if (sheet.systemVersion !== target.version) {
      problems.push(`${label}: версия системы ${sheet.systemVersion}, ожидается ${target.version}.`);
      continue;
    }
    if (sheet.schemaVersion !== target.schemaVersion) {
      problems.push(`${label}: схема ${sheet.schemaVersion}, ожидается ${target.schemaVersion}.`);
      continue;
    }
    if (sheet.systemData === null) {
      problems.push(`${label}: отсутствуют системные данные.`);
      continue;
    }
    try {
      const data = parseNechronicaSheetData(sheet.systemData);
      if (data.schemaVersion !== target.schemaVersion) {
        problems.push(`${label}: схема после разбора ${data.schemaVersion}, ожидается ${target.schemaVersion}.`);
      }
    } catch (error) {
      problems.push(`${label}: ${error instanceof Error ? error.message : 'не удалось разобрать данные.'}`);
    }
  }
  return problems;
}

const serverModule: SystemServerModule = {
  id: SYSTEM_ID,
  version: SYSTEM_VERSION,
  advancedSheet: true,
  sheetDefaults() {
    return {
      characteristics: {} as Record<SheetCharacteristicKey, number>,
      fate: 0,
      systemData: createDefaultNechronicaSheetData(),
    };
  },
  applySheetChanges,
  executeSheetCommand,
  migrateRoomSheets,
  verifyRoomSheets,
};

export const systemServerModule = serverModule;
export default serverModule;
