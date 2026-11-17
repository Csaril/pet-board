import { createInterface } from 'node:readline/promises';
import { copyFile, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import {
  compareSystemVersions,
  findLatestSystemMetadata,
  findSystemMetadata,
  type SystemMetadata,
} from '../src/modules/manifest.js';
import { createBackup } from './backup-lib.js';
import { createCatalogBackup } from './catalog-backup.js';
import { catalogPath, type CatalogRoom, type RoomStatus } from './catalog.js';
import { loadConfig } from './config.js';
import { assertServerStopped } from './instance-lock.js';
import { adminRoomDirectory, openCatalogForAdmin } from './room-admin.js';
import { RoomStore } from './store.js';
import { loadSystemServer } from './system-registry.js';
import type { SystemServerModule } from './system-contract.js';

export interface SystemMigrationRoomPlan {
  id: string;
  name: string;
  status: RoomStatus;
  directory: string;
  currentVersion: string;
  targetVersion: string;
  needsMigration: boolean;
  sheetCount: number;
  sheetsToMigrate: number;
  blockers: string[];
}

export interface SystemMigrationPlan {
  dataDir: string;
  systemId: string;
  systemName: string;
  targetVersion: string;
  targetSchemaVersion: number;
  rooms: SystemMigrationRoomPlan[];
  skippedRoomIds: string[];
  otherSystemRoomIds: string[];
  requiredMigrations: string[];
  blockers: string[];
  canApply: boolean;
}

export interface SystemMigrationRunOptions {
  dataDir: string;
  systemId: string;
  targetVersion?: string;
  dryRun?: boolean;
  yes?: boolean;
  confirm?: (plan: SystemMigrationPlan) => Promise<boolean> | boolean;
  logger?: (message: string) => void;
  /** Test hook: fail after staging this room to prove the whole operation rolls back. */
  failAfterStagingRoomId?: string;
  /** Test hook: fail after files and catalog were replaced to prove rollback. */
  failAfterApply?: boolean;
  /** Test hook: the lock file is exercised by its own test. */
  skipServerCheck?: boolean;
}

export interface SystemMigrationRunResult {
  plan: SystemMigrationPlan;
  applied: boolean;
  reason?: 'dry-run' | 'up-to-date' | 'declined';
  catalogBackup?: string;
  operationDir?: string;
  journalPath?: string;
  roomBackups: Array<{ roomId: string; name: string; path: string }>;
}

interface CatalogRow {
  id: string;
  name: string;
  system_id: string | null;
  system_version: string | null;
  status: RoomStatus;
  created_at: string;
  updated_at: string;
}

interface SheetInspection {
  id: string;
  systemVersion: string;
  schemaVersion: number;
  hasData: boolean;
}

interface RoomInspection {
  exists: boolean;
  fixed: boolean;
  systemId: string | null;
  systemVersion: string | null;
  sheets: SheetInspection[];
  integrityOk: boolean;
  foreignKeysOk: boolean;
}

function toCatalogRoom(row: CatalogRow): CatalogRoom {
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

/** Catalog reads during planning are strictly read-only: dry-run must not touch files. */
function readCatalogRooms(dataDir: string): CatalogRoom[] {
  const path = catalogPath(dataDir);
  if (!existsSync(path)) throw new Error(`Каталог комнат не инициализирован (${path}). Выполните npm run rooms:init.`);
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return (db.prepare('SELECT * FROM rooms ORDER BY created_at ASC, rowid ASC').all() as CatalogRow[]).map(toCatalogRoom);
  } finally {
    db.close();
  }
}

function tableExists(db: Database.Database, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

/** `null`, `"null"`, corrupt JSON and primitives are not usable system data. */
function isStoredJsonObject(raw: string | null): boolean {
  if (!raw) return false;
  try {
    const value = JSON.parse(raw) as unknown;
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  } catch {
    return false;
  }
}

function inspectRoom(directory: string, systemId: string): RoomInspection {
  const path = join(directory, 'room.sqlite');
  if (!existsSync(path)) {
    return { exists: false, fixed: false, systemId: null, systemVersion: null, sheets: [], integrityOk: false, foreignKeysOk: false };
  }
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const room = tableExists(db, 'room')
      ? db.prepare('SELECT system_id, system_version, system_fixed FROM room WHERE id = 1').get() as
        { system_id: string | null; system_version: string | null; system_fixed: number } | undefined
      : undefined;
    const sheets = tableExists(db, 'character_sheets')
      ? (db.prepare(`SELECT id, system_version, schema_version, system_data_json
          FROM character_sheets WHERE system_id = ? ORDER BY created_at ASC, rowid ASC`).all(systemId) as Array<{
            id: string; system_version: string; schema_version: number; system_data_json: string | null;
          }>).map((row) => ({
            id: row.id,
            systemVersion: row.system_version,
            schemaVersion: row.schema_version,
            hasData: isStoredJsonObject(row.system_data_json),
          }))
      : [];
    const integrity = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
    return {
      exists: true,
      fixed: Number(room?.system_fixed) === 1,
      systemId: room?.system_id ?? null,
      systemVersion: room?.system_version ?? null,
      sheets,
      integrityOk: integrity.length === 1 && integrity[0]?.integrity_check === 'ok',
      foreignKeysOk: (db.pragma('foreign_key_check') as unknown[]).length === 0,
    };
  } finally {
    db.close();
  }
}

function uniqueOperationDirectory(dataDir: string): string {
  const root = join(dataDir, 'backups', 'system-migrations');
  const stamp = new Date().toISOString().replaceAll(':', '-');
  let name = stamp;
  let suffix = 1;
  while (existsSync(join(root, name))) name = `${stamp}-${suffix++}`;
  return join(root, name);
}

async function writeJournal(operationDir: string, value: unknown): Promise<string> {
  await mkdir(operationDir, { recursive: true, mode: 0o700 });
  const path = join(operationDir, 'journal.json');
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  return path;
}

function describeRoom(room: SystemMigrationRoomPlan): string {
  return `${room.id} «${room.name}» (${room.status}): ${room.currentVersion} → ${room.targetVersion}`;
}

/**
 * Builds a complete, read-only plan. No catalog, database or backup file is
 * created or modified here, so the same function powers `--dry-run`.
 */
export async function planSystemMigration(
  dataDir: string,
  systemId: string,
  requestedVersion?: string,
): Promise<SystemMigrationPlan> {
  const target: SystemMetadata | undefined = requestedVersion
    ? findSystemMetadata(systemId, requestedVersion)
    : findLatestSystemMetadata(systemId);
  if (!target) {
    throw new Error(requestedVersion
      ? `Версия ${systemId}@${requestedVersion} не зарегистрирована в этой сборке.`
      : `Игровая система «${systemId}» не зарегистрирована в этой сборке.`);
  }

  const catalogRooms = readCatalogRooms(dataDir);
  const targetRooms = catalogRooms.filter((room) => room.systemId === systemId);
  const otherSystemRoomIds = catalogRooms.filter((room) => room.systemId !== systemId).map((room) => room.id);
  const blockers: string[] = [];
  const requiredMigrations: string[] = [];
  const skippedRoomIds: string[] = [];
  const rooms: SystemMigrationRoomPlan[] = [];

  let module: SystemServerModule | undefined;
  let moduleError: string | undefined;
  try {
    module = await loadSystemServer(target.id, target.version);
  } catch (error) {
    moduleError = error instanceof Error ? error.message : 'не удалось загрузить модуль';
  }

  for (const catalogRoom of targetRooms) {
    const directory = adminRoomDirectory(dataDir, catalogRoom.id);
    const inspection = inspectRoom(directory, systemId);
    const localBlockers: string[] = [];
    const currentVersion = inspection.systemVersion ?? catalogRoom.systemVersion ?? '—';

    if (!inspection.exists) localBlockers.push(`Каталог комнаты отсутствует: ${directory}.`);
    if (inspection.exists && !inspection.fixed) localBlockers.push('Игровая система комнаты не зафиксирована.');
    if (inspection.systemId !== null && inspection.systemId !== systemId) {
      localBlockers.push(`В базе комнаты система ${inspection.systemId}, а в каталоге ${systemId}.`);
    }
    if (inspection.systemVersion !== null && catalogRoom.systemVersion !== null && inspection.systemVersion !== catalogRoom.systemVersion) {
      localBlockers.push(`Версия в базе ${inspection.systemVersion} не совпадает с каталогом ${catalogRoom.systemVersion}.`);
    }
    if (inspection.exists && !inspection.integrityOk) localBlockers.push('Проверка целостности SQLite не прошла.');
    if (inspection.exists && !inspection.foreignKeysOk) localBlockers.push('В базе нарушены внешние ключи.');

    const sheetsToMigrate = inspection.sheets.filter(
      (sheet) => sheet.systemVersion !== target.version
        || sheet.schemaVersion !== target.sheetSchemaVersion
        || (module?.advancedSheet === true && !sheet.hasData),
    ).length;
    // A room can already be pinned to the latest version while one of its
    // sheets still carries an older schema; that sheet needs the same staged
    // migration instead of being skipped as "up to date".
    const needsMigration = inspection.systemVersion !== target.version || sheetsToMigrate > 0;
    if (needsMigration && inspection.systemVersion !== null && compareSystemVersions(inspection.systemVersion, target.version) > 0) {
      localBlockers.push(`Понижение версии запрещено: ${inspection.systemVersion} → ${target.version}.`);
    }
    if (needsMigration && module && !module.migrateRoomSheets) {
      localBlockers.push(`В модуле ${target.id}@${target.version} нет миграции листов.`);
    }

    if (!needsMigration) {
      skippedRoomIds.push(catalogRoom.id);
    } else {
      requiredMigrations.push(
        `${catalogRoom.id}: ${currentVersion} → ${target.version}`
        + (inspection.sheets.length ? `; листов к миграции: ${sheetsToMigrate} из ${inspection.sheets.length}` : '; листов нет'),
      );
    }

    rooms.push({
      id: catalogRoom.id,
      name: catalogRoom.name,
      status: catalogRoom.status,
      directory,
      currentVersion,
      targetVersion: target.version,
      needsMigration,
      sheetCount: inspection.sheets.length,
      sheetsToMigrate,
      blockers: localBlockers,
    });
    blockers.push(...localBlockers.map((blocker) => `${catalogRoom.id}: ${blocker}`));
  }

  if (moduleError) blockers.push(`Целевой модуль недоступен: ${moduleError}`);
  const hasWork = rooms.some((room) => room.needsMigration);
  return {
    dataDir,
    systemId,
    systemName: target.name,
    targetVersion: target.version,
    targetSchemaVersion: target.sheetSchemaVersion,
    rooms,
    skippedRoomIds,
    otherSystemRoomIds,
    requiredMigrations,
    blockers,
    canApply: hasWork && blockers.length === 0,
  };
}

function assertStagedRoom(
  directory: string,
  stagedPath: string,
  target: SystemMetadata,
  module: SystemServerModule,
): string[] {
  const problems: string[] = [];
  const db = new Database(stagedPath, { readonly: true, fileMustExist: true });
  try {
    const integrity = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') problems.push('integrity_check не прошёл.');
    if ((db.pragma('foreign_key_check') as unknown[]).length > 0) problems.push('foreign_key_check нашёл нарушения.');
    const room = db.prepare('SELECT system_id, system_version, system_fixed FROM room WHERE id = 1').get() as
      { system_id: string | null; system_version: string | null; system_fixed: number } | undefined;
    if (!room || Number(room.system_fixed) !== 1) problems.push('Система комнаты не зафиксирована.');
    if (room?.system_id !== target.id || room?.system_version !== target.version) {
      problems.push(`Версия комнаты после миграции ${room?.system_id ?? '—'}@${room?.system_version ?? '—'}, ожидается ${target.id}@${target.version}.`);
    }
    const sheets = db.prepare('SELECT id, system_version, schema_version, system_data_json FROM character_sheets WHERE system_id = ?')
      .all(target.id) as Array<{ id: string; system_version: string; schema_version: number; system_data_json: string | null }>;
    for (const sheet of sheets) {
      if (sheet.system_version !== target.version) problems.push(`Лист ${sheet.id}: версия ${sheet.system_version}.`);
      if (sheet.schema_version !== target.sheetSchemaVersion) problems.push(`Лист ${sheet.id}: схема ${sheet.schema_version}.`);
      if (module.advancedSheet && !isStoredJsonObject(sheet.system_data_json)) {
        problems.push(`Лист ${sheet.id}: отсутствуют или повреждены системные данные.`);
      }
    }
    const assets = db.prepare('SELECT id, size FROM assets ORDER BY id').all() as Array<{ id: string; size: number }>;
    for (const asset of assets) {
      const file = join(directory, 'assets', asset.id);
      if (!existsSync(file)) problems.push(`Отсутствует изображение ${asset.id}.`);
      else if (statSync(file).size !== asset.size) problems.push(`Размер изображения ${asset.id} не совпадает с базой.`);
    }
  } finally {
    db.close();
  }
  return problems;
}

function catalogRowsByRoom(rooms: CatalogRoom[]): Map<string, CatalogRoom> {
  return new Map(rooms.map((room) => [room.id, room]));
}

/**
 * Applies a plan with staged copies:
 * 1. catalog backup;
 * 2. raw backup of every affected room;
 * 3. migration on a copy, integrity/foreign-key/sheet/asset checks;
 * 4. atomic replacement of room.sqlite files;
 * 5. one catalog transaction;
 * 6. rollback of every replaced file and catalog pair on any failure.
 */
export async function migrateSystem(options: SystemMigrationRunOptions): Promise<SystemMigrationRunResult> {
  const logger = options.logger ?? (() => undefined);
  if (!options.skipServerCheck) assertServerStopped(options.dataDir);

  const plan = await planSystemMigration(options.dataDir, options.systemId, options.targetVersion);
  if (plan.blockers.length) {
    throw new Error(`Массовая миграция невозможна:\n- ${plan.blockers.join('\n- ')}`);
  }
  if (!plan.rooms.some((room) => room.needsMigration)) {
    return { plan, applied: false, reason: 'up-to-date', roomBackups: [] };
  }
  if (options.dryRun) {
    return { plan, applied: false, reason: 'dry-run', roomBackups: [] };
  }

  const confirmed = options.confirm ? await options.confirm(plan) : options.yes === true;
  if (!confirmed) return { plan, applied: false, reason: 'declined', roomBackups: [] };

  const target = findSystemMetadata(plan.systemId, plan.targetVersion);
  if (!target) throw new Error(`Версия ${plan.systemId}@${plan.targetVersion} исчезла из реестра.`);
  const module = await loadSystemServer(target.id, target.version);
  if (!module.migrateRoomSheets) throw new Error(`В модуле ${target.id}@${target.version} нет миграции листов.`);

  const catalogBackup = await createCatalogBackup(options.dataDir, 'pre-system-migration');
  logger(`Резервная копия каталога: ${catalogBackup.path}`);

  const operationDir = uniqueOperationDirectory(options.dataDir);
  await mkdir(operationDir, { recursive: true, mode: 0o700 });
  const journal: Record<string, unknown> = {
    version: 1,
    operation: 'system-migration',
    status: 'started',
    startedAt: new Date().toISOString(),
    systemId: plan.systemId,
    targetVersion: plan.targetVersion,
    targetSchemaVersion: plan.targetSchemaVersion,
    catalogBackup: catalogBackup.path,
    plan,
    roomBackups: [],
    rooms: [],
  };
  let journalPath = await writeJournal(operationDir, journal);

  const roomBackups: Array<{ roomId: string; name: string; path: string }> = [];
  const stagedRooms: Array<{ room: SystemMigrationRoomPlan; stagedPath: string; replacedPath: string }> = [];

  try {
    for (const room of plan.rooms.filter((entry) => entry.needsMigration)) {
      logger(`Резервная копия комнаты ${describeRoom(room)}`);
      const backup = await createBackup(
        room.directory,
        room.name,
        'pre-system-migration',
        {
          roomId: room.id,
          systemId: plan.systemId,
          systemVersion: room.currentVersion,
          schemaVersion: plan.targetSchemaVersion,
        },
        { raw: true },
      );
      roomBackups.push({ roomId: room.id, name: backup.name, path: backup.path });
      (journal.roomBackups as unknown[]).push({ roomId: room.id, name: backup.name, path: backup.path });

      const roomOperationDir = join(operationDir, 'rooms', room.id);
      await mkdir(roomOperationDir, { recursive: true, mode: 0o700 });
      const livePath = join(room.directory, 'room.sqlite');
      const originalPath = join(roomOperationDir, 'room.sqlite.original');
      const stagedPath = join(roomOperationDir, 'room.sqlite');
      await copyFile(livePath, originalPath);
      await copyFile(livePath, stagedPath);

      const store = new RoomStore(roomOperationDir, room.name);
      try {
        const report = module.migrateRoomSheets({
          store,
          target: { id: target.id, version: target.version, schemaVersion: target.sheetSchemaVersion },
        });
        logger(`  листы: перенесено ${report.migratedSheetIds.length}, без изменений ${report.unchangedSheetIds.length}`);
        const sheetProblems = module.verifyRoomSheets?.({
          store,
          target: { id: target.id, version: target.version, schemaVersion: target.sheetSchemaVersion },
        }) ?? [];
        if (sheetProblems.length) throw new Error(`Проверка листов не прошла: ${sheetProblems.join('; ')}`);
      } finally {
        store.close();
      }

      const stagedProblems = assertStagedRoom(room.directory, stagedPath, target, module);
      if (stagedProblems.length) throw new Error(`Проверка подготовленной базы не прошла: ${stagedProblems.join('; ')}`);

      if (options.failAfterStagingRoomId === room.id) {
        throw new Error(`Тестовый сбой после подготовки комнаты ${room.id}.`);
      }

      stagedRooms.push({ room, stagedPath, replacedPath: join(roomOperationDir, 'room.sqlite.replaced') });
      (journal.rooms as unknown[]).push({ roomId: room.id, status: 'staged', stagedPath });
      journal.status = 'staged';
      journalPath = await writeJournal(operationDir, journal);
    }

    // Every staged database is valid. Now replace files and update the catalog.
    const catalog = openCatalogForAdmin(options.dataDir);
    const applied: Array<{ room: SystemMigrationRoomPlan; livePath: string; replacedPath: string }> = [];
    const previousPairs = plan.rooms
      .filter((room) => room.needsMigration)
      .map((room) => ({ roomId: room.id, systemId: plan.systemId, systemVersion: room.currentVersion }));
    try {
      for (const staged of stagedRooms) {
        const livePath = join(staged.room.directory, 'room.sqlite');
        await rename(livePath, staged.replacedPath);
        try {
          await rename(staged.stagedPath, livePath);
        } catch (error) {
          await rename(staged.replacedPath, livePath);
          throw error;
        }
        for (const suffix of ['-journal', '-wal', '-shm']) {
          const sidecar = `${livePath}${suffix}`;
          if (existsSync(sidecar)) await rm(sidecar, { force: true });
        }
        applied.push({ room: staged.room, livePath, replacedPath: staged.replacedPath });
      }

      catalog.updateRoomSystems(stagedRooms.map((staged) => ({
        roomId: staged.room.id,
        systemId: target.id,
        systemVersion: target.version,
      })));

      if (options.failAfterApply) throw new Error('Тестовый сбой после применения.');

      // Final read-only verification of the live files and catalog agreement.
      const finalRooms = catalogRowsByRoom(readCatalogRooms(options.dataDir));
      const finalProblems: string[] = [];
      for (const entry of applied) {
        const catalogRoom = finalRooms.get(entry.room.id);
        if (catalogRoom?.systemId !== target.id || catalogRoom.systemVersion !== target.version) {
          finalProblems.push(`${entry.room.id}: каталог не совпадает с целевой версией.`);
        }
        const problems = assertStagedRoom(entry.room.directory, entry.livePath, target, module);
        finalProblems.push(...problems.map((problem) => `${entry.room.id}: ${problem}`));
      }
      if (finalProblems.length) throw new Error(`Итоговая проверка не прошла: ${finalProblems.join('; ')}`);

      journal.status = 'completed';
      journal.completedAt = new Date().toISOString();
      journalPath = await writeJournal(operationDir, journal);
      return {
        plan,
        applied: true,
        catalogBackup: catalogBackup.path,
        operationDir,
        journalPath,
        roomBackups,
      };
    } catch (error) {
      // Catalog changes are one transaction; restore the previous pair if it
      // committed before a later verification failed.
      try { catalog.updateRoomSystems(previousPairs); } catch { /* best-effort */ }
      for (const entry of applied.reverse()) {
        try {
          if (existsSync(entry.livePath)) await rm(entry.livePath, { force: true });
          await rename(entry.replacedPath, entry.livePath);
        } catch { /* keep the original file in the operation directory */ }
      }
      journal.status = 'rolled-back';
      journal.failedAt = new Date().toISOString();
      journal.error = error instanceof Error ? error.message : String(error);
      journalPath = await writeJournal(operationDir, journal);
      throw new Error(
        `Массовая миграция отменена, исходные базы восстановлены. `
        + `Журнал: ${journalPath}. Копия каталога: ${catalogBackup.path}. `
        + `Причина: ${error instanceof Error ? error.message : 'неизвестная ошибка'}`,
      );
    } finally {
      catalog.close();
    }
  } catch (error) {
    if (journal.status !== 'rolled-back' && journal.status !== 'completed') {
      journal.status = 'failed-before-apply';
      journal.failedAt = new Date().toISOString();
      journal.error = error instanceof Error ? error.message : String(error);
      journalPath = await writeJournal(operationDir, journal);
    }
    throw new Error(
      `Массовая миграция не применена; исходные базы не изменены. `
      + `Журнал: ${journalPath}. Копия каталога: ${catalogBackup.path}. `
      + `Причина: ${error instanceof Error ? error.message : 'неизвестная ошибка'}`,
    );
  }
}

function printPlan(plan: SystemMigrationPlan): void {
  console.log(`Система: ${plan.systemName} (${plan.systemId})`);
  console.log(`Целевая версия: ${plan.targetVersion}, схема листа: ${plan.targetSchemaVersion}`);
  console.log(`Найдено комнат ${plan.systemId}: ${plan.rooms.length}`);
  for (const room of plan.rooms) {
    const marker = room.needsMigration ? 'обновить' : 'уже актуальна';
    console.log(`  ${room.id} «${room.name}» [${room.status}] ${room.currentVersion} → ${room.targetVersion} — ${marker}`);
    if (room.sheetCount) console.log(`    листов: ${room.sheetCount}, к миграции: ${room.sheetsToMigrate}`);
    for (const blocker of room.blockers) console.log(`    ОШИБКА: ${blocker}`);
  }
  if (plan.otherSystemRoomIds.length) {
    console.log(`Комнаты других систем не затрагиваются: ${plan.otherSystemRoomIds.join(', ')}`);
  }
  if (plan.requiredMigrations.length) {
    console.log('Необходимые миграции:');
    for (const migration of plan.requiredMigrations) console.log(`  - ${migration}`);
  }
  if (plan.blockers.length) {
    console.log('Блокирующие проблемы:');
    for (const blocker of plan.blockers) console.log(`  - ${blocker}`);
  }
}

async function confirmPlan(plan: SystemMigrationPlan): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const line = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await line.question(
      `Обновить ${plan.rooms.filter((room) => room.needsMigration).length} комнат(ы) ${plan.systemId} до ${plan.targetVersion}? Введите yes: `,
    )).trim();
    return /^yes$/i.test(answer);
  } finally {
    line.close();
  }
}

