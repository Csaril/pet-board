import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { createReadStream, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomInt, randomUUID } from 'node:crypto';
import type WebSocket from 'ws';
import type { NoteAccess } from '../src/shared/board.js';
import { authenticate, SESSION_COOKIE, sessionDigest } from './auth.js';
import { executeBoardCommand, BoardCommandError } from './board.js';
import { loadConfig, type AppConfig } from './config.js';
import { saveImageAsset, UnsupportedImageError } from './assets.js';
import { RoomStore, type Identity } from './store.js';
import type { DiceRollEntry } from '../src/shared/board.js';
import { systemModuleRegistry } from '../src/modules/registry.js';
import { pbtaSheetSchema, pbtaSystemModule } from '../src/modules/system/pbta-2d6/module.js';
import { calculatePbtARoll, rollFreeDice, type SituationalModifier } from '../src/modules/system/pbta-2d6/roll.js';
import { executeSheetCommand } from './sheets.js';

const COOKIE_PATH = '/';

function parseNotePayload(input: unknown, store: RoomStore): { title: string; body: string; access: NoteAccess; selectedParticipantIds: string[]; assetIds: string[]; markerType: 'text' | 'image'; markerText: string; markerAssetId?: string } | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const body = input as Record<string, unknown>;
  if (Object.keys(body).some((key) => !['title', 'body', 'access', 'selectedParticipantIds', 'assetIds', 'markerType', 'markerText', 'markerAssetId'].includes(key))) return undefined;
  if (typeof body.title !== 'string' || !body.title.trim() || body.title.trim().length > 120) return undefined;
  if (typeof body.body !== 'string' || body.body.length > 20_000) return undefined;
  if (body.access !== 'gm-only' && body.access !== 'all-players' && body.access !== 'selected-players') return undefined;
  if (!Array.isArray(body.selectedParticipantIds) || body.selectedParticipantIds.length > 6 || body.selectedParticipantIds.some((id) => typeof id !== 'string' || !/^[0-9a-f]{64}$/i.test(id))) return undefined;
  const selectedParticipantIds = [...new Set(body.selectedParticipantIds as string[])];
  if (selectedParticipantIds.length !== body.selectedParticipantIds.length) return undefined;
  if (body.access === 'selected-players' && (!selectedParticipantIds.length || selectedParticipantIds.some((id) => !store.isPlayerParticipant(id)))) return undefined;
  if (body.access !== 'selected-players' && selectedParticipantIds.length) return undefined;
  if (!Array.isArray(body.assetIds) || body.assetIds.length > 20 || body.assetIds.some((id) => typeof id !== 'string' || !store.getAsset(id))) return undefined;
  const assetIds = [...new Set(body.assetIds as string[])];
  if (assetIds.length !== body.assetIds.length) return undefined;
  const markerType = body.markerType === undefined ? 'text' : body.markerType;
  if (markerType !== 'text' && markerType !== 'image') return undefined;
  const markerText = body.markerText === undefined ? '' : body.markerText;
  if (typeof markerText !== 'string' || markerText.length > 60) return undefined;
  if (body.markerAssetId !== undefined && typeof body.markerAssetId !== 'string') return undefined;
  const markerAssetId = typeof body.markerAssetId === 'string' && body.markerAssetId ? body.markerAssetId : undefined;
  if (markerType === 'image' && (!markerAssetId || !store.getAsset(markerAssetId))) return undefined;
  if (markerType === 'text' && markerAssetId !== undefined) return undefined;
  return { title: body.title.trim(), body: body.body, access: body.access, selectedParticipantIds, assetIds, markerType, markerText: markerText.trim(), ...(markerAssetId ? { markerAssetId } : {}) };
}

function isSameOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (!origin || !host) return false;
  try {
    const parsed = new URL(origin);
    const requestHost = new URL(`${parsed.protocol}//${host}`);
    const defaultPort = parsed.protocol === 'https:' ? '443' : '80';
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
      !requestHost.username && !requestHost.password &&
      parsed.hostname.toLowerCase() === requestHost.hostname.toLowerCase() &&
      (parsed.port || defaultPort) === (requestHost.port || defaultPort);
  } catch { return false; }
}

