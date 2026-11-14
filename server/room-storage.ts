import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The single room served by this version always has this stable identifier.
 * It is persisted in `storage.json`, so a future room catalog can point at the
 * same directory without moving the database again.
 */
export const DEFAULT_ROOM_ID = 'default';
export const STORAGE_VERSION = 1;
export const STORAGE_MARKER = 'storage.json';

export interface StorageMarker {
  version: number;
  roomId: string;
  layout: 'rooms';
}

/** The server refuses to start until the one-time CLI migration has been run. */
export class StorageMigrationRequiredError extends Error {
  constructor(readonly dataDir: string) {
    super(`Данные находятся в старой раскладке (${dataDir}/room.sqlite). Остановите сервер и выполните npm run room:migrate.`);
    this.name = 'StorageMigrationRequiredError';
  }
}

/** The persisted marker or destination directory is incomplete or contradictory. */
export class StorageLayoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageLayoutError';
  }
}

export function storageMarkerPath(dataDir: string): string {
  return join(dataDir, STORAGE_MARKER);
}

export function roomDirectory(dataDir: string, roomId = DEFAULT_ROOM_ID): string {
  return join(dataDir, 'rooms', roomId);
}

export function legacyLayoutExists(dataDir: string): boolean {
  return existsSync(join(dataDir, 'room.sqlite'));
}

function isStorageMarker(value: unknown): value is StorageMarker {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const marker = value as Record<string, unknown>;
  return marker.version === STORAGE_VERSION && marker.layout === 'rooms' && typeof marker.roomId === 'string' && marker.roomId.length > 0;
}

export function readStorageMarker(dataDir: string): StorageMarker | undefined {
  const path = storageMarkerPath(dataDir);
  if (!existsSync(path)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!isStorageMarker(parsed)) throw new Error('invalid marker');
    return parsed;
  } catch {
    throw new StorageLayoutError(`Файл ${path} повреждён или относится к несовместимой версии хранилища.`);
  }
}

function writeMarkerFile(dataDir: string, marker: StorageMarker): void {
  const path = storageMarkerPath(dataDir);
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function assertDefaultRoom(marker: StorageMarker): void {
  if (marker.roomId !== DEFAULT_ROOM_ID) {
    throw new StorageLayoutError(`Маркер хранилища указывает на комнату «${marker.roomId}», но эта версия обслуживает только «${DEFAULT_ROOM_ID}».`);
  }
}

/**
 * Creates the persisted layout for a brand-new installation. The marker is
 * written before returning, so every later start resolves the same directory.
 */
export function initializeStorage(dataDir: string): StorageMarker {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const marker = readStorageMarker(dataDir);
  if (marker) {
    assertDefaultRoom(marker);
    return marker;
  }
  if (legacyLayoutExists(dataDir)) throw new StorageMigrationRequiredError(dataDir);
  mkdirSync(join(dataDir, 'rooms'), { recursive: true, mode: 0o700 });
  mkdirSync(roomDirectory(dataDir), { recursive: true, mode: 0o700 });
  const created: StorageMarker = { version: STORAGE_VERSION, roomId: DEFAULT_ROOM_ID, layout: 'rooms' };
  writeMarkerFile(dataDir, created);
  return created;
}

/** Commits a verified migration. Only the room-migration command calls this. */
export function commitStorageMarker(dataDir: string): StorageMarker {
  const marker: StorageMarker = { version: STORAGE_VERSION, roomId: DEFAULT_ROOM_ID, layout: 'rooms' };
  writeMarkerFile(dataDir, marker);
  return marker;
}

/**
 * Resolves the directory that belongs to the active room. This is the only
 * place where the application maps the global data root to a room directory.
 */
export function resolveRoomDirectory(dataDir: string): string {
  const marker = readStorageMarker(dataDir);
  if (!marker) {
    if (legacyLayoutExists(dataDir)) throw new StorageMigrationRequiredError(dataDir);
    const directory = roomDirectory(dataDir);
    if (existsSync(directory)) {
      throw new StorageLayoutError(`Каталог ${directory} существует, но ${storageMarkerPath(dataDir)} отсутствует. Проверьте незавершённую миграцию.`);
    }
    initializeStorage(dataDir);
    return directory;
  }
  assertDefaultRoom(marker);
  const directory = roomDirectory(dataDir, marker.roomId);
  if (!existsSync(directory)) {
    throw new StorageLayoutError(`Маркер хранилища указывает на ${directory}, но каталог отсутствует.`);
  }
  // A brand-new installation has a marker but no database until RoomStore opens.
  // A missing database next to leftover legacy files is a contradictory state.
  if (!existsSync(join(directory, 'room.sqlite')) && legacyLayoutExists(dataDir)) {
    throw new StorageLayoutError(`Каталог ${directory} не содержит room.sqlite, хотя старая раскладка ещё существует. Проверьте незавершённую миграцию.`);
  }
  return directory;
}
