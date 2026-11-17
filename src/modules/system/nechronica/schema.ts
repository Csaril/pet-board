/**
 * Persisted Nechronica sheet shape.
 *
 * This module is shared by the Nechronica client and server implementations and
 * is deliberately independent from the PbtA schema. The core never imports it:
 * it only transports the opaque `systemData` value inside `CharacterSheet`.
 *
 * `schemaVersion` is the sheet schema version, not the system module version.
 * It must be bumped when the persisted shape changes and every additive change
 * must be handled by `migrateSheetData` so old sheets keep opening.
 */
export const NECHRONICA_SHEET_SCHEMA_VERSION = 3;

export const NECHRONICA_BODY_ZONES = ['head', 'arms', 'torso', 'legs'] as const;
export type NechronicaBodyZone = (typeof NECHRONICA_BODY_ZONES)[number];

export type NechronicaDeployment = 'eden' | 'elysium' | 'limbo';

/**
 * Raised when persisted data cannot be represented by this module's schema.
 *
 * A newer schema is never downgraded silently: the sheet stays untouched, the
 * user sees the expected and the actual version, and the migration can be
 * retried after the build is updated.
 */
export class NechronicaSheetSchemaError extends Error {
  readonly code = 'SHEET_SCHEMA_UNSUPPORTED';

  constructor(
    readonly expectedVersion: number,
    readonly actualVersion: number | null,
    detail?: string,
  ) {
    super(
      `Схема листа Nechronica несовместима: ожидается версия ${expectedVersion}, `
      + `в данных указана ${actualVersion === null ? 'неизвестная версия' : `версия ${actualVersion}`}. `
      + (detail ?? 'Исходные данные не изменены; выполните контролируемую миграцию листа.'),
    );
    this.name = 'NechronicaSheetSchemaError';
  }
}

/**
 * Unknown fields are preserved verbatim so an additive schema change never
 * destroys data written by another build.
 */
export interface NechronicaAbility {
  id: string;
  imageAssetId: string | null;
  name: string;
  source: string;
  type: string;
  timing: string;
  cost: string;
  range: string;
  effect: string;
  used: boolean;
  [key: string]: unknown;
}

export interface NechronicaBodyPart {
  id: string;
  imageAssetId: string | null;
  name: string;
  timing: string;
  cost: string;
  range: string;
  effect: string;
  used: boolean;
  destroyed: boolean;
  [key: string]: unknown;
}

export interface NechronicaFetter {
  id: string;
  imageAssetId: string | null;
  target: string;
  fetter: string;
  madness: string;
  description: string;
  spentMadness: [boolean, boolean, boolean, boolean];
  [key: string]: unknown;
}

export interface NechronicaMemory {
  id: string;
  imageAssetId: string | null;
  name: string;
  number: number;
  content: string;
  [key: string]: unknown;
}

export interface NechronicaInfo {
  position: string;
  mainClass: string;
  secondaryClass: string;
  premonition: string;
  armaments: number;
  mutations: number;
  enhancements: number;
  notes: string;
  [key: string]: unknown;
}

export interface NechronicaProfile {
  maxAp: number;
  currentAp: number;
  deployment: NechronicaDeployment | null;
  approval: number;
  [key: string]: unknown;
}

export interface NechronicaSheetData {
  schemaVersion: number;
  profile: NechronicaProfile;
  abilities: NechronicaAbility[];
  bodyParts: Record<NechronicaBodyZone, NechronicaBodyPart[]>;
  fetters: NechronicaFetter[];
  info: NechronicaInfo;
  memories: NechronicaMemory[];
  [key: string]: unknown;
}

/** Field limits are shared so the client and server reject the same input. */
export const NECHRONICA_LIMITS = {
  name: 120,
  source: 120,
  type: 80,
  timing: 80,
  cost: 80,
  range: 80,
  effect: 8000,
  target: 120,
  fetter: 120,
  madness: 120,
  description: 8000,
  memoryName: 120,
  memoryContent: 8000,
  position: 120,
  className: 120,
  premonition: 2000,
  notes: 20000,
  number: 1_000_000_000,
} as const;

export function isNechronicaBodyZone(value: unknown): value is NechronicaBodyZone {
  return typeof value === 'string' && (NECHRONICA_BODY_ZONES as readonly string[]).includes(value);
}

export function isNechronicaDeployment(value: unknown): value is NechronicaDeployment {
  return value === 'eden' || value === 'elysium' || value === 'limbo';
}

export function emptyBodyParts(): Record<NechronicaBodyZone, NechronicaBodyPart[]> {
  return { head: [], arms: [], torso: [], legs: [] };
}

