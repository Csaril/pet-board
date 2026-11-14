import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import type { AppConfig } from './config.js';
import { RoomCatalog, type CatalogRoom, type RoomStatus } from './catalog.js';
import { findSystemModule } from '../src/modules/registry.js';
import { RoomStore } from './store.js';

export type RoomUnavailableCode = 'ROOM_NOT_FOUND' | 'ROOM_DISABLED' | 'ROOM_ARCHIVED';

export class RoomUnavailableError extends Error {
  constructor(readonly code: RoomUnavailableCode) {
    super('Комната недоступна.');
    this.name = 'RoomUnavailableError';
  }
}

export class RoomCapacityError extends Error {
  constructor(readonly limit: number) {
    super(`Открыто максимальное число комнат (${limit}). Попробуйте позже.`);
    this.name = 'RoomCapacityError';
  }
}

export class RoomConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoomConfigurationError';
  }
}

export interface RoomLease {
  room: CatalogRoom;
  store: RoomStore;
  release(): void;
}

/** The server reads rooms through this interface, never through a mutable global. */
export interface RoomAccess {
  readonly legacyCookie: boolean;
  findByCode(code: string): CatalogRoom | undefined;
  getRoom(roomId: string): CatalogRoom | undefined;
  verifyGmPassword(roomId: string, password: string): boolean;
  acquire(roomId: string): RoomLease;
}

function assertRoomStatus(room: CatalogRoom): void {
  if (room.status === 'disabled') throw new RoomUnavailableError('ROOM_DISABLED');
  if (room.status === 'archived') throw new RoomUnavailableError('ROOM_ARCHIVED');
}

interface CacheEntry {
  store: RoomStore;
  refs: number;
  lastUsed: number;
  closeWhenIdle: boolean;
}

/**
 * Lazily opens room databases and keeps only a small bounded set of them open.
 * A lease protects a store from LRU eviction while a request or WebSocket
 * connection is using it. No room is opened at server start.
 */
export class RoomManager {
  readonly dataDir: string;
  readonly catalog: RoomCatalog;
  readonly maxOpenRooms: number;
  private readonly entries = new Map<string, CacheEntry>();

  constructor(options: { dataDir: string; catalog: RoomCatalog; maxOpenRooms?: number }) {
    this.dataDir = resolve(options.dataDir);
    this.catalog = options.catalog;
    this.maxOpenRooms = Math.max(1, Math.trunc(options.maxOpenRooms ?? 8));
  }

  get openRoomCount(): number {
    return this.entries.size;
  }

  get leasedRoomCount(): number {
    let count = 0;
    for (const entry of this.entries.values()) if (entry.refs > 0) count += 1;
    return count;
  }

  roomDirectory(roomId: string): string {
    const catalogRoom = this.catalog.getRoom(roomId);
    if (!catalogRoom) throw new RoomUnavailableError('ROOM_NOT_FOUND');
    const roomsRoot = resolve(this.dataDir, 'rooms');
    const directory = resolve(roomsRoot, catalogRoom.id);
    if (directory !== roomsRoot && !directory.startsWith(`${roomsRoot}${sep}`)) {
      throw new RoomConfigurationError('Некорректный путь комнаты.');
    }
    if (!existsSync(directory)) throw new RoomConfigurationError(`Каталог комнаты ${catalogRoom.id} отсутствует.`);
    return directory;
  }

  acquire(roomId: string): RoomLease {
    const room = this.catalog.getRoom(roomId);
    if (!room) throw new RoomUnavailableError('ROOM_NOT_FOUND');
    assertRoomStatus(room);

    const existing = this.entries.get(roomId);
    if (existing) {
      existing.refs += 1;
      existing.lastUsed = Date.now();
      return this.lease(room, existing);
    }

    if (this.entries.size >= this.maxOpenRooms) this.evictIdle(1);
    if (this.entries.size >= this.maxOpenRooms) throw new RoomCapacityError(this.maxOpenRooms);

    const directory = this.roomDirectory(roomId);
    let store: RoomStore | undefined;
    try {
      store = new RoomStore(directory, room.name);
      this.verifySystem(room, store);
    } catch (error) {
      try { store?.close(); } catch { /* ignore */ }
      throw error;
    }
    const entry: CacheEntry = { store, refs: 1, lastUsed: Date.now(), closeWhenIdle: false };
    this.entries.set(roomId, entry);
    return this.lease(room, entry);
  }

