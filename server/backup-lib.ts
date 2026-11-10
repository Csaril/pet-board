import { chmod, cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import Database from 'better-sqlite3';
import { RoomStore } from './store.js';

export interface BackupManifest {
  version: 1;
  name: string;
  createdAt: string;
  roomName: string;
  assetCount: number;
  databaseBytes: number;
}

export interface BackupInfo extends BackupManifest {
  path: string;
}

function backupsDirectory(dataDir: string): string {
  return join(dataDir, 'backups');
}

function timestampName(prefix: string): string {
  return `${prefix}-${new Date().toISOString().replaceAll(':', '-')}`;
}

/** Only a plain directory name is accepted, so restore cannot escape data/backups. */
export function resolveBackupDirectory(dataDir: string, name: string): string {
  if (!name || name !== basename(name) || name === '.' || name === '..' || name.startsWith('.')) {
    throw new Error('Укажите имя копии из списка резервных копий.');
  }
  return join(backupsDirectory(dataDir), name);
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

/**
 * SQLite is copied with better-sqlite3's online backup API, which produces a
 * consistent snapshot even if the server is still writing. The original image
 * files are copied afterwards from the same data directory.
 */
export async function createBackup(dataDir: string, roomName: string, prefix = 'backup'): Promise<BackupInfo> {
  const directory = backupsDirectory(dataDir);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let name = timestampName(prefix);
  let suffix = 1;
  while (existsSync(join(directory, name))) name = `${timestampName(prefix)}-${suffix++}`;
  const backupPath = join(directory, name);
  await mkdir(backupPath, { recursive: true, mode: 0o700 });
  const backupAssets = join(backupPath, 'assets');
  await mkdir(backupAssets, { recursive: true, mode: 0o700 });

  const store = new RoomStore(dataDir, roomName);
  try {
    await store.backup(join(backupPath, 'room.sqlite'));
  } catch (error) {
    store.close();
    await rm(backupPath, { recursive: true, force: true });
    throw error;
  }
  store.close();

  try {
    const sourceAssets = join(dataDir, 'assets');
    if (existsSync(sourceAssets)) {
      for (const entry of await readdir(sourceAssets, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const target = join(backupAssets, entry.name);
        await cp(join(sourceAssets, entry.name), target, { errorOnExist: true, force: false });
        await chmod(target, 0o600);
      }
    }
    await chmod(join(backupPath, 'room.sqlite'), 0o600);
    const databaseBytes = (await stat(join(backupPath, 'room.sqlite'))).size;
    const manifest: BackupManifest = {
      version: 1,
      name,
      createdAt: new Date().toISOString(),
      roomName,
      assetCount: await countAssetFiles(backupAssets),
      databaseBytes,
    };
    await writeFile(join(backupPath, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    return { ...manifest, path: backupPath };
  } catch (error) {
    await rm(backupPath, { recursive: true, force: true });
    throw error;
  }
}

export async function listBackups(dataDir: string): Promise<BackupInfo[]> {
  const directory = backupsDirectory(dataDir);
  if (!existsSync(directory)) return [];
  const backups: BackupInfo[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const backupPath = join(directory, entry.name);
    if (!existsSync(join(backupPath, 'room.sqlite'))) continue;
    const manifest = await readManifest(backupPath);
    const database = await stat(join(backupPath, 'room.sqlite'));
    backups.push({
      version: 1,
      name: entry.name,
      createdAt: typeof manifest?.createdAt === 'string' ? manifest.createdAt : database.mtime.toISOString(),
      roomName: typeof manifest?.roomName === 'string' ? manifest.roomName : '',
      assetCount: typeof manifest?.assetCount === 'number' ? manifest.assetCount : await countAssetFiles(join(backupPath, 'assets')),
      databaseBytes: database.size,
      path: backupPath,
    });
  }
  return backups.sort((left, right) => right.name.localeCompare(left.name));
}

/** Opens the snapshot read-only and checks SQLite integrity plus every referenced image file. */
export async function verifyBackup(backupPath: string): Promise<{ assetCount: number; databaseBytes: number }> {
  const databasePath = join(backupPath, 'room.sqlite');
  if (!existsSync(databasePath)) throw new Error('В резервной копии отсутствует room.sqlite.');
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  let assets: Array<{ id: string; size: number }>;
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
  return { assetCount: assets.length, databaseBytes: (await stat(databasePath)).size };
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
export async function restoreBackup(dataDir: string, roomName: string, name: string): Promise<{ safetyBackup: string }> {
  const backupPath = resolveBackupDirectory(dataDir, name);
  await verifyBackup(backupPath);

  const safety = await createBackup(dataDir, roomName, 'pre-restore');
  const token = `${process.pid}-${Date.now()}`;
  const temporaryDatabase = join(dataDir, `.room.sqlite.${token}.restore`);
  const temporaryAssets = join(dataDir, `.assets.${token}.restore`);
  const previousDatabase = join(dataDir, `.room.sqlite.${token}.previous`);
  const previousAssets = join(dataDir, `.assets.${token}.previous`);

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
    if (existsSync(join(dataDir, 'room.sqlite'))) {
      await rename(join(dataDir, 'room.sqlite'), previousDatabase);
      movedDatabase = true;
    }
    if (existsSync(join(dataDir, 'assets'))) {
      await rename(join(dataDir, 'assets'), previousAssets);
      movedAssets = true;
    }
    await rename(temporaryDatabase, join(dataDir, 'room.sqlite'));
    await rename(temporaryAssets, join(dataDir, 'assets'));
  } catch (error) {
    await rm(join(dataDir, 'room.sqlite'), { force: true });
    await rm(join(dataDir, 'assets'), { recursive: true, force: true });
    if (movedDatabase) await rename(previousDatabase, join(dataDir, 'room.sqlite'));
    if (movedAssets) await rename(previousAssets, join(dataDir, 'assets'));
    await rm(temporaryDatabase, { force: true });
    await rm(temporaryAssets, { recursive: true, force: true });
    throw error;
  }

  for (const suffix of ['-journal', '-wal', '-shm']) {
    await rm(join(dataDir, `room.sqlite${suffix}`), { force: true });
  }
  await rm(previousDatabase, { force: true });
  await rm(previousAssets, { recursive: true, force: true });
  return { safetyBackup: safety.name };
}
