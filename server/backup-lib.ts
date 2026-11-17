import { chmod, cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, join, normalize, sep } from 'node:path';
import Database from 'better-sqlite3';
import { RoomStore } from './store.js';

export const BACKUP_FORMAT_VERSION = 2;

export interface BackupFile {
  path: string;
  size: number;
  sha256: string;
}

export interface BackupManifest {
  version: number;
  name: string;
  createdAt: string;
  roomId?: string;
  roomName: string;
  systemId?: string | null;
  systemVersion?: string | null;
  schemaVersion?: number;
  assetCount: number;
  databaseBytes: number;
  files?: BackupFile[];
}

export interface BackupInfo extends BackupManifest {
  path: string;
}

export interface BackupMetadata {
  roomId?: string;
  systemId?: string | null;
  systemVersion?: string | null;
  schemaVersion?: number;
}

export interface VerifyResult {
  version: number;
  assetCount: number;
  databaseBytes: number;
  roomId?: string;
  roomName?: string;
  systemId?: string | null;
  systemVersion?: string | null;
  schemaVersion?: number;
}

export interface RestoreExpectation {
  roomId?: string;
  systemId?: string | null;
  systemVersion?: string | null;
  /** Allows restoring a backup of a deleted room into a newly created one. */
  allowRoomMismatch?: boolean;
}

export interface BackupOptions {
  /**
   * Copies the SQLite file with a read-only connection. Offline migrations use
   * this so creating the safety copy cannot run schema upgrades on the source.
   */
  raw?: boolean;
}

export class BackupRoomMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupRoomMismatchError';
  }
}

function backupsDirectory(roomDir: string): string {
  return join(roomDir, 'backups');
}

function timestampName(prefix: string): string {
  return `${prefix}-${new Date().toISOString().replaceAll(':', '-')}`;
}

/** Only a plain directory name is accepted, so restore cannot escape roomDir/backups. */
export function resolveBackupDirectory(roomDir: string, name: string): string {
  if (!name || name !== basename(name) || name === '.' || name === '..' || name.startsWith('.')) {
    throw new Error('Укажите имя копии из списка резервных копий.');
  }
  return join(backupsDirectory(roomDir), name);
}

async function readManifest(backupPath: string): Promise<Partial<BackupManifest> | undefined> {
  try {
    return JSON.parse(await readFile(join(backupPath, 'manifest.json'), 'utf8')) as Partial<BackupManifest>;
  } catch {
    return undefined;
  }
}

async function countAssetFiles(directory: string): Promise<number> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).length;
  } catch {
    return 0;
  }
}

