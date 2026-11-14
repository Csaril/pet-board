import { createHmac, randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';

/**
 * Catalog of independent game rooms. The catalog itself contains no game data:
 * only discovery and authorization metadata. Every room directory remains the
 * single source of truth for that room's board, images, sheets and sessions.
 */
export type RoomStatus = 'active' | 'disabled' | 'archived';

export interface CatalogRoom {
  id: string;
  name: string;
  systemId: string | null;
  systemVersion: string | null;
  status: RoomStatus;
  createdAt: string;
  updatedAt: string;
}

export interface NewCatalogRoom {
  id: string;
  name: string;
  systemId: string | null;
  systemVersion: string | null;
  code: string;
  passwordHash: string;
  status?: RoomStatus;
}

export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const SHORT_ROOM_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{6,8}$/;
export const ROOM_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const CATALOG_VERSION = 1;
const SECRET_BYTES = 32;
const PASSWORD_MIN_LENGTH = 10;

export class CatalogNotInitializedError extends Error {
  constructor(readonly dataDir: string) {
    super(`Каталог комнат не инициализирован (${join(dataDir, 'catalog.sqlite')}). Остановите сервер и выполните npm run rooms:init.`);
    this.name = 'CatalogNotInitializedError';
  }
}

export class CatalogSecretMissingError extends Error {
  constructor(readonly path: string) {
    super(`Каталог комнат существует, но файл секрета ${path} отсутствует. Восстановите server-secret из резервной копии каталога; новый секрет сделает коды комнат недействительными.`);
    this.name = 'CatalogSecretMissingError';
  }
}

export class RoomConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoomConflictError';
  }
}

export function catalogPath(dataDir: string): string {
  return join(dataDir, 'catalog.sqlite');
}

export function serverSecretPath(dataDir: string): string {
  return join(dataDir, 'server-secret');
}

export function assertValidRoomId(roomId: string): void {
  if (!ROOM_ID_PATTERN.test(roomId)) throw new Error('Некорректный идентификатор комнаты.');
}

/**
 * Existing installations allowed codes of six to eight compact characters or
 * legacy codes of twelve or more characters. Short codes are compared
 * case-insensitively; long legacy codes keep their original case.
 */
export function normalizeRoomCode(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  return trimmed.length <= 8 ? trimmed.toUpperCase() : trimmed;
}

function codeVariants(value: string): string[] {
  const trimmed = value.trim();
  const variants = [trimmed, trimmed.toUpperCase()];
  return [...new Set(variants.filter(Boolean))];
}

export function hmacRoomCode(secret: Buffer, code: string): string {
  return createHmac('sha256', secret).update(code, 'utf8').digest('hex');
}

function codeHmacCandidates(secret: Buffer, code: string): string[] {
  return [...new Set(codeVariants(code).map((variant) => hmacRoomCode(secret, variant)))];
}

export function generateRoomCode(): string {
  let code = '';
  for (let index = 0; index < 8; index += 1) {
    code += ROOM_CODE_ALPHABET[randomInt(0, ROOM_CODE_ALPHABET.length)];
  }
  return code;
}

export interface PasswordHashOptions {
  N?: number;
  r?: number;
  p?: number;
  keyLength?: number;
}

const DEFAULT_PASSWORD_OPTIONS: Required<PasswordHashOptions> = { N: 16384, r: 8, p: 1, keyLength: 64 };

export function hashRoomPassword(password: string, options: PasswordHashOptions = {}): string {
  if (password.length < PASSWORD_MIN_LENGTH) throw new Error(`Пароль ведущего должен содержать не менее ${PASSWORD_MIN_LENGTH} символов.`);
  const { N, r, p, keyLength } = { ...DEFAULT_PASSWORD_OPTIONS, ...options };
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, keyLength, { N, r, p, maxmem: 128 * 1024 * 1024 });
  return `scrypt$${N}$${r}$${p}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyRoomPassword(stored: string, password: string): boolean {
  if (typeof password !== 'string' || password.length === 0) return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isSafeInteger(N) || !Number.isSafeInteger(r) || !Number.isSafeInteger(p)) return false;
  if (N < 1024 || N > 1_048_576 || r < 1 || r > 32 || p < 1 || p > 16) return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4], 'hex');
    expected = Buffer.from(parts[5], 'hex');
  } catch {
    return false;
  }
  if (salt.length < 8 || expected.length < 16) return false;
  let actual: Buffer;
  try {
    actual = scryptSync(password, salt, expected.length, { N, r, p, maxmem: 128 * 1024 * 1024 });
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function readSecretFile(path: string): Buffer {
  const raw = readFileSync(path, 'utf8').trim();
  const secret = Buffer.from(raw, 'base64url');
  if (secret.length < SECRET_BYTES) throw new Error(`Файл ${path} содержит слишком короткий секрет.`);
  return secret;
}

/** Creates the server secret only when it does not exist yet. */
export function ensureServerSecret(dataDir: string): Buffer {
  const path = serverSecretPath(dataDir);
  if (existsSync(path)) return readSecretFile(path);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const secret = randomBytes(SECRET_BYTES);
  try {
    writeFileSync(path, `${secret.toString('base64url')}\n`, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    // Another process may have created the secret concurrently.
    if (existsSync(path)) return readSecretFile(path);
    throw error;
  }
  chmodSync(path, 0o600);
  return secret;
}

/** Reads the secret without ever creating a replacement for an existing catalog. */
export function readServerSecret(dataDir: string): Buffer {
  const path = serverSecretPath(dataDir);
  if (!existsSync(path)) throw new CatalogSecretMissingError(path);
  return readSecretFile(path);
}

interface RoomRow {
  id: string;
  name: string;
  system_id: string | null;
  system_version: string | null;
  room_code_hmac: string;
  gm_password_hash: string;
  status: RoomStatus;
  created_at: string;
  updated_at: string;
}

function toRoom(row: RoomRow): CatalogRoom {
  return {
    id: row.id,
    name: row.name,
    systemId: row.system_id,
    systemVersion: row.system_version,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function createSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS room_catalog_meta (
      version INTEGER NOT NULL
    );
    INSERT INTO room_catalog_meta (version)
      SELECT ${CATALOG_VERSION} WHERE NOT EXISTS (SELECT 1 FROM room_catalog_meta);
    CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      system_id TEXT,
      system_version TEXT,
      room_code_hmac TEXT NOT NULL UNIQUE,
      gm_password_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'archived')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS rooms_status ON rooms(status);
  `);
}

