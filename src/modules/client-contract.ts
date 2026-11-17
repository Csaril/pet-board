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

/**
 * A system-owned request to use the core image picker. The module supplies the
 * current asset and a callback, so the core keeps one picker and one asset ACL
 * path for every system.
 */
export interface SheetAssetPickerRequest {
  currentAssetId: string | null;
  /** Called with the chosen asset id, or null when the choice is cleared. */
  select(assetId: string | null): void;
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
  /** Opens the shared image picker for an arbitrary system-owned sheet item. */
  openSheetAssetPicker(request: SheetAssetPickerRequest): void;
  /** Opens the existing Personal Notes panel without creating a second store. */
  openPersonalNotes(): void;
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
  /**
   * The module renders its own name/portrait header, so the core skips its
   * generic identity editor to avoid two competing controls.
   */
  readonly ownsProfile?: boolean;
  renderSheet?(sheet: CharacterSheet, options: SystemSheetRenderOptions): void;
  renderRollControls?(): void;
}

/** Dynamic imports expose a factory so every room/tab gets a fresh instance. */
export interface SystemClientFactory {
  createClientModule(): SystemClientModule;
}

export type SystemClientLoader = (id: string, version: string) => Promise<SystemClientFactory>;