function hashFileSync(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

async function hashFile(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

function readSystemFromDatabase(databasePath: string): { systemId: string | null; systemVersion: string | null } | undefined {
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const columns = database.pragma('table_info(room)') as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    if (!names.has('system_id') || !names.has('system_version')) return undefined;
    const row = database.prepare('SELECT system_id, system_version, system_fixed FROM room WHERE id = 1').get() as
      { system_id: string | null; system_version: string | null; system_fixed: number } | undefined;
    if (!row || Number(row.system_fixed) !== 1) return undefined;
    return { systemId: row.system_id, systemVersion: row.system_version };
  } finally {
    database.close();
  }
}

/**
 * SQLite is copied with better-sqlite3's online backup API, which produces a
 * consistent snapshot even if the server is still writing. The original image
 * files are copied afterwards from the same room directory.
 */
export async function createBackup(
  roomDir: string,
  roomName: string,
  prefix = 'backup',
  metadata: BackupMetadata = {},
  options: BackupOptions = {},
): Promise<BackupInfo> {
  const directory = backupsDirectory(roomDir);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let name = timestampName(prefix);
  let suffix = 1;
  while (existsSync(join(directory, name))) name = `${timestampName(prefix)}-${suffix++}`;
  const backupPath = join(directory, name);
  await mkdir(backupPath, { recursive: true, mode: 0o700 });
  const backupAssets = join(backupPath, 'assets');
  await mkdir(backupAssets, { recursive: true, mode: 0o700 });

  let systemId = metadata.systemId ?? null;
  let systemVersion = metadata.systemVersion ?? null;
  if (options.raw) {
    const source = new Database(join(roomDir, 'room.sqlite'), { readonly: true, fileMustExist: true });
    try {
      await source.backup(join(backupPath, 'room.sqlite'));
    } catch (error) {
      source.close();
      await rm(backupPath, { recursive: true, force: true });
      throw error;
    }
    source.close();
  } else {
    const store = new RoomStore(roomDir, roomName);
    try {
      const fixed = store.fixedSystem;
      if (systemId === null && fixed) systemId = fixed.id;
      if (systemVersion === null && fixed) systemVersion = fixed.version;
      await store.backup(join(backupPath, 'room.sqlite'));
    } catch (error) {
      store.close();
      await rm(backupPath, { recursive: true, force: true });
      throw error;
    }
    store.close();
  }

  try {
    const files: BackupFile[] = [];
    const databasePath = join(backupPath, 'room.sqlite');
    const databaseBytes = (await stat(databasePath)).size;
    await chmod(databasePath, 0o600);
    files.push({ path: 'room.sqlite', size: databaseBytes, sha256: hashFileSync(databasePath) });

    const sourceAssets = join(roomDir, 'assets');
    if (existsSync(sourceAssets)) {
      for (const entry of await readdir(sourceAssets, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const target = join(backupAssets, entry.name);
        await cp(join(sourceAssets, entry.name), target, { errorOnExist: true, force: false });
        await chmod(target, 0o600);
        const info = await stat(target);
        files.push({ path: `assets/${entry.name}`, size: info.size, sha256: await hashFile(target) });
      }
    }
    files.sort((left, right) => left.path.localeCompare(right.path));
    const manifest: BackupManifest = {
      version: BACKUP_FORMAT_VERSION,
      name,
      createdAt: new Date().toISOString(),
      ...(metadata.roomId ? { roomId: metadata.roomId } : {}),
      roomName,
      systemId,
      systemVersion,
      schemaVersion: metadata.schemaVersion ?? 1,
      assetCount: files.filter((file) => file.path.startsWith('assets/')).length,
      databaseBytes,
      files,
    };
    await writeFile(join(backupPath, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    return { ...manifest, path: backupPath };
  } catch (error) {
    await rm(backupPath, { recursive: true, force: true });
    throw error;
  }
}

export async function listBackups(roomDir: string): Promise<BackupInfo[]> {
  const directory = backupsDirectory(roomDir);
  if (!existsSync(directory)) return [];
  const backups: BackupInfo[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const backupPath = join(directory, entry.name);
    if (!existsSync(join(backupPath, 'room.sqlite'))) continue;
    const manifest = await readManifest(backupPath);
    const database = await stat(join(backupPath, 'room.sqlite'));
    backups.push({
      version: typeof manifest?.version === 'number' ? manifest.version : 1,
      name: entry.name,
      createdAt: typeof manifest?.createdAt === 'string' ? manifest.createdAt : database.mtime.toISOString(),
      ...(typeof manifest?.roomId === 'string' ? { roomId: manifest.roomId } : {}),
      roomName: typeof manifest?.roomName === 'string' ? manifest.roomName : '',
      systemId: typeof manifest?.systemId === 'string' || manifest?.systemId === null ? manifest.systemId : null,
      systemVersion: typeof manifest?.systemVersion === 'string' || manifest?.systemVersion === null ? manifest.systemVersion : null,
      schemaVersion: typeof manifest?.schemaVersion === 'number' ? manifest.schemaVersion : undefined,
      assetCount: typeof manifest?.assetCount === 'number' ? manifest.assetCount : await countAssetFiles(join(backupPath, 'assets')),
      databaseBytes: database.size,
      path: backupPath,
    });
  }
  return backups.sort((left, right) => right.name.localeCompare(left.name));
}

function assertSafeRelativePath(path: string): void {
  if (!path || path.startsWith('/') || path.includes('\\') || path.split('/').some((part) => part === '..' || part === '')) {
    throw new Error('Манифест резервной копии содержит недопустимый путь.');
  }
  const normalized = normalize(path);
  if (normalized.startsWith(`..${sep}`) || normalized === '..') throw new Error('Манифест резервной копии содержит недопустимый путь.');
}

/**
 * Opens the snapshot read-only and checks SQLite integrity, foreign keys, the
 * manifest checksums and every referenced image file.
 */
export async function verifyBackup(backupPath: string): Promise<VerifyResult> {
  const databasePath = join(backupPath, 'room.sqlite');
  if (!existsSync(databasePath)) throw new Error('В резервной копии отсутствует room.sqlite.');
  const manifest = await readManifest(backupPath);
  let assets: Array<{ id: string; size: number }>;
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const integrity = database.pragma('integrity_check') as Array<{ integrity_check: string }>;
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
      throw new Error('Проверка целостности SQLite не прошла.');
    }
    if ((database.pragma('foreign_key_check') as unknown[]).length > 0) {
      throw new Error('Резервная копия содержит нарушенные внешние ключи.');
    }
    if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'room'").get()) {
      throw new Error('Файл не похож на базу комнаты.');
    }
    assets = database.prepare('SELECT id, size FROM assets ORDER BY id').all() as Array<{ id: string; size: number }>;
  } finally {
    database.close();
  }

  const assetsPath = join(backupPath, 'assets');
  for (const asset of assets) {
    const file = join(assetsPath, asset.id);
    if (!existsSync(file)) throw new Error(`В резервной копии отсутствует изображение ${asset.id}.`);
    const info = await stat(file);
    if (info.size !== asset.size) throw new Error(`Размер изображения ${asset.id} не совпадает с базой.`);
  }

  if (typeof manifest?.version === 'number' && manifest.version >= 2 && Array.isArray(manifest.files)) {
    for (const file of manifest.files) {
      if (!file || typeof file.path !== 'string' || typeof file.size !== 'number' || typeof file.sha256 !== 'string') {
        throw new Error('Манифест резервной копии повреждён.');
      }
      assertSafeRelativePath(file.path);
      const absolute = join(backupPath, file.path);
      if (!existsSync(absolute)) throw new Error(`В резервной копии отсутствует файл ${file.path}.`);
      const info = await stat(absolute);
      if (info.size !== file.size) throw new Error(`Размер файла ${file.path} не совпадает с манифестом.`);
      if (await hashFile(absolute) !== file.sha256) throw new Error(`Контрольная сумма файла ${file.path} не совпадает с манифестом.`);
    }
  }

  const databaseSystem = readSystemFromDatabase(databasePath);
  return {
    version: typeof manifest?.version === 'number' ? manifest.version : 1,
    assetCount: assets.length,
    databaseBytes: (await stat(databasePath)).size,
    ...(typeof manifest?.roomId === 'string' ? { roomId: manifest.roomId } : {}),
    ...(typeof manifest?.roomName === 'string' ? { roomName: manifest.roomName } : {}),
    systemId: databaseSystem?.systemId ?? (typeof manifest?.systemId === 'string' ? manifest.systemId : null),
    systemVersion: databaseSystem?.systemVersion ?? (typeof manifest?.systemVersion === 'string' ? manifest.systemVersion : null),
    schemaVersion: typeof manifest?.schemaVersion === 'number' ? manifest.schemaVersion : 1,
  };
}

async function copyDirectory(source: string, target: string): Promise<void> {
  await mkdir(target, { recursive: true, mode: 0o700 });
  if (!existsSync(source)) return;
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const destination = join(target, entry.name);
    await cp(join(source, entry.name), destination, { force: true });
    await chmod(destination, 0o600);
  }
}

