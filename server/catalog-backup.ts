import { chmod, cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import Database from 'better-sqlite3';
import { catalogPath, serverSecretPath } from './catalog.js';
import { adminRoomDirectory, listRoomDirectories } from './room-admin.js';

export interface CatalogBackupManifest {
  version: 1;
  kind: 'catalog' | 'install';
  name: string;
  createdAt: string;
  files: Array<{ path: string; size: number; sha256: string }>;
  rooms?: Array<{ id: string; systemId: string | null; systemVersion: string | null; status: string }>;
}

export interface CatalogBackupInfo {
  name: string;
  path: string;
  createdAt: string;
  kind: 'catalog' | 'install';
}

function timestamp(prefix: string): string {
  return `${prefix}-${new Date().toISOString().replaceAll(':', '-')}`;
}

async function hash(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function addFile(files: CatalogBackupManifest['files'], root: string, relative: string): Promise<void> {
  const absolute = join(root, relative);
  const info = await stat(absolute);
  files.push({ path: relative, size: info.size, sha256: await hash(absolute) });
}

async function copyAssets(sourceRoot: string, targetRoot: string, relativePrefix: string, files: CatalogBackupManifest['files']): Promise<void> {
  const source = join(sourceRoot, 'assets');
  const target = join(targetRoot, relativePrefix, 'assets');
  await mkdir(target, { recursive: true, mode: 0o700 });
  if (!existsSync(source)) return;
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const relative = `${relativePrefix}/assets/${entry.name}`;
    await cp(join(source, entry.name), join(targetRoot, relative), { force: true });
    await chmod(join(targetRoot, relative), 0o600);
    await addFile(files, targetRoot, relative);
  }
}

function backupDirectory(kind: 'catalog' | 'install', dataDir: string): string {
  return join(dataDir, kind === 'catalog' ? 'catalog-backups' : 'install-backups');
}

export function resolveCatalogBackup(dataDir: string, kind: 'catalog' | 'install', name: string): string {
  if (!name || name !== basename(name) || name === '.' || name === '..' || name.startsWith('.')) {
    throw new Error('Укажите имя копии из списка.');
  }
  return join(backupDirectory(kind, dataDir), name);
}

export async function createCatalogBackup(dataDir: string, prefix = 'catalog'): Promise<CatalogBackupInfo> {
  const catalog = catalogPath(dataDir);
  const secret = serverSecretPath(dataDir);
  if (!existsSync(catalog)) throw new Error('Каталог комнат не инициализирован.');
  if (!existsSync(secret)) throw new Error('Файл server-secret отсутствует; резервная копия каталога была бы неполной.');
  const root = backupDirectory('catalog', dataDir);
  await mkdir(root, { recursive: true, mode: 0o700 });
  let name = timestamp(prefix);
  let suffix = 1;
  while (existsSync(join(root, name))) name = `${timestamp(prefix)}-${suffix++}`;
  const target = join(root, name);
  await mkdir(target, { recursive: true, mode: 0o700 });
  try {
    const source = new Database(catalog, { readonly: true, fileMustExist: true });
    try { await source.backup(join(target, 'catalog.sqlite')); } finally { source.close(); }
    await chmod(join(target, 'catalog.sqlite'), 0o600);
    await cp(secret, join(target, 'server-secret'), { force: true });
    await chmod(join(target, 'server-secret'), 0o600);
    const files: CatalogBackupManifest['files'] = [];
    await addFile(files, target, 'catalog.sqlite');
    await addFile(files, target, 'server-secret');
    const manifest: CatalogBackupManifest = {
      version: 1, kind: 'catalog', name, createdAt: new Date().toISOString(), files,
    };
    await writeFile(join(target, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    return { name, path: target, createdAt: manifest.createdAt, kind: 'catalog' };
  } catch (error) {
    await rm(target, { recursive: true, force: true });
    throw error;
  }
}

export async function verifyCatalogBackup(path: string): Promise<{ name: string; createdAt: string; rooms: number }> {
  const manifest = JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8')) as CatalogBackupManifest;
  if (manifest.version !== 1 || manifest.kind !== 'catalog' || !Array.isArray(manifest.files)) throw new Error('Манифест копии каталога повреждён.');
  for (const file of manifest.files) {
    if (file.path.startsWith('/') || file.path.includes('..')) throw new Error('Манифест копии каталога содержит недопустимый путь.');
    const absolute = join(path, file.path);
    if (!existsSync(absolute)) throw new Error(`В копии каталога отсутствует ${file.path}.`);
    const info = await stat(absolute);
    if (info.size !== file.size || await hash(absolute) !== file.sha256) throw new Error(`Файл ${file.path} не совпадает с манифестом.`);
  }
  const secret = await readFile(join(path, 'server-secret'));
  if (secret.toString('utf8').trim().length < 32) throw new Error('Секрет сервера в копии слишком короткий.');
  const database = new Database(join(path, 'catalog.sqlite'), { readonly: true, fileMustExist: true });
  let rooms = 0;
  try {
    const integrity = database.pragma('integrity_check') as Array<{ integrity_check: string }>;
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') throw new Error('Проверка целостности каталога не прошла.');
    rooms = (database.prepare('SELECT COUNT(*) AS count FROM rooms').get() as { count: number }).count;
  } finally { database.close(); }
  return { name: manifest.name, createdAt: manifest.createdAt, rooms };
}

export async function restoreCatalogBackup(dataDir: string, name: string): Promise<{ safety: string }> {
  const path = resolveCatalogBackup(dataDir, 'catalog', name);
  await verifyCatalogBackup(path);
  const safety = await createCatalogBackup(dataDir, 'pre-restore');
  const token = `${process.pid}-${Date.now()}`;
  const catalog = catalogPath(dataDir);
  const secret = serverSecretPath(dataDir);
  const previousCatalog = `${catalog}.${token}.previous`;
  const previousSecret = `${secret}.${token}.previous`;
  if (existsSync(catalog)) await rename(catalog, previousCatalog);
  if (existsSync(secret)) await rename(secret, previousSecret);
  try {
    await cp(join(path, 'catalog.sqlite'), catalog, { force: true });
    await chmod(catalog, 0o600);
    await cp(join(path, 'server-secret'), secret, { force: true });
    await chmod(secret, 0o600);
  } catch (error) {
    await rm(catalog, { force: true });
    await rm(secret, { force: true });
    if (existsSync(previousCatalog)) await rename(previousCatalog, catalog);
    if (existsSync(previousSecret)) await rename(previousSecret, secret);
    throw error;
  }
  await rm(previousCatalog, { force: true });
  await rm(previousSecret, { force: true });
  return { safety: safety.name };
}

/** Full installation backup: catalog, its secret and every room database/assets. */
export async function createInstallBackup(dataDir: string): Promise<CatalogBackupInfo> {
  const catalog = catalogPath(dataDir);
  const secret = serverSecretPath(dataDir);
  if (!existsSync(catalog)) throw new Error('Каталог комнат не инициализирован.');
  if (!existsSync(secret)) throw new Error('Файл server-secret отсутствует; полная копия была бы неполной.');
  const root = backupDirectory('install', dataDir);
  await mkdir(root, { recursive: true, mode: 0o700 });
  let name = timestamp('install');
  let suffix = 1;
  while (existsSync(join(root, name))) name = `${timestamp('install')}-${suffix++}`;
  const target = join(root, name);
  await mkdir(target, { recursive: true, mode: 0o700 });
  try {
    const source = new Database(catalog, { readonly: true, fileMustExist: true });
    let roomRows: Array<{ id: string; system_id: string | null; system_version: string | null; status: string }> = [];
    try {
      roomRows = source.prepare('SELECT id, system_id, system_version, status FROM rooms ORDER BY id').all() as typeof roomRows;
      await source.backup(join(target, 'catalog.sqlite'));
    } finally { source.close(); }
    await chmod(join(target, 'catalog.sqlite'), 0o600);
    await cp(secret, join(target, 'server-secret'), { force: true });
    await chmod(join(target, 'server-secret'), 0o600);

    const files: CatalogBackupManifest['files'] = [];
    await addFile(files, target, 'catalog.sqlite');
    await addFile(files, target, 'server-secret');
    for (const room of roomRows) {
      const directory = adminRoomDirectory(dataDir, room.id);
      if (!existsSync(join(directory, 'room.sqlite'))) continue;
      const relative = `rooms/${room.id}`;
      await mkdir(join(target, relative), { recursive: true, mode: 0o700 });
      const database = new Database(join(directory, 'room.sqlite'), { readonly: true, fileMustExist: true });
      try { await database.backup(join(target, relative, 'room.sqlite')); } finally { database.close(); }
      await chmod(join(target, relative, 'room.sqlite'), 0o600);
      await addFile(files, target, `${relative}/room.sqlite`);
      await copyAssets(directory, target, relative, files);
    }
    const manifest: CatalogBackupManifest = {
      version: 1,
      kind: 'install',
      name,
      createdAt: new Date().toISOString(),
      files,
      rooms: roomRows.map((room) => ({ id: room.id, systemId: room.system_id, systemVersion: room.system_version, status: room.status })),
    };
    await writeFile(join(target, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    return { name, path: target, createdAt: manifest.createdAt, kind: 'install' };
  } catch (error) {
    await rm(target, { recursive: true, force: true });
    throw error;
  }
}

export async function listCatalogBackups(dataDir: string, kind: 'catalog' | 'install'): Promise<CatalogBackupInfo[]> {
  const root = backupDirectory(kind, dataDir);
  if (!existsSync(root)) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const result: CatalogBackupInfo[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const path = join(root, entry.name);
    try {
      const manifest = JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8')) as CatalogBackupManifest;
      result.push({ name: entry.name, path, createdAt: manifest.createdAt ?? '', kind });
    } catch { /* Incomplete directories are not offered for restore. */ }
  }
  return result.sort((left, right) => right.name.localeCompare(left.name));
}

/** Verification for a full installation backup (restore remains a documented manual operation). */
export async function verifyInstallBackup(path: string): Promise<{ rooms: number; files: number }> {
  const manifest = JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8')) as CatalogBackupManifest;
  if (manifest.version !== 1 || manifest.kind !== 'install' || !Array.isArray(manifest.files)) throw new Error('Манифест полной копии повреждён.');
  for (const file of manifest.files) {
    if (file.path.startsWith('/') || file.path.includes('..')) throw new Error('Манифест полной копии содержит недопустимый путь.');
    const absolute = join(path, file.path);
    if (!existsSync(absolute)) throw new Error(`В полной копии отсутствует ${file.path}.`);
    const info = await stat(absolute);
    if (info.size !== file.size || await hash(absolute) !== file.sha256) throw new Error(`Файл ${file.path} не совпадает с манифестом.`);
  }
  const catalog = new Database(join(path, 'catalog.sqlite'), { readonly: true, fileMustExist: true });
  let rooms = 0;
  try {
    const integrity = catalog.pragma('integrity_check') as Array<{ integrity_check: string }>;
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') throw new Error('Проверка целостности каталога не прошла.');
    rooms = (catalog.prepare('SELECT COUNT(*) AS count FROM rooms').get() as { count: number }).count;
  } finally { catalog.close(); }
  for (const room of manifest.rooms ?? []) {
    const directory = join(path, 'rooms', room.id);
    const databasePath = join(directory, 'room.sqlite');
    if (!existsSync(databasePath)) throw new Error(`В полной копии отсутствует база комнаты ${room.id}.`);
    const database = new Database(databasePath, { readonly: true, fileMustExist: true });
    try {
      const integrity = database.pragma('integrity_check') as Array<{ integrity_check: string }>;
      if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') throw new Error(`Проверка базы комнаты ${room.id} не прошла.`);
    } finally { database.close(); }
  }
  return { rooms, files: manifest.files.length };
}

export function installedRoomDirectories(dataDir: string): string[] {
  return listRoomDirectories(dataDir);
}
