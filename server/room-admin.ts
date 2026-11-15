import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createBackup } from './backup-lib.js';
import { generateRoomCode, hashRoomPassword, normalizeRoomCode, RoomCatalog, type CatalogRoom } from './catalog.js';
import { findLatestSystemMetadata } from '../src/modules/manifest.js';
import { newRoomId } from './room-manager.js';
import { RoomStore } from './store.js';

export class RoomAdminError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoomAdminError';
  }
}

export function roomsRoot(dataDir: string): string {
  return join(dataDir, 'rooms');
}

export function adminRoomDirectory(dataDir: string, roomId: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(roomId)) throw new RoomAdminError('Некорректный идентификатор комнаты.');
  return join(roomsRoot(dataDir), roomId);
}

export function openCatalogForAdmin(dataDir: string): RoomCatalog {
  if (!existsSync(join(dataDir, 'catalog.sqlite'))) {
    throw new RoomAdminError('Каталог комнат не инициализирован. Выполните npm run rooms:init.');
  }
  return RoomCatalog.open(dataDir);
}

export interface InitializeResult {
  room: CatalogRoom;
  created: boolean;
}

/**
 * Registers the existing `default` room in the catalog. The room directory and
 * every game record stay in place; only discovery/auth metadata is added.
 */
export async function initializeDefaultRoom(options: {
  dataDir: string;
  roomName?: string;
  roomCode?: string;
  gmPassword?: string;
}): Promise<InitializeResult> {
  const directory = adminRoomDirectory(options.dataDir, 'default');
  if (!existsSync(join(directory, 'room.sqlite'))) {
    throw new RoomAdminError(`Не найдена существующая комната ${join(directory, 'room.sqlite')}. Сначала выполните npm run room:migrate для старой раскладки.`);
  }

  const existed = existsSync(join(options.dataDir, 'catalog.sqlite'));
  const catalog = RoomCatalog.initialize(options.dataDir);
  let store: RoomStore | undefined;
  try {
    store = new RoomStore(directory, options.roomName ?? 'Игровая комната');
    const system = store.roomSystem;
    if (!system.fixed) {
      throw new RoomAdminError('Система существующей комнаты default не зафиксирована. Требуется контролируемая миграция.');
    }
    const existing = catalog.getRoom('default');
    if (existing) {
      if (existing.systemId !== system.id || existing.systemVersion !== system.version) {
        throw new RoomAdminError(
          `Система default в каталоге (${existing.systemId ?? '—'}@${existing.systemVersion ?? '—'}) не совпадает с базой (${system.id ?? '—'}@${system.version ?? '—'}).`,
        );
      }
      if (existed) return { room: existing, created: false };
      return { room: existing, created: false };
    }

    if (!options.roomCode?.trim()) throw new RoomAdminError('Для первичной инициализации нужен ROOM_CODE из старого .env.');
    if (!options.gmPassword || options.gmPassword.length < 10) throw new RoomAdminError('Для первичной инициализации нужен GM_PASSWORD не короче 10 символов.');
    const room = catalog.createRoom({
      id: 'default',
      name: store.roomName,
      systemId: system.id,
      systemVersion: system.version,
      code: normalizeRoomCode(options.roomCode),
      passwordHash: hashRoomPassword(options.gmPassword),
    });
    return { room, created: true };
  } finally {
    store?.close();
    catalog.close();
  }
}

export interface CreateRoomResult {
  room: CatalogRoom;
  code: string;
}