  private verifySystem(room: CatalogRoom, store: RoomStore): void {
    const system = store.roomSystem;
    if (!system.fixed) {
      throw new RoomConfigurationError(`В комнате ${room.id} не зафиксирована игровая система. Требуется контролируемая миграция.`);
    }
    if (system.id !== room.systemId || system.version !== room.systemVersion) {
      throw new RoomConfigurationError(
        `Системная принадлежность комнаты ${room.id} противоречит каталогу: каталог ${room.systemId ?? '—'}@${room.systemVersion ?? '—'}, база ${system.id ?? '—'}@${system.version ?? '—'}.`,
      );
    }
    if (room.systemId && room.systemVersion && !findSystemModule(room.systemId, room.systemVersion)) {
      throw new RoomConfigurationError(`Система ${room.systemId}@${room.systemVersion} отсутствует в сборке сервера.`);
    }
  }

  private lease(room: CatalogRoom, entry: CacheEntry): RoomLease {
    let released = false;
    return {
      room,
      store: entry.store,
      release: () => {
        if (released) return;
        released = true;
        entry.refs = Math.max(0, entry.refs - 1);
        entry.lastUsed = Date.now();
        if (entry.refs === 0 && entry.closeWhenIdle) {
          this.closeEntry(room.id, entry);
        }
      },
    };
  }

  private closeEntry(roomId: string, entry: CacheEntry): void {
    try { entry.store.close(); } catch { /* close is best-effort during eviction */ }
    if (this.entries.get(roomId) === entry) this.entries.delete(roomId);
  }

  private evictIdle(requiredSlots: number): void {
    const target = this.maxOpenRooms - requiredSlots;
    const idle = [...this.entries.entries()]
      .filter(([, entry]) => entry.refs === 0)
      .sort((left, right) => left[1].lastUsed - right[1].lastUsed);
    for (const [roomId, entry] of idle) {
      if (this.entries.size <= target) break;
      this.closeEntry(roomId, entry);
    }
  }

  /** Marks a room for closing once its last lease is released. */
  requestClose(roomId: string): void {
    const entry = this.entries.get(roomId);
    if (!entry) return;
    if (entry.refs === 0) this.closeEntry(roomId, entry);
    else entry.closeWhenIdle = true;
  }

  /** Looks up a room record with fresh catalog status (CLI changes are visible immediately). */
  getRoom(roomId: string): CatalogRoom | undefined {
    return this.catalog.getRoom(roomId);
  }

  closeAll(): void {
    for (const [roomId, entry] of [...this.entries.entries()]) this.closeEntry(roomId, entry);
  }

  close(): void {
    this.closeAll();
    this.catalog.close();
  }
}

/** Production access path: catalog + lazy RoomManager. */
export class CatalogRoomAccess implements RoomAccess {
  readonly legacyCookie = false;
  constructor(readonly manager: RoomManager) {}
  findByCode(code: string): CatalogRoom | undefined { return this.manager.catalog.findRoomByCode(code); }
  getRoom(roomId: string): CatalogRoom | undefined { return this.manager.getRoom(roomId); }
  verifyGmPassword(roomId: string, password: string): boolean { return this.manager.catalog.verifyGmPassword(roomId, password); }
  acquire(roomId: string): RoomLease { return this.manager.acquire(roomId); }
}

function constantTimeEqual(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Test harness only. Existing tests construct a RoomStore explicitly and pass a
 * legacy room code/password in the config; this adapter keeps that setup working
 * without introducing a global current room in production.
 */
export class SingleRoomAccess implements RoomAccess {
  readonly legacyCookie = true;
  readonly room: CatalogRoom;
  constructor(readonly store: RoomStore, readonly config: AppConfig) {
    const system = store.roomSystem;
    this.room = {
      id: 'default',
      name: store.roomName,
      systemId: system.id,
      systemVersion: system.version,
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  findByCode(code: string): CatalogRoom | undefined {
    const expected = this.config.roomCode ?? '';
    if (!expected) return undefined;
    const submitted = expected.length <= 8 ? code.trim().toUpperCase() : code.trim();
    return constantTimeEqual(submitted, expected) ? this.room : undefined;
  }
  getRoom(roomId: string): CatalogRoom | undefined { return roomId === this.room.id ? this.room : undefined; }
  verifyGmPassword(_roomId: string, password: string): boolean {
    return Boolean(this.config.gmPassword) && constantTimeEqual(password, this.config.gmPassword ?? '');
  }
  acquire(roomId: string): RoomLease {
    if (roomId !== this.room.id) throw new RoomUnavailableError('ROOM_NOT_FOUND');
    return { room: this.room, store: this.store, release: () => undefined };
  }
}

/** A random identifier for a new room; never derived from its user-facing name. */
export function newRoomId(): string {
  const bytes = randomBytes(16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function statusLabel(status: RoomStatus): string {
  if (status === 'active') return 'активна';
  if (status === 'disabled') return 'отключена';
  return 'архивирована';
}

export function isRoomId(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
}
