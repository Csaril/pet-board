import type { BoardFontFamily, CharacterSheet, SheetCharacteristicKey } from '../shared/board.js';
import type { SheetRollContext } from '../shared/sheet-ui.js';

export type SystemRole = 'gm' | 'player';

export interface SystemIdentity {
  participantId: string;
  name: string;
  role: SystemRole;
}

export interface SystemRuntimeInfo {
  id: string;
  version: string;
  name: string;
  capabilities: { battleMap: boolean };
}

export interface SystemParticipant {
  participantId: string;
  name: string;
  role: SystemRole;
}

/** The small read-only view a system module may use while rendering. */
export interface SystemRoomView {
  roomId?: string;
  system: SystemRuntimeInfo;
  participants: readonly SystemParticipant[];
  activeScene?: 'board' | 'battle';
}

export interface SystemSheetRenderOptions {
  editing: boolean;
  canEdit: boolean;
  canRoll: boolean;
}

export interface SystemClientServices {
  command(type: string, data?: Record<string, unknown>): Promise<void>;
  message(text: string, error?: boolean): void;
  getState(): SystemRoomView;
  getIdentity(): SystemIdentity;
  /** Prepares a roll from the sheet and opens the core roll window. */
  openRoll(sheet: CharacterSheet, key: SheetCharacteristicKey, characteristicName: string): void;
  getPendingRoll(): SheetRollContext | undefined;
  clearPendingRoll(): void;
  /** Opens the shared image picker in the "ability artwork" mode. */
  openAbilityAssetPicker(abilityId: string, assetId: string | null): void;
  applyFont(element: HTMLElement, font: BoardFontFamily | null | undefined): void;
  assetUrl(assetId: string): string;
  /** Room-scoped localStorage prefix used for per-participant UI preferences. */
  storageScope(): string;
  /** Re-renders the open sheet after a local-only preference change. */
  renderSheet(): void;
}

export interface SystemClientContext {
  roomId: string;
  system: SystemRuntimeInfo;
  identity: SystemIdentity;
  elements: {
    /** Core-owned identity section lives above this container. */
    sheet: HTMLElement;
    /** The module puts its own roll controls here; the core moves them into the roll panel. */
    rollControlsHome: HTMLElement;
  };
  services: SystemClientServices;
}

export interface SystemClientModule {
  mount(context: SystemClientContext): void | Promise<void>;
  dispose(): void;
  renderSheet?(sheet: CharacterSheet, options: SystemSheetRenderOptions): void;
  renderRollControls?(): void;
}

/** Dynamic imports expose a factory so every room/tab gets a fresh instance. */
export interface SystemClientFactory {
  createClientModule(): SystemClientModule;
}

export type SystemClientLoader = (id: string, version: string) => Promise<SystemClientFactory>;
