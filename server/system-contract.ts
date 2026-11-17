import type { CharacterSheet, DiceRollEntry, SheetCharacteristicKey } from '../src/shared/board.js';
import type { Identity, RoomStore } from './store.js';

export interface ActiveSystemPair {
  id: string;
  version: string;
}

export interface SystemSheetDefaults {
  characteristics: Record<SheetCharacteristicKey, number>;
  fate: number;
  /** Opaque system-owned payload persisted separately from PbtA fields. */
  systemData?: unknown;
}

export interface SystemSheetChanges {
  /** Validated system-specific patch, merged into the core update patch. */
  characteristics?: Record<SheetCharacteristicKey, number>;
  fate?: number;
  /** Opaque system-owned payload produced by a validated system command. */
  systemData?: unknown;
}

export interface SystemSheetCommandContext {
  store: RoomStore;
  identity: Identity;
  command: Record<string, unknown> & { type?: string };
  /** Sheet already checked against the active room system and edit rights. */
  sheet: CharacterSheet;
}

export interface SystemRollContext {
  store: RoomStore;
  identity: Identity;
  command: Record<string, unknown>;
  activeSystem: ActiveSystemPair;
  original?: DiceRollEntry;
  randomInt: (min: number, max: number) => number;
}

/** Exact target pair plus the sheet schema version registered for that pair. */
export interface SystemRoomTarget extends ActiveSystemPair {
  schemaVersion: number;
}

export interface SystemRoomMigrationReport {
  fromVersion: string;
  toVersion: string;
  migratedSheetIds: string[];
  unchangedSheetIds: string[];
}

export interface SystemRoomMigrationContext {
  store: RoomStore;
  target: SystemRoomTarget;
}

export interface SystemRoomVerificationContext {
  store: RoomStore;
  target: SystemRoomTarget;
}

/**
 * Contract implemented by a lazily loaded server system.
 *
 * It receives an explicit room/store context for every operation. Implementations
 * must not keep a reference to a "current room" or mutable room state at module
 * scope; the same loaded code serves every room of that system.
 */
export interface SystemServerModule {
  readonly id: string;
  readonly version: string;
  /**
   * True when the system persists an advanced sheet and handles its own
   * `sheet:*` commands. The core still owns creation, assignment and common
   * fields such as name and portrait.
   */
  readonly advancedSheet: boolean;
  /** Initial persisted values for a newly created sheet. */
  sheetDefaults(): SystemSheetDefaults;
  /**
   * Migrates every sheet of this system inside the room to the exact target
   * pair. Must be additive, idempotent and must leave incompatible data intact
   * by throwing. The core calls it only for a room already pinned to `target`.
   */
  migrateRoomSheets?(context: SystemRoomMigrationContext): SystemRoomMigrationReport;
  /** Returns human-readable problems found after a staged migration. */
  verifyRoomSheets?(context: SystemRoomVerificationContext): string[];
  /** Validates system-specific sheet changes; throws BoardCommandError on bad input. */
  applySheetChanges?(sheet: CharacterSheet, changes: Record<string, unknown>): SystemSheetChanges;
  /** Handles fate/counter/ability commands. Returns false when not handled. */
  executeSheetCommand?(context: SystemSheetCommandContext): boolean;
  /** True for roll command types this module owns (`dice:pbta`, `dice:reroll`). */
  handlesRollCommand?(type: string): boolean;
  /** Validates, computes and attributes a system roll to the current room. */
  createRoll?(context: SystemRollContext): DiceRollEntry;
}
