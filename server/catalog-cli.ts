import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import {
  createCatalogBackup,
  createInstallBackup,
  listCatalogBackups,
  resolveCatalogBackup,
  restoreCatalogBackup,
  verifyCatalogBackup,
  verifyInstallBackup,
} from './catalog-backup.js';

async function confirm(prompt: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const line = createInterface({ input: process.stdin, output: process.stdout });
  try { return /^yes$/i.test((await line.question(`${prompt} Введите yes: `)).trim()); } finally { line.close(); }
}

async function main(): Promise<void> {
  const [command = 'help', name, ...flags] = process.argv.slice(2);
  const config = loadConfig();
  if (command === 'backup') {
    const result = await createCatalogBackup(config.dataDir);
    console.log(`Копия каталога создана: ${result.path}`);
    console.log('Каталог и server-secret сохранены вместе.');
    return;
  }
  if (command === 'list') {
    const copies = await listCatalogBackups(config.dataDir, 'catalog');
    if (!copies.length) { console.log('Копий каталога пока нет.'); return; }
    for (const copy of copies) console.log(`  ${copy.name}  ${copy.createdAt}`);
    return;
  }
  if (command === 'restore') {
    if (!name) throw new Error('Укажите имя копии каталога.');
    const path = resolveCatalogBackup(config.dataDir, 'catalog', name);
    const verified = await verifyCatalogBackup(path);
    if (!flags.includes('--yes') && !await confirm(`Восстановить каталог «${name}» (комнат: ${verified.rooms})? Сервер должен быть остановлен.`)) {
      console.log('Восстановление каталога отменено.');
      return;
    }
    const result = await restoreCatalogBackup(config.dataDir, name);
    console.log(`Каталог и server-secret восстановлены из «${name}».`);
    console.log(`Копия прежнего состояния: ${result.safety}.`);
    return;
  }
  if (command === 'install') {
    const result = await createInstallBackup(config.dataDir);
    const verified = await verifyInstallBackup(result.path);
    console.log(`Полная копия установки создана: ${result.path}`);
    console.log(`Комнат: ${verified.rooms}; файлов: ${verified.files}.`);
    return;
  }
  if (command === 'install-list') {
    const copies = await listCatalogBackups(config.dataDir, 'install');
    if (!copies.length) { console.log('Полных копий установки пока нет.'); return; }
    for (const copy of copies) console.log(`  ${copy.name}  ${copy.createdAt}`);
    return;
  }
  if (command === 'verify-install') {
    if (!name) throw new Error('Укажите имя полной копии установки.');
    const path = resolveCatalogBackup(config.dataDir, 'install', name);
    const verified = await verifyInstallBackup(path);
    console.log(`Полная копия корректна: комнат ${verified.rooms}, файлов ${verified.files}.`);
    return;
  }
  console.log([
    'Резервное копирование каталога:',
    '  npm run catalog:backup',
    '  npm run catalog:list',
    '  npm run catalog:restore -- <имя> [--yes]',
    '  npm run install:backup',
    '  npm run install:list',
    '  npm run install:verify -- <имя>',
    '',
    'Восстанавливайте каталог только при остановленном сервере.',
  ].join('\n'));
  if (command !== 'help') process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { await main(); }
  catch (error) { console.error(`Ошибка резервного копирования каталога: ${error instanceof Error ? error.message : 'неизвестная ошибка'}`); process.exitCode = 1; }
}