function printUsage(): void {
  console.log([
    'Массовое обновление системных модулей:',
    '  npm run rooms:migrate-system -- --system nechronica [--dry-run] [--yes] [--to 1.1.0]',
    '',
    'Команда обновляет все комнаты указанной системы (active, disabled, archived)',
    'до последней зарегистрированной версии или до явно указанной --to.',
    'Перед изменениями создаются копия каталога и копии всех затрагиваемых комнат.',
    'Сервер должен быть остановлен; при ошибке исходные базы восстанавливаются.',
    '--dry-run только показывает план и ничего не изменяет.',
    '--yes отключает интерактивное подтверждение.',
  ].join('\n'));
}

function parseArguments(argv: string[]): { systemId?: string; to?: string; dryRun: boolean; yes: boolean; help: boolean } {
  let systemId: string | undefined;
  let to: string | undefined;
  let dryRun = false;
  let yes = false;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (value === '--system') { systemId = argv[++index]; continue; }
    if (value === '--to') { to = argv[++index]; continue; }
    if (value === '--dry-run') { dryRun = true; continue; }
    if (value === '--yes') { yes = true; continue; }
    if (value === '--help' || value === '-h') { help = true; continue; }
    throw new Error(`Неизвестный аргумент: ${value}`);
  }
  return { systemId, to, dryRun, yes, help };
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  if (args.help) { printUsage(); return; }
  if (!args.systemId) throw new Error('Укажите систему: npm run rooms:migrate-system -- --system nechronica');
  const config = loadConfig();
  assertServerStopped(config.dataDir);
  const plan = await planSystemMigration(config.dataDir, args.systemId, args.to);
  printPlan(plan);
  if (plan.blockers.length) {
    throw new Error(`Массовая миграция невозможна:\n- ${plan.blockers.join('\n- ')}`);
  }
  if (!plan.rooms.some((room) => room.needsMigration)) {
    console.log('Обновление не требуется: все комнаты уже используют целевую версию.');
    return;
  }
  if (args.dryRun) {
    console.log('Dry-run: файлы, базы и каталог не изменялись.');
    return;
  }
  if (!args.yes && !await confirmPlan(plan)) {
    console.log('Обновление отменено; изменения не вносились.');
    return;
  }
  const result = await migrateSystem({
    dataDir: config.dataDir,
    systemId: plan.systemId,
    targetVersion: plan.targetVersion,
    yes: true,
    logger: (message) => console.log(message),
  });
  if (result.applied) {
    console.log(`Обновление применено. Журнал: ${result.journalPath}`);
    if (result.catalogBackup) console.log(`Копия каталога: ${result.catalogBackup}`);
    for (const backup of result.roomBackups) console.log(`Копия комнаты ${backup.roomId}: ${backup.path}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(`Ошибка массовой миграции: ${error instanceof Error ? error.message : 'неизвестная ошибка'}`);
    process.exitCode = 1;
  }
}
