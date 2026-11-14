import { createHash } from 'node:crypto';
import { chmod, cp, mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { createBackup, verifyBackup } from './backup-lib.js';
import { loadConfig } from './config.js';
import {
  DEFAULT_ROOM_ID,
  commitStorageMarker,
  legacyLayoutExists,
  readStorageMarker,
  roomDirectory,
  StorageLayoutError,
  storageMarkerPath,
} from './room-storage.js';
import { RoomStore } from './store.js';

export interface MigrationResult {
  roomDir: string;
  alreadyMigrated: boolean;
  safetyCopy: string;
  rows: number;
  assets: number;
  backupName?: string;
}

function timestamp(): string {
  return new Date().toISOString().replaceAll(':', '-').replace(/\.\d+Z$/, 'Z');
}

async function sha256File(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function copyAssetTree(source: string, target: string): Promise<number> {
  if (!existsSync(source)) return 0;
  await mkdir(target, { recursive: true, mode: 0o700 });
  await chmod(target, 0o700);
  let count = 0;
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const destination = join(target, entry.name);
    await cp(join(source, entry.name), destination, { force: false, errorOnExist: true });
    await chmod(destination, 0o600);
    count += 1;
  }
  return count;
}

function tableNames(database: Database.Database): string[] {
  return (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>)
    .map((row) => row.name);
}

function countRows(database: Database.Database, table: string): number {
  return (database.prepare(`SELECT COUNT(*) AS count FROM "${table.replaceAll('"', '""')}"`).get() as { count: number }).count;
}

/** Check the copied database before any application-level migration touches it. */
async function verifyCopiedDatabase(sourcePath: string, targetPath: string): Promise<number> {
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  const target = new Database(targetPath, { readonly: true, fileMustExist: true });
  try {
    for (const database of [source, target]) {
      const integrity = database.pragma('integrity_check') as Array<{ integrity_check: string }>;
      if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
        throw new Error('Проверка integrity_check не прошла для базы комнаты.');
      }
      if ((database.pragma('foreign_key_check') as unknown[]).length > 0) {
        throw new Error('Проверка foreign_key_check обнаружила нарушенные ссылки.');
      }
    }
    let total = 0;
    for (const table of tableNames(source)) {
      const expected = countRows(source, table);
      const actual = countRows(target, table);
      if (expected !== actual) throw new Error(`Количество строк в таблице ${table} не совпадает: было ${expected}, стало ${actual}.`);
      total += expected;
    }
    return total;
  } finally {
    source.close();
    target.close();
  }
}

