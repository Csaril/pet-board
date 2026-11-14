import type { CharacterSheet, SheetCharacteristicKey } from './board.js';

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface SheetRollContext {
  characteristicName: string;
  characteristicBonus: number;
  characterId: string;
  characterOwnerId: string;
}

export type SheetPanelMode = 'view' | 'edit';
export const DEFAULT_SHEET_PANEL_MODE: SheetPanelMode = 'view';

export function toggleSheetMode(mode: SheetPanelMode): SheetPanelMode {
  return mode === 'edit' ? 'view' : 'edit';
}

/** Structural editors are only available to an editor in edit mode. */
export function canChangeSheetStructure(mode: SheetPanelMode, canEdit: boolean): boolean {
  return canEdit && mode === 'edit';
}

export interface SheetPanelPreference {
  version: 1;
  open: boolean;
  collapsed: boolean;
  x: number | null;
  y: number | null;
  sheetId: string | null;
}

export function sheetPanelStorageKey(roomId: string, participantId: string): string {
  return `tabletop:ui:v1:${roomId}:${participantId}:sheet`;
}

export function readSheetPanelPreference(storage: KeyValueStorage, roomId: string, participantId: string): SheetPanelPreference | undefined {
  try {
    const value = JSON.parse(storage.getItem(sheetPanelStorageKey(roomId, participantId)) || 'null') as Partial<SheetPanelPreference> | null;
    if (!value || value.version !== 1 || typeof value.open !== 'boolean') return undefined;
    const coordinate = (raw: unknown): number | null => typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
    return {
      version: 1,
      open: value.open,
      collapsed: value.collapsed === true,
      x: coordinate(value.x),
      y: coordinate(value.y),
      sheetId: typeof value.sheetId === 'string' && value.sheetId ? value.sheetId : null,
    };
  } catch { return undefined; }
}

export function writeSheetPanelPreference(storage: KeyValueStorage, roomId: string, participantId: string, preference: SheetPanelPreference): void {
  try {
    storage.setItem(sheetPanelStorageKey(roomId, participantId), JSON.stringify(preference));
  } catch {
    /* Local UI preferences are optional. */
  }
}

export interface SheetRollPanelPreference {
  version: 1;
  x: number | null;
  y: number | null;
}

export function sheetRollPanelStorageKey(roomId: string, participantId: string): string {
  return `tabletop:ui:v1:${roomId}:${participantId}:sheet-roll`;
}

/**
 * The roll window remembers only a user-moved position. Returning `undefined`
 * means "place it next to the sheet using the current layout".
 */
export function readSheetRollPanelPreference(storage: KeyValueStorage, roomId: string, participantId: string): { x: number; y: number } | undefined {
  try {
    const value = JSON.parse(storage.getItem(sheetRollPanelStorageKey(roomId, participantId)) || 'null') as Partial<SheetRollPanelPreference> | null;
    if (!value || value.version !== 1 || typeof value.x !== 'number' || typeof value.y !== 'number') return undefined;
    if (!Number.isFinite(value.x) || !Number.isFinite(value.y)) return undefined;
    return { x: value.x, y: value.y };
  } catch { return undefined; }
}

/** Passing `null` coordinates forgets the stored position and restores the default anchoring. */
export function writeSheetRollPanelPreference(
  storage: KeyValueStorage,
  roomId: string,
  participantId: string,
  x: number | null,
  y: number | null,
): void {
  try {
    const preference: SheetRollPanelPreference = { version: 1, x, y };
    storage.setItem(sheetRollPanelStorageKey(roomId, participantId), JSON.stringify(preference));
  } catch {
    /* Local UI preferences are optional. */
  }
}

/** Keeps a floating panel fully inside the viewport after a move or resize. */
export function clampFloatingPosition(
  x: number, y: number, width: number, height: number, viewportWidth: number, viewportHeight: number,
): { x: number; y: number } {
  return {
    x: Math.max(0, Math.min(x, Math.max(0, viewportWidth - width))),
    y: Math.max(0, Math.min(y, Math.max(0, viewportHeight - height))),
  };
}

export function abilityCollapseStorageKey(roomId: string, participantId: string, sheetId: string): string {
  return `tabletop:sheet:v1:${roomId}:${participantId}:${sheetId}:abilities`;
}

/** Expanded abilities are the default; only explicitly collapsed cards are stored. */
export function readCollapsedAbilities(storage: KeyValueStorage, roomId: string, participantId: string, sheetId: string): Set<string> {
  try {
    const value = JSON.parse(storage.getItem(abilityCollapseStorageKey(roomId, participantId, sheetId)) || '[]') as unknown;
    if (!Array.isArray(value)) return new Set();
    return new Set(value.filter((entry): entry is string => typeof entry === 'string'));
  } catch {
    return new Set();
  }
}

export function writeCollapsedAbilities(storage: KeyValueStorage, roomId: string, participantId: string, sheetId: string, collapsed: Iterable<string>): void {
  try {
    storage.setItem(abilityCollapseStorageKey(roomId, participantId, sheetId), JSON.stringify([...new Set(collapsed)].sort()));
  } catch {
    /* Local UI preferences are optional. */
  }
}

export function setAbilityCollapsed(storage: KeyValueStorage, roomId: string, participantId: string, sheetId: string, abilityId: string, collapsed: boolean): void {
  const current = readCollapsedAbilities(storage, roomId, participantId, sheetId);
  if (collapsed) current.add(abilityId);
  else current.delete(abilityId);
  writeCollapsedAbilities(storage, roomId, participantId, sheetId, current);
}

export function formatSigned(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

export function buildSheetRollContext(
  sheet: Pick<CharacterSheet, 'id' | 'assignedPlayerId' | 'characteristics'>,
  key: SheetCharacteristicKey,
  characteristicName: string,
): SheetRollContext {
  return {
    characteristicName,
    characteristicBonus: sheet.characteristics[key] ?? 0,
    characterId: sheet.id,
    characterOwnerId: sheet.assignedPlayerId ?? '',
  };
}