/**
 * Restores a verified snapshot. A safety backup of the current state is always
 * created first, and the database/assets pair is swapped together. If either
 * move fails, the previous state is put back.
 */
export async function restoreBackup(
  roomDir: string,
  roomName: string,
  name: string,
  expected: RestoreExpectation = {},
): Promise<{ safetyBackup: string }> {
  const backupPath = resolveBackupDirectory(roomDir, name);
  const verified = await verifyBackup(backupPath);
  if (!expected.allowRoomMismatch && expected.roomId && verified.roomId && expected.roomId !== verified.roomId) {
    throw new BackupRoomMismatchError(`Копия принадлежит комнате ${verified.roomId}, а не ${expected.roomId}.`);
  }
  if (expected.systemId && verified.systemId && (expected.systemId !== verified.systemId || expected.systemVersion !== verified.systemVersion)) {
    throw new BackupRoomMismatchError('Системная принадлежность резервной копии не совпадает с целевой комнатой.');
  }
  if (expected.systemId && !verified.systemId) {
    throw new BackupRoomMismatchError('Не удалось достоверно определить игровую систему резервной копии.');
  }

  const safety = await createBackup(roomDir, roomName, 'pre-restore', {
    ...(verified.systemId ? { systemId: verified.systemId, systemVersion: verified.systemVersion } : {}),
    schemaVersion: verified.schemaVersion,
  });
  const token = `${process.pid}-${Date.now()}`;
  const temporaryDatabase = join(roomDir, `.room.sqlite.${token}.restore`);
  const temporaryAssets = join(roomDir, `.assets.${token}.restore`);
  const previousDatabase = join(roomDir, `.room.sqlite.${token}.previous`);
  const previousAssets = join(roomDir, `.assets.${token}.previous`);

  try {
    await cp(join(backupPath, 'room.sqlite'), temporaryDatabase, { force: true });
    await chmod(temporaryDatabase, 0o600);
    await copyDirectory(join(backupPath, 'assets'), temporaryAssets);
  } catch (error) {
    await rm(temporaryDatabase, { force: true });
    await rm(temporaryAssets, { recursive: true, force: true });
    throw error;
  }

  let movedDatabase = false;
  let movedAssets = false;
  try {
    if (existsSync(join(roomDir, 'room.sqlite'))) {
      await rename(join(roomDir, 'room.sqlite'), previousDatabase);
      movedDatabase = true;
    }
    if (existsSync(join(roomDir, 'assets'))) {
      await rename(join(roomDir, 'assets'), previousAssets);
      movedAssets = true;
    }
    await rename(temporaryDatabase, join(roomDir, 'room.sqlite'));
    await rename(temporaryAssets, join(roomDir, 'assets'));
  } catch (error) {
    await rm(join(roomDir, 'room.sqlite'), { force: true });
    await rm(join(roomDir, 'assets'), { recursive: true, force: true });
    if (movedDatabase) await rename(previousDatabase, join(roomDir, 'room.sqlite'));
    if (movedAssets) await rename(previousAssets, join(roomDir, 'assets'));
    await rm(temporaryDatabase, { force: true });
    await rm(temporaryAssets, { recursive: true, force: true });
    throw error;
  }

  for (const suffix of ['-journal', '-wal', '-shm']) {
    await rm(join(roomDir, `room.sqlite${suffix}`), { force: true });
  }
  await rm(previousDatabase, { force: true });
  await rm(previousAssets, { recursive: true, force: true });
  return { safetyBackup: safety.name };
}