export function createDefaultNechronicaSheetData(): NechronicaSheetData {
  return {
    schemaVersion: NECHRONICA_SHEET_SCHEMA_VERSION,
    profile: { maxAp: 0, currentAp: 0, deployment: null, approval: 0 },
    abilities: [],
    bodyParts: emptyBodyParts(),
    fetters: [],
    info: {
      position: '',
      mainClass: '',
      secondaryClass: '',
      premonition: '',
      armaments: 0,
      mutations: 0,
      enhancements: 0,
      notes: '',
    },
    memories: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function integer(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : fallback;
}

/** Numeric sheet fields are never negative; invalid legacy values fall back. */
function nonNegativeInteger(value: unknown, fallback = 0): number {
  const parsed = integer(value, fallback);
  return parsed >= 0 ? parsed : fallback;
}

function boolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function assetId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 64 ? value : null;
}

function uniqueId(value: unknown, index: number, seen: Set<string>): string {
  const candidate = typeof value === 'string' && value.length > 0 && value.length <= 64 ? value : `legacy-${index + 1}`;
  if (!seen.has(candidate)) {
    seen.add(candidate);
    return candidate;
  }
  let suffix = 2;
  while (seen.has(`${candidate}-${suffix}`)) suffix += 1;
  const next = `${candidate}-${suffix}`;
  seen.add(next);
  return next;
}

const SHEET_KEYS = ['schemaVersion', 'profile', 'abilities', 'bodyParts', 'fetters', 'info', 'memories'] as const;
const PROFILE_KEYS = ['maxAp', 'currentAp', 'deployment', 'approval'] as const;
const INFO_KEYS = ['position', 'mainClass', 'secondaryClass', 'premonition', 'armaments', 'mutations', 'enhancements', 'notes'] as const;
const ABILITY_KEYS = ['id', 'imageAssetId', 'name', 'source', 'type', 'timing', 'cost', 'range', 'effect', 'used'] as const;
const BODY_PART_KEYS = ['id', 'imageAssetId', 'name', 'timing', 'cost', 'range', 'effect', 'used', 'destroyed'] as const;
const FETTER_KEYS = ['id', 'imageAssetId', 'target', 'fetter', 'madness', 'description', 'spentMadness'] as const;
const MEMORY_KEYS = ['id', 'imageAssetId', 'name', 'number', 'content'] as const;

/** Copies fields this build does not know about instead of discarding them. */
function copyUnknown(source: Record<string, unknown>, known: readonly string[], target: Record<string, unknown>): void {
  for (const key of Object.keys(source)) {
    if (!known.includes(key)) target[key] = source[key];
  }
}

function parseAbility(value: unknown, index: number, seen: Set<string>): NechronicaAbility | undefined {
  if (!isRecord(value)) return undefined;
  const parsed: NechronicaAbility = {
    id: uniqueId(value.id, index, seen),
    imageAssetId: assetId(value.imageAssetId),
    name: text(value.name),
    source: text(value.source),
    type: text(value.type),
    timing: text(value.timing),
    cost: text(value.cost),
    range: text(value.range),
    effect: text(value.effect),
    used: boolean(value.used),
  };
  copyUnknown(value, ABILITY_KEYS, parsed as Record<string, unknown>);
  return parsed;
}

function parseBodyPart(value: unknown, index: number, seen: Set<string>): NechronicaBodyPart | undefined {
  if (!isRecord(value)) return undefined;
  const parsed: NechronicaBodyPart = {
    id: uniqueId(value.id, index, seen),
    imageAssetId: assetId(value.imageAssetId),
    name: text(value.name),
    timing: text(value.timing),
    cost: text(value.cost),
    range: text(value.range),
    effect: text(value.effect),
    used: boolean(value.used),
    destroyed: boolean(value.destroyed),
  };
  copyUnknown(value, BODY_PART_KEYS, parsed as Record<string, unknown>);
  return parsed;
}

function parseFetter(value: unknown, index: number, seen: Set<string>): NechronicaFetter | undefined {
  if (!isRecord(value)) return undefined;
  const raw = Array.isArray(value.spentMadness) ? value.spentMadness : [];
  const parsed: NechronicaFetter = {
    id: uniqueId(value.id, index, seen),
    imageAssetId: assetId(value.imageAssetId),
    target: text(value.target),
    fetter: text(value.fetter),
    madness: text(value.madness),
    description: text(value.description),
    spentMadness: [boolean(raw[0]), boolean(raw[1]), boolean(raw[2]), boolean(raw[3])],
  };
  copyUnknown(value, FETTER_KEYS, parsed as Record<string, unknown>);
  return parsed;
}

function parseMemory(value: unknown, index: number, seen: Set<string>): NechronicaMemory | undefined {
  if (!isRecord(value)) return undefined;
  const parsed: NechronicaMemory = {
    id: uniqueId(value.id, index, seen),
    imageAssetId: assetId(value.imageAssetId),
    name: text(value.name),
    number: nonNegativeInteger(value.number),
    content: text(value.content),
  };
  copyUnknown(value, MEMORY_KEYS, parsed as Record<string, unknown>);
  return parsed;
}

function parseList<T>(value: unknown, parse: (entry: unknown, index: number, seen: Set<string>) => T | undefined): T[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: T[] = [];
  value.forEach((entry, index) => {
    const parsed = parse(entry, index, seen);
    if (parsed) result.push(parsed);
  });
  return result;
}

/**
 * True when the payload is already a complete current-schema sheet. This lets
 * the migration skip a rewrite (and keep byte-identical JSON) when only the
 * module version changed but the sheet format did not.
 */
export function isCurrentNechronicaSheetData(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (integer(value.schemaVersion, -1) !== NECHRONICA_SHEET_SCHEMA_VERSION) return false;
  if (!isRecord(value.profile) || !isRecord(value.info)) return false;
  if (!Array.isArray(value.abilities) || !Array.isArray(value.fetters) || !Array.isArray(value.memories)) return false;
  if (!isRecord(value.bodyParts)) return false;
  const bodyParts = value.bodyParts;
  return NECHRONICA_BODY_ZONES.every((zone) => Array.isArray(bodyParts[zone]));
}

/**
 * Additive, idempotent migration used by every read, every server patch and the
 * room-level migration hook.
 *
 * - `null`, `undefined`, an empty string or a legacy schema become a complete
 *   current-schema object.
 * - Known fields keep their values; missing collections become empty arrays.
 * - Unknown fields are copied unchanged.
 * - A future schema throws `NechronicaSheetSchemaError`; nothing is rewritten.
 */
export function migrateNechronicaSheetData(value: unknown): NechronicaSheetData {
  let source: unknown = value;
  if (typeof source === 'string') {
    const trimmed = source.trim();
    if (!trimmed) source = null;
    else {
      try { source = JSON.parse(trimmed) as unknown; }
      catch {
        throw new NechronicaSheetSchemaError(
          NECHRONICA_SHEET_SCHEMA_VERSION,
          null,
          'Данные листа содержат некорректный JSON. Исходные данные не изменены.',
        );
      }
      // A stored JSON string `""` is an empty payload, not a corrupt object.
      if (typeof source === 'string' && !source.trim()) source = null;
    }
  }
  if (source === null || source === undefined) return createDefaultNechronicaSheetData();
  if (!isRecord(source)) {
    throw new NechronicaSheetSchemaError(
      NECHRONICA_SHEET_SCHEMA_VERSION,
      null,
      'Данные листа не являются объектом JSON. Исходные данные не изменены.',
    );
  }

  const actualVersion = integer(source.schemaVersion, -1);
  if (actualVersion > NECHRONICA_SHEET_SCHEMA_VERSION) {
    throw new NechronicaSheetSchemaError(NECHRONICA_SHEET_SCHEMA_VERSION, actualVersion);
  }

  const defaults = createDefaultNechronicaSheetData();
  const profile = isRecord(source.profile) ? source.profile : {};
  const bodyParts = isRecord(source.bodyParts) ? source.bodyParts : {};
  const info = isRecord(source.info) ? source.info : {};

  const parsedProfile: NechronicaProfile = {
    maxAp: nonNegativeInteger(profile.maxAp, defaults.profile.maxAp),
    currentAp: nonNegativeInteger(profile.currentAp, defaults.profile.currentAp),
    deployment: isNechronicaDeployment(profile.deployment) ? profile.deployment : null,
    approval: nonNegativeInteger(profile.approval, defaults.profile.approval),
  };
  copyUnknown(profile, PROFILE_KEYS, parsedProfile as Record<string, unknown>);

  const parsedInfo: NechronicaInfo = {
    position: text(info.position),
    mainClass: text(info.mainClass),
    secondaryClass: text(info.secondaryClass),
    premonition: text(info.premonition),
    armaments: nonNegativeInteger(info.armaments),
    mutations: nonNegativeInteger(info.mutations),
    enhancements: nonNegativeInteger(info.enhancements),
    notes: text(info.notes),
  };
  copyUnknown(info, INFO_KEYS, parsedInfo as Record<string, unknown>);

  const parsed: NechronicaSheetData = {
    schemaVersion: NECHRONICA_SHEET_SCHEMA_VERSION,
    profile: parsedProfile,
    abilities: parseList(source.abilities, parseAbility),
    bodyParts: {
      head: parseList(bodyParts.head, parseBodyPart),
      arms: parseList(bodyParts.arms, parseBodyPart),
      torso: parseList(bodyParts.torso, parseBodyPart),
      legs: parseList(bodyParts.legs, parseBodyPart),
    },
    fetters: parseList(source.fetters, parseFetter),
    info: parsedInfo,
    memories: parseList(source.memories, parseMemory),
  };
  copyUnknown(source, SHEET_KEYS, parsed as Record<string, unknown>);
  return parsed;
}

/**
 * Defensive normalization used for every read and every server patch. Invalid
 * legacy values fall back to safe defaults instead of breaking the room, while
 * the server still validates every command before it reaches this function.
 * A future schema is rejected explicitly instead of being shown as an empty
 * sheet.
 */
export function parseNechronicaSheetData(value: unknown): NechronicaSheetData {
  return migrateNechronicaSheetData(value);
}

/** True when all four madness boxes of a fetter are spent. */
export function isBrokenHeart(fetter: Pick<NechronicaFetter, 'spentMadness'>): boolean {
  return fetter.spentMadness.every(Boolean);
}
