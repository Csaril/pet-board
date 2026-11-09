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

export function sheetPanelStorageKey(participantId: string): string {
  return `tabletop:ui:v1:${participantId}:sheet`;
}

export function readSheetPanelPreference(storage: KeyValueStorage, participantId: string): SheetPanelPreference | undefined {
  try {
    const value = JSON.parse(storage.getItem(sheetPanelStorageKey(participantId)) || 'null') as Partial<SheetPanelPreference> | null;
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

export function writeSheetPanelPreference(storage: KeyValueStorage, participantId: string, preference: SheetPanelPreference): void {
  try {
    storage.setItem(sheetPanelStorageKey(participantId), JSON.stringify(preference));
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

export function abilityCollapseStorageKey(participantId: string, sheetId: string): string {
  return `tabletop:sheet:v1:${participantId}:${sheetId}:abilities`;
}

/** Expanded abilities are the default; only explicitly collapsed cards are stored. */
export function readCollapsedAbilities(storage: KeyValueStorage, participantId: string, sheetId: string): Set<string> {
  try {
    const value = JSON.parse(storage.getItem(abilityCollapseStorageKey(participantId, sheetId)) || '[]') as unknown;
    if (!Array.isArray(value)) return new Set();
    return new Set(value.filter((entry): entry is string => typeof entry === 'string'));
  } catch {
    return new Set();
  }
}

export function writeCollapsedAbilities(storage: KeyValueStorage, participantId: string, sheetId: string, collapsed: Iterable<string>): void {
  try {
    storage.setItem(abilityCollapseStorageKey(participantId, sheetId), JSON.stringify([...new Set(collapsed)].sort()));
  } catch {
    /* Local UI preferences are optional. */
  }
}

export function setAbilityCollapsed(storage: KeyValueStorage, participantId: string, sheetId: string, abilityId: string, collapsed: boolean): void {
  const current = readCollapsedAbilities(storage, participantId, sheetId);
  if (collapsed) current.add(abilityId);
  else current.delete(abilityId);
  writeCollapsedAbilities(storage, participantId, sheetId, current);
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