/** Creates a room in a temporary directory and only publishes it after success. */
export async function createRoom(options: {
  dataDir: string;
  name: string;
  systemId: string;
  gmPassword: string;
}): Promise<CreateRoomResult> {
  const name = options.name.trim();
  if (!name || name.length > 120) throw new RoomAdminError('Название комнаты должно содержать от 1 до 120 символов.');
  const module = findLatestSystemMetadata(options.systemId);
  if (!module) {
    throw new RoomAdminError(`Неизвестная игровая система «${options.systemId}». Доступны: pbta-2d6, nechronica.`);
  }
  if (options.gmPassword.length < 10) throw new RoomAdminError('Пароль ведущего должен содержать не менее 10 символов.');

  const catalog = openCatalogForAdmin(options.dataDir);
  const roomId = newRoomId();
  const root = roomsRoot(options.dataDir);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const temporary = join(root, `.creating-${roomId}-${process.pid}`);
  const finalDirectory = join(root, roomId);
  let code: string;
  try {
    let attempts = 0;
    do {
      code = generateRoomCode();
      attempts += 1;
      if (attempts > 100) throw new RoomAdminError('Не удалось сгенерировать уникальный код комнаты.');
    } while (catalog.codeExists(code));

    let store: RoomStore | undefined;
    try {
      store = new RoomStore(temporary, name);
      store.initializeSystem(module.id, module.version);
      const system = store.roomSystem;
      if (!system.fixed || system.id !== module.id || system.version !== module.version) {
        throw new RoomAdminError('Не удалось зафиксировать игровую систему новой комнаты.');
      }
      mkdirSync(join(temporary, 'assets'), { recursive: true, mode: 0o700 });
      mkdirSync(join(temporary, 'backups'), { recursive: true, mode: 0o700 });
    } finally {
      store?.close();
    }

    renameSync(temporary, finalDirectory);
    const room = catalog.createRoom({
      id: roomId,
      name,
      systemId: module.id,
      systemVersion: module.version,
      code,
      passwordHash: hashRoomPassword(options.gmPassword),
    });
    return { room, code };
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    if (existsSync(finalDirectory) && !catalog.getRoom(roomId)) rmSync(finalDirectory, { recursive: true, force: true });
    throw error;
  } finally {
    catalog.close();
  }
}

export function setRoomStatus(dataDir: string, roomId: string, status: 'active' | 'disabled'): CatalogRoom {
  const catalog = openCatalogForAdmin(dataDir);
  try {
    return catalog.setStatus(roomId, status);
  } finally {
    catalog.close();
  }
}

export async function archiveRoom(dataDir: string, roomId: string): Promise<{ room: CatalogRoom; backup: string }> {
  const catalog = openCatalogForAdmin(dataDir);
  try {
    const room = catalog.getRoom(roomId);
    if (!room) throw new RoomAdminError(`Комната ${roomId} не найдена.`);
    if (room.status === 'archived') throw new RoomAdminError(`Комната ${roomId} уже архивирована.`);
    const directory = adminRoomDirectory(dataDir, roomId);
    const backup = await createBackup(directory, room.name, 'pre-archive', {
      roomId: room.id,
      systemId: room.systemId,
      systemVersion: room.systemVersion,
      schemaVersion: 1,
    });
    const archived = catalog.setStatus(roomId, 'archived');
    return { room: archived, backup: backup.name };
  } finally {
    catalog.close();
  }
}

export function listRoomDirectories(dataDir: string): string[] {
  const root = roomsRoot(dataDir);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort();
}

export interface DeleteRoomResult {
  room: CatalogRoom;
  /** Absolute path of the preserved final backup inside `deleted-rooms/`. */
  preservedBackup?: string;
  /** Directory that keeps the room's backups and a small deletion record. */
  preservedRoot?: string;
  /** Path of the tombstone directory if the room directory could not be fully removed. */
  leftoverDirectory?: string;
}

/**
 * Physically deletes a room: its catalog record, SQLite database and assets.
 * A final backup is created first and every backup is moved to
 * `data/deleted-rooms/`, so the game data is not lost irreversibly. Active or
 * disabled rooms require an explicit `force` flag; archived rooms do not.
 */
