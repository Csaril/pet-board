import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { RoomAdminError, archiveRoom, createRoom, deleteRoom, initializeDefaultRoom, openCatalogForAdmin, setRoomStatus } from './room-admin.js';
import { statusLabel } from './room-manager.js';

interface ParsedArguments {
  command: string;
  positional: string[];
  flags: Map<string, string | true>;
}

function parseArguments(argv: string[]): ParsedArguments {
  const [command = 'help', ...rest] = argv;
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index]!;
    if (value.startsWith('--')) {
      const key = value.slice(2);
      const next = rest[index + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags.set(key, next);
        index += 1;
      } else {
        flags.set(key, true);
      }
    } else {
      positional.push(value);
    }
  }
  return { command, positional, flags };
}

function stringFlag(flags: Map<string, string | true>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === 'string' ? value : undefined;
}

async function readSecret(label: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of stdin) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf8').split(/\r?\n/)[0] ?? '';
  }
  process.stdout.write(label);
  return new Promise((resolve, reject) => {
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const cleanup = (): void => {
      stdin.off('data', onData);
      stdin.setRawMode(Boolean(wasRaw));
      stdin.pause();
    };
    const finish = (): void => {
      cleanup();
      process.stdout.write('\n');
      resolve(value);
    };
    const onData = (chunk: string): void => {
      for (const character of chunk) {
        if (character === '\r' || character === '\n') { finish(); return; }
        if (character === '\u0003') {
          cleanup();
          process.stdout.write('\n');
          reject(new RoomAdminError('Ввод пароля отменён.'));
          return;
        }
        if (character === '\u007f' || character === '\b') { value = value.slice(0, -1); continue; }
        if (character >= ' ') value += character;
      }
    };
    stdin.on('data', onData);
  });
}

async function confirm(prompt: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const line = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^yes$/i.test((await line.question(`${prompt} Введите yes: `)).trim());
  } finally {
    line.close();
  }
}

/** Destructive action: the exact room id must be typed unless --yes is used. */
async function confirmDeletion(roomId: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const line = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await line.question(`Удалить комнату ${roomId} безвозвратно? Введите ID комнаты: `)).trim();
    return answer === roomId;
  } finally {
    line.close();
  }
}

function printUsage(): void {
  console.log([
    'Управление игровыми комнатами:',
    '  npm run rooms:init',
    '  npm run rooms:create -- --name "Название" --system pbta-2d6|nechronica',
    '  npm run rooms:list',
    '  npm run rooms:disable -- <room-id>',
    '  npm run rooms:enable -- <room-id>',
    '  npm run rooms:archive -- <room-id>',
    '  npm run rooms:delete -- <room-id> [--force] [--yes] [--no-backup]',
    '',
    'Пароль ведущего вводится скрыто в терминале. При запуске без TTY',
    'передайте его одной строкой в stdin.',
    'Код комнаты показывается только один раз при создании.',
    'Удаление активной или отключённой комнаты требует --force; финальная',
    'копия по умолчанию сохраняется в data/deleted-rooms/.',
  ].join('\n'));
}

