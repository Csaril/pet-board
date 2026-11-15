import { randomUUID } from 'node:crypto';
import type { BoardFontFamily, CharacterSheet, SheetCharacteristicKey } from '../src/shared/board.js';
import { isBoardFontFamily } from '../src/shared/fonts.js';
import { findSystemMetadata, type SystemMetadata } from '../src/modules/manifest.js';
import { BoardCommandError, SYSTEM_MISMATCH } from './board.js';
import type { RoomStore, Identity } from './store.js';
import { loadSystemServer } from './system-registry.js';
import type { SystemServerModule } from './system-contract.js';

type Command = Record<string, unknown> & { type?: string; requestId?: unknown };
const owns = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

const ADVANCED_COMMAND = /^sheet:(?:fate|counter|ability):/;

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

/** Metadata only; resolving the implementation is a separate lazy step. */
export function activeSystemMetadata(store: RoomStore): SystemMetadata {
  const active = store.fixedSystem;
  const metadata = active ? findSystemMetadata(active.id, active.version) : undefined;
  if (!metadata) throw new BoardCommandError('Игровая система комнаты не закреплена.', { code: SYSTEM_MISMATCH, statusCode: 409 });
  return metadata;
}

function requireSheetSystem(sheet: CharacterSheet, active: SystemMetadata): void {
  if (sheet.systemId !== active.id || sheet.systemVersion !== active.version) {
    throw new BoardCommandError('Лист относится к другой игровой системе.', { code: SYSTEM_MISMATCH, statusCode: 409 });
  }
}

function editableSheet(store: RoomStore, identity: Identity, value: unknown): CharacterSheet {
  const active = activeSystemMetadata(store);
  const id = text(value, 'ID листа', 64);
  const sheet = store.getSheet(id);
  if (!sheet) throw new BoardCommandError('Лист персонажа не найден.');
  requireSheetSystem(sheet, active);
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

function requireAdvanced(module: SystemServerModule, active: SystemMetadata): SystemServerModule {
  if (!module.advancedSheet) {
    throw new BoardCommandError(`Действие недоступно для системы ${active.name}: расширенный лист PbtA не поддерживается.`, { code: SYSTEM_MISMATCH, statusCode: 409 });
  }
  return module;
}

/**
 * Core sheet CRUD plus delegation of system-specific fields and commands.
 *
 * The implementation is loaded lazily by the exact room pair. Common fields
 * (name, portrait, font, assignment, deletion) stay in the core.
 */
export async function executeSheetCommand(store: RoomStore, identity: Identity, raw: unknown): Promise<void> {
  const command = objectValue(raw, 'Команда') as Command;
  const active = activeSystemMetadata(store);
  switch (command.type) {
    case 'sheet:create': {
      if (Object.keys(command).some((key) => !['type', 'requestId', 'characterName'].includes(key))) throw new BoardCommandError('Некорректная команда создания листа.');
      const module = await loadSystemServer(active.id, active.version);
      const characterName = command.characterName === undefined ? '' : text(command.characterName, 'Имя персонажа', 80, true);
      const assignedPlayerId = identity.role === 'player' ? identity.participantId : null;
      const defaults = module.sheetDefaults();
      store.createSheet({
        id: randomUUID(), creatorId: identity.participantId, creatorName: identity.name,
        assignedPlayerId, assignedPlayerName: assignedPlayerId ? identity.name : null,
        systemId: active.id, systemVersion: active.version, schemaVersion: active.sheetSchemaVersion,
        characterName, portraitAssetId: null, characteristics: defaults.characteristics as Record<SheetCharacteristicKey, number>,
        fate: defaults.fate,
      });
      return;
    }
    case 'sheet:delete': {
      if (identity.role !== 'gm') throw new BoardCommandError('Удалять листы может только ведущий.');
      if (Object.keys(command).some((key) => !['type', 'requestId', 'id'].includes(key))) throw new BoardCommandError('Некорректная команда удаления листа.');
      const sheet = store.getSheet(text(command.id, 'ID листа', 64));
      if (!sheet) throw new BoardCommandError('Лист персонажа не найден.');
      requireSheetSystem(sheet, active);
      if (sheet.assignedPlayerId !== null) throw new BoardCommandError('Нельзя удалить лист, назначенный игроку. Сначала снимите назначение.');
      if (!store.deleteUnassignedSheet(sheet.id)) throw new BoardCommandError('Лист не удалось удалить: он уже назначен или отсутствует.');
      return;
    }
    case 'sheet:assign': {
      if (identity.role !== 'gm') throw new BoardCommandError('Назначать листы может только ведущий.');
      if (Object.keys(command).some((key) => !['type', 'requestId', 'id', 'playerId'].includes(key))) throw new BoardCommandError('Некорректная команда назначения листа.');
      const sheet = store.getSheet(text(command.id, 'ID листа', 64));
      if (!sheet) throw new BoardCommandError('Лист персонажа не найден.');
      requireSheetSystem(sheet, active);
      if (command.playerId === null) {
        store.assignSheet(sheet.id, null, null);
        return;
      }
      if (typeof command.playerId !== 'string' || command.playerId.length > 128) throw new BoardCommandError('Выберите игрока для назначения.');
      const player = store.getParticipant(command.playerId);
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
      if (owns(changes, 'fontFamily')) patch.fontFamily = fontFamilyValue(changes.fontFamily);
      if (owns(changes, 'characteristics') || owns(changes, 'fate')) {
        const module = requireAdvanced(await loadSystemServer(active.id, active.version), active);
        if (!module.applySheetChanges) {
          throw new BoardCommandError(`Действие недоступно для системы ${active.name}: расширенный лист PbtA не поддерживается.`, { code: SYSTEM_MISMATCH, statusCode: 409 });
        }
        Object.assign(patch, module.applySheetChanges(sheet, changes));
      }
      store.updateSheet(sheet.id, patch);
      return;
    }
    default: {
      if (command.type && ADVANCED_COMMAND.test(command.type)) {
        const sheet = editableSheet(store, identity, command.sheetId);
        const module = requireAdvanced(await loadSystemServer(active.id, active.version), active);
        if (!module.executeSheetCommand || !module.executeSheetCommand({ store, identity, command, sheet })) {
          throw new BoardCommandError('Неизвестная команда листа персонажа.');
        }
        return;
      }
      throw new BoardCommandError('Неизвестная команда листа персонажа.');
    }
  }
}