async function compareAssets(sourceDir: string, targetDir: string): Promise<number> {
  if (!existsSync(sourceDir)) return 0;
  let count = 0;
  for (const entry of await readdir(sourceDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const source = join(sourceDir, entry.name);
    const target = join(targetDir, entry.name);
    if (!existsSync(target)) throw new Error(`Не скопирован ресурс ${entry.name}.`);
    const [sourceStat, targetStat] = await Promise.all([stat(source), stat(target)]);
    if (sourceStat.size !== targetStat.size) throw new Error(`Размер ресурса ${entry.name} не совпадает после копирования.`);
    if (await sha256File(source) !== await sha256File(target)) throw new Error(`SHA-256 ресурса ${entry.name} не совпадает после копирования.`);
    count += 1;
  }
  return count;
}

async function verifyAssetsAgainstDatabase(databasePath: string, assetsDir: string): Promise<number> {
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  let assets: Array<{ id: string; sha256: string; size: number }>;
  try {
    assets = database.prepare('SELECT id, sha256, size FROM assets ORDER BY id').all() as Array<{ id: string; sha256: string; size: number }>;
  } finally {
    database.close();
  }
  for (const asset of assets) {
    const file = join(assetsDir, asset.id);
    if (!existsSync(file)) throw new Error(`В целевой комнате отсутствует изображение ${asset.id}.`);
    const info = await stat(file);
    if (info.size !== asset.size) throw new Error(`Размер изображения ${asset.id} не совпадает с базой.`);
    if (await sha256File(file) !== asset.sha256) throw new Error(`SHA-256 изображения ${asset.id} не совпадает с базой.`);
  }
  return assets.length;
}

/**
 * One-time, idempotent move of `data/room.sqlite`, `data/assets` and
 * `data/backups` into `data/rooms/default`. The storage marker is written last,
 * which is the commit point; the old layout is never deleted automatically.
 */
export async function migrateStorage(dataDir: string, roomName: string): Promise<MigrationResult> {
  const targetDir = roomDirectory(dataDir);
  const marker = readStorageMarker(dataDir);
  if (marker) {
    if (marker.roomId !== DEFAULT_ROOM_ID) throw new StorageLayoutError(`Маркер хранилища указывает на неизвестную комнату «${marker.roomId}».`);
    if (!existsSync(join(targetDir, 'room.sqlite'))) {
      throw new StorageLayoutError(`Маркер ${storageMarkerPath(dataDir)} существует, но ${targetDir}/room.sqlite отсутствует.`);
    }
    return { roomDir: targetDir, alreadyMigrated: true, safetyCopy: '', rows: 0, assets: 0 };
  }

  if (!legacyLayoutExists(dataDir)) {
    throw new StorageLayoutError(`В ${dataDir} нет room.sqlite: миграция не требуется или исходные данные отсутствуют.`);
  }
  if (existsSync(targetDir)) {
    throw new StorageLayoutError(`Каталог ${targetDir} уже существует, но маркер хранилища отсутствует. Проверьте незавершённую миграцию вручную; данные не перезаписываются.`);
  }

  // A complete filesystem copy outside data/ is the rollback point. The server
  // must be stopped for this operation, so a plain recursive copy is safe.
  const safetyCopy = join(dirname(dataDir), `${basename(dataDir)}.pre-migration-${timestamp()}`);
  if (existsSync(safetyCopy)) throw new StorageLayoutError(`Каталог резервной копии ${safetyCopy} уже существует.`);
  await cp(dataDir, safetyCopy, { recursive: true, force: false, errorOnExist: true });

  await mkdir(join(dataDir, 'rooms'), { recursive: true, mode: 0o700 });
  await mkdir(targetDir, { recursive: false, mode: 0o700 });

  // SQLite's own backup API produces a consistent copy without modifying the
  // source and without leaving a WAL/journal behind.
  const sourceDatabase = new Database(join(dataDir, 'room.sqlite'), { readonly: true, fileMustExist: true });
  try {
    await sourceDatabase.backup(join(targetDir, 'room.sqlite'));
  } finally {
    sourceDatabase.close();
  }
  await chmod(join(targetDir, 'room.sqlite'), 0o600);

  const assets = await copyAssetTree(join(dataDir, 'assets'), join(targetDir, 'assets'));
  if (existsSync(join(dataDir, 'backups'))) {
    await cp(join(dataDir, 'backups'), join(targetDir, 'backups'), { recursive: true, force: false, errorOnExist: true });
  }

  const rows = await verifyCopiedDatabase(join(dataDir, 'room.sqlite'), join(targetDir, 'room.sqlite'));
  const copiedAssets = await compareAssets(join(dataDir, 'assets'), join(targetDir, 'assets'));
  await verifyAssetsAgainstDatabase(join(targetDir, 'room.sqlite'), join(targetDir, 'assets'));
  if (assets !== copiedAssets) throw new Error('Количество скопированных ресурсов не совпадает с исходным каталогом.');

  // Opening the target applies the application-level schema migrations (for
  // example the participants/sessions split) and proves the store is usable.
  const store = new RoomStore(targetDir, roomName);
  try {
    const assetRows = (store.db.prepare('SELECT COUNT(*) AS count FROM assets').get() as { count: number }).count;
    if (assetRows !== assets) throw new Error(`База содержит ${assetRows} ресурсов, а файлов скопировано ${assets}.`);
  } finally {
    store.close();
  }

  const backup = await createBackup(targetDir, roomName, 'post-migration');
  await verifyBackup(backup.path);

  commitStorageMarker(dataDir);
  return { roomDir: targetDir, alreadyMigrated: false, safetyCopy, rows, assets, backupName: backup.name };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const result = await migrateStorage(config.dataDir, config.roomName);
  if (result.alreadyMigrated) {
    console.log(`Хранилище уже мигрировано: ${result.roomDir}`);
    return;
  }
  console.log(`Миграция завершена: ${result.roomDir}`);
  console.log(`Резервная копия исходных данных: ${result.safetyCopy}`);
  console.log(`Перенесено строк: ${result.rows}; изображений: ${result.assets}; проверочная копия: ${result.backupName}.`);
  console.log('Старые data/room.sqlite, data/assets и data/backups не удалены — их можно использовать для отката.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`Ошибка миграции: ${error instanceof Error ? error.message : 'неизвестная ошибка'}`);
    process.exitCode = 1;
  });
}