async function main(): Promise<void> {
  const { command, positional, flags } = parseArguments(process.argv.slice(2));
  const config = loadConfig();
  if (command === 'help' || command === '--help' || command === '-h') { printUsage(); return; }

  if (command === 'init') {
    const result = await initializeDefaultRoom({
      dataDir: config.dataDir,
      roomName: config.roomName,
      roomCode: config.roomCode,
      gmPassword: config.gmPassword,
    });
    if (result.created) {
      console.log(`Комната default зарегистрирована в каталоге: «${result.room.name}», система ${result.room.systemId}@${result.room.systemVersion}.`);
      console.log('Старые ROOM_CODE и GM_PASSWORD перенесены в защищённое хранилище. Секреты не выводятся.');
    } else {
      console.log(`Каталог уже инициализирован; комната default (${result.room.systemId}@${result.room.systemVersion}) не изменена.`);
    }
    return;
  }

  if (command === 'create') {
    const name = stringFlag(flags, 'name');
    const systemId = stringFlag(flags, 'system');
    if (!name || !systemId) throw new RoomAdminError('Укажите --name и --system.');
    const password = await readSecret('Пароль ведущего (не отображается): ');
    if (!password) throw new RoomAdminError('Пароль ведущего не введён.');
    const result = await createRoom({ dataDir: config.dataDir, name, systemId, gmPassword: password });
    console.log('Комната создана.');
    console.log(`  Название: ${result.room.name}`);
    console.log(`  ID: ${result.room.id}`);
    console.log(`  Система: ${result.room.systemId}@${result.room.systemVersion}`);
    console.log(`  Код подключения: ${result.code}`);
    console.log(`  Статус: ${statusLabel(result.room.status)}`);
    console.log('Сохраните код: повторно он не показывается.');
    return;
  }

  if (command === 'list') {
    const catalog = openCatalogForAdmin(config.dataDir);
    try {
      const rooms = catalog.listRooms();
      if (rooms.length === 0) {
        console.log('В каталоге нет комнат. Выполните npm run rooms:init или npm run rooms:create.');
        return;
      }
      console.log('ID                                    Название                          Система                    Статус        Создана');
      for (const room of rooms) {
        const system = `${room.systemId ?? '—'}@${room.systemVersion ?? '—'}`;
        console.log(`${room.id.padEnd(37)} ${room.name.slice(0, 32).padEnd(32)} ${system.padEnd(26)} ${statusLabel(room.status).padEnd(13)} ${room.createdAt}`);
      }
    } finally {
      catalog.close();
    }
    return;
  }

  if (command === 'delete') {
    const roomId = positional[0];
    if (!roomId) throw new RoomAdminError('Укажите ID комнаты: npm run rooms:delete -- <room-id>');
    const catalog = openCatalogForAdmin(config.dataDir);
    let room;
    try { room = catalog.getRoom(roomId); } finally { catalog.close(); }
    if (!room) throw new RoomAdminError(`Комната ${roomId} не найдена.`);
    const force = flags.has('force');
    if (room.status !== 'archived' && !force) {
      throw new RoomAdminError(
        `Комната ${room.id} не архивирована. Сначала выполните npm run rooms:archive -- ${room.id} или добавьте --force.`,
      );
    }
    const keepBackup = !flags.has('no-backup');
    let confirmed = flags.has('yes');
    if (!confirmed) confirmed = await confirmDeletion(room.id);
    if (!confirmed) {
      console.log('Удаление отменено.');
      return;
    }
    const result = await deleteRoom({ dataDir: config.dataDir, roomId: room.id, force, keepBackup });
    console.log(`Комната ${result.room.id} удалена из каталога.`);
    console.log(`  Название: ${result.room.name}`);
    if (result.preservedBackup) console.log(`  Финальная копия: ${result.preservedBackup}`);
    else if (!keepBackup) console.log('  Финальная копия не создавалась (--no-backup).');
    if (result.preservedRoot) console.log(`  Сохранённые копии: ${result.preservedRoot}`);
    if (result.leftoverDirectory) console.log(`  Каталог не удалён полностью: ${result.leftoverDirectory}`);
    return;
  }

  if (command === 'disable' || command === 'enable' || command === 'archive') {
    const roomId = positional[0];
    if (!roomId) throw new RoomAdminError(`Укажите ID комнаты: npm run rooms:${command} -- <room-id>`);
    if (command === 'archive') {
      if (!flags.has('yes') && !await confirm(`Архивировать комнату ${roomId}? Сначала будет создана резервная копия.`)) {
        console.log('Архивирование отменено.');
        return;
      }
      const result = await archiveRoom(config.dataDir, roomId);
      console.log(`Комната ${roomId} архивирована. Финальная копия: ${result.backup}.`);
      return;
    }
    const catalog = openCatalogForAdmin(config.dataDir);
    let current;
    try { current = catalog.getRoom(roomId); } finally { catalog.close(); }
    if (!current) throw new RoomAdminError(`Комната ${roomId} не найдена.`);
    if (command === 'enable' && current.status === 'archived') {
      throw new RoomAdminError('Архивированную комнату нельзя включить. Восстановите её копию в новую комнату.');
    }
    if (command === 'disable' && current.status === 'archived') {
      throw new RoomAdminError('Комната уже архивирована.');
    }
    const room = setRoomStatus(config.dataDir, roomId, command === 'enable' ? 'active' : 'disabled');
    console.log(`Комната ${room.id} теперь ${statusLabel(room.status)}.`);
    return;
  }

  printUsage();
  process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(`Ошибка управления комнатами: ${error instanceof Error ? error.message : 'неизвестная ошибка'}`);
    process.exitCode = 1;
  }
}