export interface OpenCatalogOptions {
  /** Explicit secret, used by tests and by the initialization command. */
  secret?: Buffer;
}

export class RoomCatalog {
  readonly dataDir: string;
  readonly path: string;
  readonly secret: Buffer;
  readonly db: Database.Database;

  private constructor(dataDir: string, path: string, secret: Buffer) {
    this.dataDir = dataDir;
    this.path = path;
    this.secret = secret;
    this.db = new Database(path);
    chmodSync(path, 0o600);
    this.db.pragma('journal_mode = DELETE');
    this.db.pragma('foreign_keys = ON');
    createSchema(this.db);
  }

  /** Opens an initialized catalog. Never creates a secret or schema implicitly. */
  static open(dataDir: string, options: OpenCatalogOptions = {}): RoomCatalog {
    const path = catalogPath(dataDir);
    if (!existsSync(path)) throw new CatalogNotInitializedError(dataDir);
    const secret = options.secret ?? readServerSecret(dataDir);
    return new RoomCatalog(dataDir, path, secret);
  }

  /** Creates the catalog when absent; an existing catalog is never rewritten. */
  static initialize(dataDir: string, options: OpenCatalogOptions = {}): RoomCatalog {
    const path = catalogPath(dataDir);
    const existed = existsSync(path);
    const secret = options.secret ?? (existed ? readServerSecret(dataDir) : ensureServerSecret(dataDir));
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    return new RoomCatalog(dataDir, path, secret);
  }

  close(): void {
    if (this.db.open) this.db.close();
  }

  getRoom(roomId: string): CatalogRoom | undefined {
    if (!ROOM_ID_PATTERN.test(roomId)) return undefined;
    const row = this.db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId) as RoomRow | undefined;
    return row ? toRoom(row) : undefined;
  }

  findRoomByCode(code: string): CatalogRoom | undefined {
    if (!code || code.length > 128) return undefined;
    const statement = this.db.prepare('SELECT * FROM rooms WHERE room_code_hmac = ?');
    for (const hmac of codeHmacCandidates(this.secret, code)) {
      const row = statement.get(hmac) as RoomRow | undefined;
      if (row) return toRoom(row);
    }
    return undefined;
  }

  codeExists(code: string): boolean {
    return Boolean(this.findRoomByCode(code));
  }

  listRooms(): CatalogRoom[] {
    return (this.db.prepare('SELECT * FROM rooms ORDER BY created_at ASC, rowid ASC').all() as RoomRow[]).map(toRoom);
  }

  verifyGmPassword(roomId: string, password: string): boolean {
    const row = this.db.prepare('SELECT gm_password_hash FROM rooms WHERE id = ?').get(roomId) as { gm_password_hash: string } | undefined;
    return Boolean(row && verifyRoomPassword(row.gm_password_hash, password));
  }

  createRoom(input: NewCatalogRoom): CatalogRoom {
    assertValidRoomId(input.id);
    if (!input.name.trim()) throw new Error('Название комнаты не может быть пустым.');
    if (!normalizeRoomCode(input.code)) throw new Error('Код комнаты не может быть пустым.');
    if (this.getRoom(input.id)) throw new RoomConflictError(`Комната ${input.id} уже существует.`);
    const hmac = hmacRoomCode(this.secret, normalizeRoomCode(input.code));
    if (this.db.prepare('SELECT 1 FROM rooms WHERE room_code_hmac = ?').get(hmac)) {
      throw new RoomConflictError('Код комнаты уже используется. Сгенерируйте другой код.');
    }
    this.db.prepare(`INSERT INTO rooms (id, name, system_id, system_version, room_code_hmac, gm_password_hash, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(input.id, input.name.trim(), input.systemId, input.systemVersion, hmac, input.passwordHash, input.status ?? 'active');
    return this.getRoom(input.id)!;
  }

  setStatus(roomId: string, status: RoomStatus): CatalogRoom {
    assertValidRoomId(roomId);
    if (!this.getRoom(roomId)) throw new Error(`Комната ${roomId} не найдена.`);
    this.db.prepare('UPDATE rooms SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(status, roomId);
    return this.getRoom(roomId)!;
  }
}