export async function deleteRoom(options: {
  dataDir: string;
  roomId: string;
  force?: boolean;
  keepBackup?: boolean;
}): Promise<DeleteRoomResult> {
  const catalog = openCatalogForAdmin(options.dataDir);
  try {
    const room = catalog.getRoom(options.roomId);
    if (!room) throw new RoomAdminError(`Комната ${options.roomId} не найдена.`);
    if (room.status !== 'archived' && !options.force) {
      throw new RoomAdminError(
        `Комната ${room.id} не архивирована. Сначала выполните npm run rooms:archive -- ${room.id} или добавьте --force.`,
      );
    }
    const directory = adminRoomDirectory(options.dataDir, room.id);
    const directoryExists = existsSync(directory);
    if (!directoryExists && !options.force) {
      throw new RoomAdminError(`Каталог комнаты ${directory} не найден. Добавьте --force, чтобы удалить только запись каталога.`);
    }

    let finalBackup: string | undefined;
    if (directoryExists && options.keepBackup !== false) {
      const backup = await createBackup(directory, room.name, 'pre-delete', {
        roomId: room.id,
        systemId: room.systemId,
        systemVersion: room.systemVersion,
        schemaVersion: 1,
      });
      finalBackup = backup.name;
    }

    let preservedRoot: string | undefined;
    let preservedBackup: string | undefined;
    const roomBackups = join(directory, 'backups');
    if (directoryExists && existsSync(roomBackups)) {
      const stamp = new Date().toISOString().replaceAll(':', '-');
      const base = join(options.dataDir, 'deleted-rooms', `${room.id}-${stamp}`);
      const root = existsSync(base) ? `${base}-${process.pid}` : base;
      try {
        mkdirSync(root, { recursive: true, mode: 0o700 });
        renameSync(roomBackups, join(root, 'backups'));
        writeFileSync(join(root, 'room.json'), `${JSON.stringify({
          id: room.id,
          name: room.name,
          systemId: room.systemId,
          systemVersion: room.systemVersion,
          statusAtDeletion: room.status,
          createdAt: room.createdAt,
          deletedAt: new Date().toISOString(),
          finalBackup: finalBackup ?? null,
        }, null, 2)}\n`, { mode: 0o600 });
      } catch (error) {
        try {
          if (existsSync(join(root, 'backups')) && !existsSync(roomBackups)) renameSync(join(root, 'backups'), roomBackups);
        } catch { /* best-effort rollback */ }
        rmSync(root, { recursive: true, force: true });
        throw error;
      }
      preservedRoot = root;
      if (finalBackup) preservedBackup = join(root, 'backups', finalBackup);
    }

    const rollbackPreserved = (): void => {
      if (!preservedRoot) return;
      try {
        if (existsSync(join(preservedRoot, 'backups')) && !existsSync(roomBackups)) {
          renameSync(join(preservedRoot, 'backups'), roomBackups);
        }
        rmSync(preservedRoot, { recursive: true, force: true });
      } catch { /* best-effort rollback */ }
      preservedRoot = undefined;
      preservedBackup = undefined;
    };

    // Rename first: the room disappears as a directory atomically, and a failed
    // catalog delete can still be rolled back before anything is unlinked.
    const tombstone = join(roomsRoot(options.dataDir), `.deleting-${room.id}-${process.pid}-${Date.now()}`);
    if (directoryExists) {
      try { renameSync(directory, tombstone); }
      catch (error) { rollbackPreserved(); throw error; }
    }
    try {
      catalog.deleteRoom(room.id);
    } catch (error) {
      if (directoryExists && existsSync(tombstone)) renameSync(tombstone, directory);
      rollbackPreserved();
      throw error;
    }

    let leftoverDirectory: string | undefined;
    if (directoryExists) {
      try {
        rmSync(tombstone, { recursive: true, force: true });
      } catch {
        leftoverDirectory = tombstone;
      }
    }

    return {
      room,
      ...(preservedRoot ? { preservedRoot } : {}),
      ...(preservedBackup ? { preservedBackup } : {}),
      ...(leftoverDirectory ? { leftoverDirectory } : {}),
    };
  } finally {
    catalog.close();
  }
}