export async function buildServer(options?: { config?: AppConfig; store?: RoomStore; logger?: boolean; randomInt?: (min: number, max: number) => number }): Promise<FastifyInstance> {
  const config = options?.config ?? loadConfig();
  const store = options?.store ?? new RoomStore(config.dataDir, config.roomName);
  const app = Fastify({ logger: options?.logger ?? true, bodyLimit: config.maxUploadBytes + 1024 * 1024 });
  const sockets = new Map<string, Set<WebSocket>>();
  const secureRandomInt = options?.randomInt ?? randomInt;
  const distDir = resolve(process.cwd(), 'dist');
  mkdirSync(distDir, { recursive: true });

  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  await app.register(websocket, { options: { maxPayload: 16 * 1024 } });
  await app.register(multipart, { limits: { fileSize: config.maxUploadBytes, files: 1, fields: 0 } });
  await app.register(fastifyStatic, { root: distDir, prefix: '/', wildcard: false });

  const sessionFor = (raw: string | undefined): { sessionId: string; identity: Identity } | undefined => {
    if (!raw || raw.length > 100) return undefined;
    const sessionId = sessionDigest(raw);
    const identity = store.getSession(sessionId);
    return identity ? { sessionId, identity } : undefined;
  };
  const cookieOptions = { path: COOKIE_PATH, httpOnly: true, sameSite: 'strict' as const, secure: config.cookieSecure };
  const sendState = (): void => {
    const participants = [...sockets.keys()].flatMap((sessionId) => {
      const identity = store.getSession(sessionId);
      return identity ? [identity] : [];
    });
    for (const [sessionId, connections] of sockets) {
      const identity = store.getSession(sessionId);
      if (!identity) continue;
      const snapshot = store.snapshot(identity);
      const payload = JSON.stringify({ type: 'room:state', roomName: store.roomName, identity, participants, maxUploadBytes: config.maxUploadBytes, ...snapshot });
      for (const socket of connections) if (socket.readyState === 1) socket.send(payload);
    }
  };

  const createDiceRoll = (identity: Identity, command: Record<string, unknown>): DiceRollEntry => {
    if (command.type === 'dice:free') {
      if (Object.keys(command).some((key) => !['type', 'requestId', 'count', 'sides'].includes(key))) throw new BoardCommandError('Некорректная команда броска.');
      const count = command.count;
      const sides = command.sides;
      if (!Number.isInteger(count) || !Number.isInteger(sides)) throw new BoardCommandError('Укажите количество кубиков и граней.');
      let result: ReturnType<typeof rollFreeDice>;
      try { result = rollFreeDice(count as number, sides as number, secureRandomInt); }
      catch (error) { throw new BoardCommandError(error instanceof Error ? error.message : 'Некорректный бросок.'); }
      return {
        id: randomUUID(), authorId: identity.participantId, authorName: identity.name, actorId: identity.participantId, actorName: identity.name,
        createdAt: new Date().toISOString(), kind: 'free', dice: result.dice, keptDice: result.dice, discardedDie: null,
        characteristicName: null, characterId: null, characterOwnerId: null, characteristicBonus: null, situationalModifier: 0, disadvantage: false,
        sides: sides as number, total: result.total, category: null, critical: null, rerollOf: null,
      };
    }

    let original: DiceRollEntry | undefined;
    if (command.type === 'dice:reroll') {
      if (Object.keys(command).some((key) => !['type', 'requestId', 'rollId'].includes(key)) || typeof command.rollId !== 'string') throw new BoardCommandError('Некорректная команда повторного броска.');
      original = store.getDiceRolls().find((roll) => roll.id === command.rollId);
      if (!original || original.kind !== 'pbta' || original.actorId !== identity.participantId && identity.role !== 'gm') throw new BoardCommandError('Этот бросок нельзя повторить.');
    } else if (command.type !== 'dice:pbta') throw new BoardCommandError('Неизвестная команда броска.');

    const bonus = original?.characteristicBonus ?? command.characteristicBonus;
    const modifier = original?.situationalModifier ?? command.situationalModifier;
    const disadvantage = original?.disadvantage ?? command.disadvantage;
    const characteristicName = original?.characteristicName ?? (typeof command.characteristicName === 'string' ? command.characteristicName.trim().slice(0, 80) || null : null);
    const characterId = original?.characterId ?? (typeof command.characterId === 'string' ? command.characterId : null);
    const characterOwnerId = original?.characterOwnerId ?? (typeof command.characterOwnerId === 'string' ? command.characterOwnerId : null);
    if (original && Object.keys(command).some((key) => !['type', 'requestId', 'rollId'].includes(key))) throw new BoardCommandError('Повторный бросок сохраняет условия исходного.');
    if (!Number.isSafeInteger(bonus) || typeof bonus !== 'number' || Math.abs(bonus) > 1000) throw new BoardCommandError('Некорректный бонус характеристики.');
    if (modifier !== -1 && modifier !== 0 && modifier !== 1) throw new BoardCommandError('Некорректный ситуационный модификатор.');
    if (typeof disadvantage !== 'boolean') throw new BoardCommandError('Некорректное состояние Помехи.');
    if (command.characteristicName !== undefined && (typeof command.characteristicName !== 'string' || command.characteristicName.length > 80)) throw new BoardCommandError('Некорректное название характеристики.');
    if (!original && Object.keys(command).some((key) => !['type', 'requestId', 'characteristicBonus', 'situationalModifier', 'disadvantage', 'characteristicName', 'characterId', 'characterOwnerId', 'actorId'].includes(key))) throw new BoardCommandError('Некорректная команда броска.');
    if ((command.characterId !== undefined && (typeof command.characterId !== 'string' || !command.characterId || command.characterId.length > 128)) ||
        (command.characterOwnerId !== undefined && (typeof command.characterOwnerId !== 'string' || command.characterOwnerId.length > 128))) throw new BoardCommandError('Некорректная ссылка на персонажа.');
    if ((characterId === null) !== (characterOwnerId === null)) throw new BoardCommandError('Нужны и ID персонажа, и ID владельца.');
    const activeSystem = store.activeSystem;
    if (!activeSystem || activeSystem.id !== 'pbta-2d6' || systemModuleRegistry.get(activeSystem.id)?.version !== activeSystem.version) throw new BoardCommandError('В комнате не выбрана доступная система PbtA.');
    let actor: Identity;
    if (original) {
      actor = { participantId: original.actorId, name: original.actorName, role: 'player' };
    } else if (identity.role === 'gm') {
      if (typeof command.actorId !== 'string' || !store.isPlayerParticipant(command.actorId)) throw new BoardCommandError('Выберите игрока, за которого выполняется бросок.');
      actor = store.getSession(command.actorId)!;
    } else {
      if (command.actorId !== undefined && command.actorId !== identity.participantId) throw new BoardCommandError('Игрок может совершать бросок только за себя.');
      actor = identity;
    }
    if (characterOwnerId && characterOwnerId !== actor.participantId) throw new BoardCommandError('Владелец характеристики не совпадает с участником броска.');
    if (original && identity.role !== 'gm' && original.authorId !== identity.participantId) throw new BoardCommandError('Повторный бросок может выполнить его автор.');
    if (!original && characterId && characterOwnerId) {
      const sheet = store.getSheet(characterId);
      if (sheet) {
        if (sheet.systemId !== pbtaSystemModule.id) throw new BoardCommandError('Лист не относится к активной системе PbtA.');
        if (!sheet.assignedPlayerId || sheet.assignedPlayerId !== characterOwnerId || sheet.assignedPlayerId !== actor.participantId) {
          throw new BoardCommandError('Лист персонажа не назначен участнику броска.');
        }
        const characteristic = pbtaSheetSchema.characteristics.find((entry) => entry.name === characteristicName);
        if (!characteristic || sheet.characteristics[characteristic.key] !== bonus) {
          throw new BoardCommandError('Бонус не совпадает со значением характеристики в листе персонажа.');
        }
      }
    }
    const result = calculatePbtARoll({ characteristicBonus: bonus as number, situationalModifier: modifier as SituationalModifier, disadvantage }, secureRandomInt);
    return {
      id: randomUUID(), authorId: identity.participantId, authorName: identity.name, actorId: actor.participantId, actorName: actor.name,
      createdAt: new Date().toISOString(), kind: 'pbta', ...result, characteristicName, characterId, characterOwnerId,
      sides: 6, disadvantage, rerollOf: original?.id ?? null,
    };
  };

  app.get('/api/board', async (request, reply) => {
    const session = sessionFor(request.cookies[SESSION_COOKIE]);
    if (!session) return reply.code(401).send({ error: 'Сессия не найдена.' });
    reply.header('Cache-Control', 'no-store');
    return { ...store.snapshot(session.identity), maxUploadBytes: config.maxUploadBytes };
  });

  app.get('/api/sheets', async (request, reply) => {
    const session = sessionFor(request.cookies[SESSION_COOKIE]);
    if (!session) return reply.code(401).send({ error: 'Сессия не найдена.' });
    reply.header('Cache-Control', 'no-store');
    return { sheets: store.getSheetsFor(session.identity) };
  });

  app.get('/api/sheets/:id', async (request, reply) => {
    const session = sessionFor(request.cookies[SESSION_COOKIE]);
    if (!session) return reply.code(401).send({ error: 'Сессия не найдена.' });
    const { id } = request.params as { id: string };
    const sheet = store.getSheetFor(id, session.identity);
    if (!sheet) return reply.code(404).send({ error: 'Лист персонажа не найден.' });
    reply.header('Cache-Control', 'no-store');
    return { sheet };
  });

  app.get('/api/notes', async (request, reply) => {
    const session = sessionFor(request.cookies[SESSION_COOKIE]);
    if (!session) return reply.code(401).send({ error: 'Сессия не найдена.' });
    if (session.identity.role !== 'gm') return reply.code(403).send({ error: 'Список заметок доступен только ведущему.' });
    reply.header('Cache-Control', 'no-store');
    return { notes: store.listNotes() };
  });

  app.post('/api/notes', async (request, reply) => {
    if (!isSameOrigin(request.headers.origin, request.headers.host)) return reply.code(403).send({ error: 'Origin not allowed.' });
    const session = sessionFor(request.cookies[SESSION_COOKIE]);
    if (!session) return reply.code(401).send({ error: 'Сессия не найдена.' });
    if (session.identity.role !== 'gm') return reply.code(403).send({ error: 'Заметки может создавать только ведущий.' });
    const input = parseNotePayload(request.body, store);
    if (!input) return reply.code(400).send({ error: 'Проверьте заголовок, текст, доступ, участников и изображения заметки.' });
    const id = randomUUID();
    store.createNote({ id, ...input, creatorId: session.identity.participantId });
    reply.header('Cache-Control', 'no-store');
    sendState();
    return { note: store.getNote(id) };
  });

  app.get('/api/notes/:id', async (request, reply) => {
    const session = sessionFor(request.cookies[SESSION_COOKIE]);
    if (!session) return reply.code(401).send({ error: 'Сессия не найдена.' });
    const { id } = request.params as { id: string };
    if (!store.canReadNote(id, session.identity)) return reply.code(404).send({ error: 'Заметка не найдена.' });
    reply.header('Cache-Control', 'no-store');
    return { note: store.getNote(id) };
  });

  app.put('/api/notes/:id', async (request, reply) => {
    if (!isSameOrigin(request.headers.origin, request.headers.host)) return reply.code(403).send({ error: 'Origin not allowed.' });
    const session = sessionFor(request.cookies[SESSION_COOKIE]);
    if (!session) return reply.code(401).send({ error: 'Сессия не найдена.' });
    if (session.identity.role !== 'gm') return reply.code(403).send({ error: 'Заметки может редактировать только ведущий.' });
    const { id } = request.params as { id: string };
    if (!store.getNote(id)) return reply.code(404).send({ error: 'Заметка не найдена.' });
    const input = parseNotePayload(request.body, store);
    if (!input) return reply.code(400).send({ error: 'Проверьте заголовок, текст, доступ, участников и изображения заметки.' });
    store.updateNote(id, input);
    reply.header('Cache-Control', 'no-store');
    sendState();
    return { note: store.getNote(id) };
  });

  app.delete('/api/notes/:id', async (request, reply) => {
    if (!isSameOrigin(request.headers.origin, request.headers.host)) return reply.code(403).send({ error: 'Origin not allowed.' });
    const session = sessionFor(request.cookies[SESSION_COOKIE]);
    if (!session) return reply.code(401).send({ error: 'Сессия не найдена.' });
    if (session.identity.role !== 'gm') return reply.code(403).send({ error: 'Удалять заметки может только ведущий.' });
    const { id } = request.params as { id: string };
    if (!store.getNote(id)) return reply.code(404).send({ error: 'Заметка не найдена.' });
    store.deleteNote(id);
    sendState();
    return reply.code(204).send();
  });

  app.post('/api/session', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    if (!isSameOrigin(request.headers.origin, request.headers.host)) {
      return reply.code(403).send({ error: 'Origin not allowed.' });
    }
    const result = authenticate(request.body, config, store);
    if (!result) return reply.code(401).send({ error: 'Неверный код комнаты или пароль, либо ведущий уже подключён.' });
    reply.setCookie(SESSION_COOKIE, result.sessionId, {
      ...cookieOptions,
      expires: new Date(Date.now() + config.sessionDays * 24 * 60 * 60 * 1000),
    });
    sendState();
    return { identity: result.identity };
  });

  app.get('/api/session', async (request, reply) => {
    const session = sessionFor(request.cookies[SESSION_COOKIE]);
    if (!session) return reply.code(401).send({ error: 'Сессия не найдена.' });
    return { identity: session.identity };
  });

  app.delete('/api/session', async (request, reply) => {
    if (!isSameOrigin(request.headers.origin, request.headers.host)) {
      return reply.code(403).send({ error: 'Origin not allowed.' });
    }
    const session = sessionFor(request.cookies[SESSION_COOKIE]);
    if (session) {
      sockets.get(session.sessionId)?.forEach((socket) => {
        if (socket.readyState === 1) {
          socket.send(JSON.stringify({ type: 'session:ended' }));
          socket.close();
        }
      });
      store.deleteSession(session.sessionId);
      sockets.delete(session.sessionId);
    }
    reply.clearCookie(SESSION_COOKIE, cookieOptions);
    sendState();
    return reply.code(204).send();
  });

  app.post('/api/assets', {
    config: { rateLimit: { max: 12, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    if (!isSameOrigin(request.headers.origin, request.headers.host)) return reply.code(403).send({ error: 'Origin not allowed.' });
    const session = sessionFor(request.cookies[SESSION_COOKIE]);
    if (!session) return reply.code(401).send({ error: 'Сессия не найдена.' });
    try {
      const file = await request.file({ limits: { fileSize: config.maxUploadBytes, files: 1, fields: 0 } });
      if (!file || file.fieldname !== 'image') return reply.code(400).send({ error: 'Выберите файл изображения.' });
      const bytes = await file.toBuffer();
      if (file.file.truncated) return reply.code(413).send({ error: 'Файл превышает установленный лимит.' });
      const result = await saveImageAsset(store, config.dataDir, bytes, file.mimetype, file.filename, config.maxUploadBytes, session.identity.participantId);
      sendState();
      return { asset: result.asset, deduplicated: result.deduplicated };
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'FST_REQ_FILE_TOO_LARGE') return reply.code(413).send({ error: `Максимальный размер файла: ${Math.round(config.maxUploadBytes / 1024 / 1024)} MB.` });
      if (error instanceof UnsupportedImageError) return reply.code(415).send({ error: error.message });
      throw error;
    }
  });

  app.get('/api/assets/:id', async (request, reply) => {
    const session = sessionFor(request.cookies[SESSION_COOKIE]);
    if (!session) return reply.code(401).send({ error: 'Сессия не найдена.' });
    const { id } = request.params as { id: string };
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
      return reply.code(404).send({ error: 'Изображение не найдено.' });
    }
    const asset = store.getAsset(id);
    if (!asset || !store.canReadAsset(id, session.identity)) {
      return reply.code(404).send({ error: 'Изображение не найдено.' });
    }
    reply.type(asset.mimeType).header('Cache-Control', 'private, no-store').header('X-Content-Type-Options', 'nosniff');
    return reply.send(createReadStream(join(config.dataDir, 'assets', id)));
  });

  app.get('/ws', { websocket: true }, (socket, request) => {
    if (!isSameOrigin(request.headers.origin, request.headers.host)) {
      socket.close(1008, 'Origin not allowed');
      return;
    }
    const session = sessionFor(request.cookies[SESSION_COOKIE]);
    if (!session) {
      socket.close(1008, 'Authentication required');
      return;
    }
    const connections = sockets.get(session.sessionId) ?? new Set();
    connections.add(socket);
    sockets.set(session.sessionId, connections);
    sendState();
    const rawToken = request.cookies[SESSION_COOKIE];
    socket.on('message', (data, isBinary) => {
      const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (isBinary || bytes.byteLength > 16 * 1024) {
        socket.close(1009, 'Message too large');
        return;
      }
      const liveSession = sessionFor(rawToken);
      if (!liveSession) {
        socket.close(1008, 'Authentication required');
        return;
      }
      let command: unknown;
      try { command = JSON.parse(bytes.toString()); }
      catch {
        socket.send(JSON.stringify({ type: 'command:result', ok: false, error: 'Некорректная команда.' }));
        return;
      }
      const requestId = command && typeof command === 'object' && typeof (command as { requestId?: unknown }).requestId === 'string'
        ? (command as { requestId: string }).requestId.slice(0, 64) : undefined;
      try {
        if (!command || typeof command !== 'object' || Array.isArray(command)) throw new BoardCommandError('Некорректная команда.');
        const input = command as Record<string, unknown>;
        if (input.type === 'dice:pbta' || input.type === 'dice:free' || input.type === 'dice:reroll') {
          const entry = createDiceRoll(liveSession.identity, input);
          store.saveDiceRoll(entry);
        } else if (typeof input.type === 'string' && input.type.startsWith('sheet:')) {
          executeSheetCommand(store, liveSession.identity, input);
        } else if (input.type === 'room:system:set') {
          if (liveSession.identity.role !== 'gm') throw new BoardCommandError('Только ведущий может выбрать игровую систему.');
          if (Object.keys(input).some((key) => !['type', 'requestId', 'systemId', 'version'].includes(key))) throw new BoardCommandError('Некорректные настройки системы.');
          if (input.systemId === null && input.version === null) store.setActiveSystem(null, null);
          else if (typeof input.systemId === 'string' && typeof input.version === 'string' && systemModuleRegistry.get(input.systemId)?.version === input.version) store.setActiveSystem(input.systemId, input.version);
          else throw new BoardCommandError('Выберите зарегистрированную системную версию.');
        } else {
          executeBoardCommand(store, liveSession.identity, command);
        }
        socket.send(JSON.stringify({ type: 'command:result', requestId, ok: true }));
        sendState();
      } catch (error) {
        const message = error instanceof BoardCommandError ? error.message : 'Не удалось применить изменение.';
        socket.send(JSON.stringify({ type: 'command:result', requestId, ok: false, error: message }));
      }
    });
    socket.on('close', () => {
      connections.delete(socket);
      if (connections.size === 0) sockets.delete(session.sessionId);
      sendState();
    });
  });

  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith('/api/')) return reply.code(404).send({ error: 'Ресурс не найден.' });
    return reply.sendFile('index.html');
  });
  app.addHook('onClose', async () => {
    const openConnections = [...sockets.values()].flatMap((connections) => [...connections]);
    await Promise.all(openConnections.map((connection) => new Promise<void>((resolve) => {
      if (connection.readyState === 3) return resolve();
      connection.on('close', resolve);
      connection.close();
    })));
    store.close();
  });
  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = loadConfig();
  const app = await buildServer({ config });
  await app.listen({ host: config.host, port: config.port });
  app.log.info(`Room server listening on ${config.host}:${config.port}`);
}
