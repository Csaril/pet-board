import { createInterface } from 'node:readline/promises';
import { loadConfig } from './config.js';
import { createBackup, listBackups, resolveBackupDirectory, restoreBackup, verifyBackup } from './backup-lib.js';
import { adminRoomDirectory, openCatalogForAdmin } from './room-admin.js';

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function printUsage(): void {
  console.log([
    'Использование:',
    '  npm run backup -- --room <room-id>',
    '  npm run backup:list -- --room <room-id>',
    '  npm run backup:restore -- --room <room-id> <имя> [--yes]',
    '',
    'Комната указывается всегда: резервная копия относится только к ней.',
    'Перед восстановлением остановите сервер. Приложение сначала создаст',
    'дополнительную копию текущего состояния комнаты.',
  ].join('\n'));
}

interface Parsed {
  command: string;
  roomId?: string;
  name?: string;
  yes: boolean;
}

function parse(args: string[]): Parsed {
  const [command = 'create', ...rest] = args;
  let roomId: string | undefined;
  let name: string | undefined;
  let yes = false;
  const positional: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index]!;
    if (value === '--yes') { yes = true; continue; }
    if (value === '--room') { roomId = rest[index + 1]; index += 1; continue; }
    if (value.startsWith('--room=')) { roomId = value.slice('--room='.length); continue; }
    positional.push(value);
  }
  if (positional[0]) name = positional[0];
  return { command, roomId, name, yes };
}

async function confirm(prompt: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const line = createInterface({ input: process.stdin, output: process.stdout });
  try { return /^yes$/i.test((await line.question(`${prompt} Введите yes: `)).trim()); } finally { line.close(); }
}

const parsed = parse(process.argv.slice(2));
const config = loadConfig();

try {
  if (!parsed.roomId) {
    printUsage();
    throw new Error('Укажите комнату через --room <room-id>. Список комнат: npm run rooms:list.');
  }
  const catalog = openCatalogForAdmin(config.dataDir);
  let room;
  try { room = catalog.getRoom(parsed.roomId); } finally { catalog.close(); }
  if (!room) throw new Error(`Комната ${parsed.roomId} не найдена в каталоге.`);
  const roomDir = adminRoomDirectory(config.dataDir, room.id);
  const metadata = { roomId: room.id, systemId: room.systemId, systemVersion: room.systemVersion, schemaVersion: 1 };

  if (parsed.command === 'create') {
    const backup = await createBackup(roomDir, room.name, 'backup', metadata);
    console.log(`Резервная копия комнаты ${room.id} создана: ${backup.path}`);
    console.log(`Изображений: ${backup.assetCount}; база: ${formatSize(backup.databaseBytes)}.`);
  } else if (parsed.command === 'list') {
    const backups = await listBackups(roomDir);
    if (backups.length === 0) {
      console.log('Резервных копий пока нет.');
    } else {
      console.log(`Доступные резервные копии комнаты ${room.id} (${roomDir}/backups):`);
      for (const backup of backups) {
        const created = backup.createdAt.replace('T', ' ').replace(/\..+$/, ' UTC');
        const format = backup.version >= 2 ? `v${backup.version}` : 'v1';
        console.log(`  ${backup.name}  ${created}  ${format}  изображений: ${backup.assetCount}  база: ${formatSize(backup.databaseBytes)}`);
      }
    }
  } else if (parsed.command === 'restore') {
    if (!parsed.name) {
      printUsage();
      process.exitCode = 1;
    } else {
      const backupPath = resolveBackupDirectory(roomDir, parsed.name);
      const verified = await verifyBackup(backupPath);
      if (verified.roomId && verified.roomId !== room.id) throw new Error(`Копия принадлежит комнате ${verified.roomId}, а не ${room.id}.`);
      if (verified.systemId && (verified.systemId !== room.systemId || verified.systemVersion !== room.systemVersion)) {
        throw new Error('Системная принадлежность копии не совпадает с целевой комнатой.');
      }
      let confirmed = parsed.yes;
      if (!confirmed) {
        confirmed = await confirm(`Восстановить «${parsed.name}» (изображений: ${verified.assetCount})? Текущая комната будет заменена.`);
      }
      if (!confirmed) {
        console.log('Восстановление отменено.');
      } else {
        const result = await restoreBackup(roomDir, room.name, parsed.name, {
          roomId: room.id,
          systemId: room.systemId,
          systemVersion: room.systemVersion,
        });
        console.log(`Комната ${room.id} восстановлена из «${parsed.name}».`);
        console.log(`Копия прежнего состояния сохранена как «${result.safetyBackup}».`);
      }
    }
  } else {
    printUsage();
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`Ошибка резервного копирования: ${error instanceof Error ? error.message : 'неизвестная ошибка'}`);
  process.exitCode = 1;
}
