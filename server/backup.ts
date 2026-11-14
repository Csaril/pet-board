import { createInterface } from 'node:readline/promises';
import { loadConfig } from './config.js';
import { createBackup, listBackups, resolveBackupDirectory, restoreBackup, verifyBackup } from './backup-lib.js';
import { resolveRoomDirectory } from './room-storage.js';

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function printUsage(): void {
  console.log([
    'Использование:',
    '  npm run backup                         — создать резервную копию',
    '  npm run backup:list                    — показать доступные копии',
    '  npm run backup:restore -- <имя> [--yes] — восстановить копию',
    '',
    'Перед восстановлением остановите сервер. Приложение сначала создаст',
    'дополнительную копию текущего состояния в каталоге комнаты.',
  ].join('\n'));
}

const [command = 'create', name, ...flags] = process.argv.slice(2);
const config = loadConfig();
const roomDir = resolveRoomDirectory(config.dataDir);

try {
  if (command === 'create') {
    const backup = await createBackup(roomDir, config.roomName);
    console.log(`Резервная копия создана: ${backup.path}`);
    console.log(`Изображений: ${backup.assetCount}; база: ${formatSize(backup.databaseBytes)}.`);
  } else if (command === 'list') {
    const backups = await listBackups(roomDir);
    if (backups.length === 0) {
      console.log('Резервных копий пока нет.');
    } else {
      console.log(`Доступные резервные копии (${roomDir}/backups):`);
      for (const backup of backups) {
        const created = backup.createdAt.replace('T', ' ').replace(/\..+$/, ' UTC');
        console.log(`  ${backup.name}  ${created}  изображений: ${backup.assetCount}  база: ${formatSize(backup.databaseBytes)}`);
      }
    }
  } else if (command === 'restore') {
    if (!name) {
      printUsage();
      process.exitCode = 1;
    } else {
      const backupPath = resolveBackupDirectory(roomDir, name);
      const verified = await verifyBackup(backupPath);
      const skipConfirmation = flags.includes('--yes');
      let confirmed = skipConfirmation;
      if (!confirmed) {
        if (!process.stdin.isTTY) {
          throw new Error('Подтверждение недоступно без терминала. Добавьте --yes, если действительно хотите восстановить копию.');
        }
        const prompt = createInterface({ input: process.stdin, output: process.stdout });
        try {
          const answer = await prompt.question(
            `Восстановить «${name}» (изображений: ${verified.assetCount})? Текущая комната будет заменена. Введите yes: `,
          );
          confirmed = /^yes$/i.test(answer.trim());
        } finally {
          prompt.close();
        }
      }
      if (!confirmed) {
        console.log('Восстановление отменено.');
      } else {
        const result = await restoreBackup(roomDir, config.roomName, name);
        console.log(`Комната восстановлена из «${name}».`);
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
