import type { CharacterSheet, DiceRollEntry, SheetCharacteristicKey } from '../src/shared/board.js';
import type { Identity, RoomStore } from './store.js';

export interface ActiveSystemPair {
  id: string;
  version: string;
}

export interface SystemSheetDefaults {
  characteristics: Record<SheetCharacteristicKey, number>;
  fate: number;
}

export interface SystemSheetChanges {
  /** Validated system-specific patch, merged into the core update patch. */
  characteristics?: Record<SheetCharacteristicKey, number>;
  fate?: number;
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
  /** True when the system persists characteristics/fate/counters/abilities. */
  readonly advancedSheet: boolean;
  /** Initial persisted values for a newly created sheet. */
  sheetDefaults(): SystemSheetDefaults;
  /** Validates system-specific sheet changes; throws BoardCommandError on bad input. */
  applySheetChanges?(sheet: CharacterSheet, changes: Record<string, unknown>): SystemSheetChanges;
  /** Handles fate/counter/ability commands. Returns false when not handled. */
  executeSheetCommand?(context: SystemSheetCommandContext): boolean;
  /** True for roll command types this module owns (`dice:pbta`, `dice:reroll`). */
  handlesRollCommand?(type: string): boolean;
  /** Validates, computes and attributes a system roll to the current room. */
  createRoll?(context: SystemRollContext): DiceRollEntry;
}
