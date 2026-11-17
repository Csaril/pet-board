import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { createReadStream, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomInt, randomUUID } from 'node:crypto';
import type WebSocket from 'ws';
import type { BoardFontFamily, BoardScene, NoteAccess } from '../src/shared/board.js';
import { DEFAULT_BOARD_FONT, isBoardFontFamily } from '../src/shared/fonts.js';
import { authenticateRoom, sessionCookieName, sessionDigest, SESSION_COOKIE_PREFIX } from './auth.js';
import { executeBoardCommand, BoardCommandError, ROOM_SYSTEM_IMMUTABLE, SYSTEM_MISMATCH } from './board.js';
import { CatalogNotInitializedError, RoomCatalog, type CatalogRoom } from './catalog.js';
import { loadConfig, type AppConfig } from './config.js';
import { AssetInUseError, AssetNotFoundError, deleteImageAsset, saveImageAsset, UnsupportedImageError } from './assets.js';
import { RoomStore, type Identity } from './store.js';
import type { DiceRollEntry } from '../src/shared/board.js';
import { findSystemMetadata } from '../src/modules/manifest.js';
import { rollFreeDice } from '../src/shared/dice.js';
import { executeSheetCommand } from './sheets.js';
import { loadSystemServer } from './system-registry.js';
import { acquireServerLock } from './instance-lock.js';
import { CatalogRoomAccess, RoomManager, RoomUnavailableError, SingleRoomAccess, type RoomAccess, type RoomLease } from './room-manager.js';

const COOKIE_PATH = '/';
const ASSET_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Migrated participants keep their old 64-hex ID; new participants are UUIDs. */
const PARTICIPANT_ID_PATTERN = /^(?:[0-9a-f]{64}|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const ROOM_ID_HEADER = 'x-room-id';
const LEASES = Symbol('room-leases');

function parseNotePayload(input: unknown, store: RoomStore): { title: string; body: string; access: NoteAccess; selectedParticipantIds: string[]; assetIds: string[]; markerType: 'text' | 'image'; markerText: string; markerAssetId?: string; fontFamily: BoardFontFamily } | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const body = input as Record<string, unknown>;
  if (Object.keys(body).some((key) => !['title', 'body', 'access', 'selectedParticipantIds', 'assetIds', 'markerType', 'markerText', 'markerAssetId', 'fontFamily'].includes(key))) return undefined;
  if (typeof body.title !== 'string' || !body.title.trim() || body.title.trim().length > 120) return undefined;
  if (typeof body.body !== 'string' || body.body.length > 20_000) return undefined;
  if (body.access !== 'gm-only' && body.access !== 'all-players' && body.access !== 'selected-players') return undefined;
  if (!Array.isArray(body.selectedParticipantIds) || body.selectedParticipantIds.length > 6 || body.selectedParticipantIds.some((id) => typeof id !== 'string' || !PARTICIPANT_ID_PATTERN.test(id))) return undefined;
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
  const fontFamily = body.fontFamily === undefined ? DEFAULT_BOARD_FONT : body.fontFamily;
  if (!isBoardFontFamily(fontFamily)) return undefined;
  return { title: body.title.trim(), body: body.body, access: body.access, selectedParticipantIds, assetIds, markerType, markerText: markerText.trim(), fontFamily, ...(markerAssetId ? { markerAssetId } : {}) };
}

function parsePersonalNotePayload(input: unknown, store: RoomStore, identity: Identity): { title: string; body: string; assetIds: string[]; fontFamily: BoardFontFamily } | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const body = input as Record<string, unknown>;
  if (Object.keys(body).some((key) => !['title', 'body', 'assetIds', 'fontFamily'].includes(key))) return undefined;
  if (typeof body.title !== 'string' || !body.title.trim() || body.title.trim().length > 120) return undefined;
  if (typeof body.body !== 'string' || body.body.length > 20_000) return undefined;
  if (!Array.isArray(body.assetIds) || body.assetIds.length > 20 || body.assetIds.some((id) => typeof id !== 'string' || !store.getAsset(id) || !store.canReadAsset(id, identity))) return undefined;
  const assetIds = [...new Set(body.assetIds as string[])];
  if (assetIds.length !== body.assetIds.length) return undefined;
  const fontFamily = body.fontFamily === undefined ? DEFAULT_BOARD_FONT : body.fontFamily;
  if (!isBoardFontFamily(fontFamily)) return undefined;
  return { title: body.title.trim(), body: body.body, assetIds, fontFamily };
}

function parseSystemConfig(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const serialized = JSON.stringify(value);
  if (serialized.length > 16_384) return undefined;
  return JSON.parse(serialized) as Record<string, unknown>;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw?.split(',')[0]?.trim() || undefined;
}

function normalizeOrigin(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined;
    if (parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname !== '/' && parsed.pathname !== '')) return undefined;
    return parsed.origin.toLowerCase();
  } catch { return undefined; }
}

function requestOrigin(
  headers: Record<string, string | string[] | undefined>,
  protocol: string,
  trustProxy: boolean,
): string | undefined {
  const host = trustProxy ? firstHeader(headers['x-forwarded-host']) ?? headers.host : headers.host;
  if (!host) return undefined;
  const rawProtocol = trustProxy ? firstHeader(headers['x-forwarded-proto']) ?? protocol : protocol;
  if (rawProtocol !== 'https' && rawProtocol !== 'http') return undefined;
  return normalizeOrigin(`${rawProtocol}://${host}`);
}

/**
 * Compares the browser Origin with the direct request host and with explicitly
 * configured public origins. X-Forwarded-* headers are ignored unless
 * TRUST_PROXY is enabled, so a random client cannot spoof its own Origin.
 */
function isAllowedOrigin(
  origin: string | string[] | undefined,
  headers: Record<string, string | string[] | undefined>,
  protocol: string,
  config: AppConfig,
): boolean {
  const rawOrigin = firstHeader(origin);
  const normalized = rawOrigin ? normalizeOrigin(rawOrigin) : undefined;
  if (!normalized) return false;
  const direct = requestOrigin(headers, protocol, config.trustProxy === true);
  if (direct && normalized === direct) return true;
  return (config.publicOrigins ?? []).includes(normalized);
}

export interface ServerOptions {
  config?: AppConfig;
  /** One-room test harness. Production passes a RoomManager instead. */
  store?: RoomStore;
  roomManager?: RoomManager;
  /** Explicitly constructed access adapter (catalog or harness). */
  roomAccess?: RoomAccess;
  logger?: boolean;
  randomInt?: (min: number, max: number) => number;
}

interface RequestContext {
  room: CatalogRoom;
  store: RoomStore;
  lease: RoomLease;
  sessionId: string;
  identity: Identity;
}

export async function buildServer(options: ServerOptions = {}): Promise<FastifyInstance> {
  const config = options.config ?? loadConfig();
  const roomAccess: RoomAccess = options.roomAccess
    ?? (options.roomManager ? new CatalogRoomAccess(options.roomManager) : options.store ? new SingleRoomAccess(options.store, config) : undefined as never);
  if (!roomAccess) throw new Error('Для запуска сервера нужен каталог комнат или тестовый RoomStore.');
  const app = Fastify({ logger: options.logger ?? true, bodyLimit: config.maxUploadBytes + 1024 * 1024, trustProxy: config.trustProxy === true });
  const originAllowed = (request: { headers: Record<string, string | string[] | undefined>; protocol: string }): boolean =>
    isAllowedOrigin(request.headers.origin, request.headers, request.protocol, config);
  /** roomId -> sessionId -> sockets. Broadcasts never cross a room boundary. */
  const sockets = new Map<string, Map<string, Set<WebSocket>>>();
  const secureRandomInt = options?.randomInt ?? randomInt;
  const distDir = resolve(process.cwd(), 'dist');
  mkdirSync(distDir, { recursive: true });

  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  await app.register(websocket, { options: { maxPayload: 16 * 1024 } });
  await app.register(multipart, { limits: { fileSize: config.maxUploadBytes, files: 1, fields: 0 } });
  await app.register(fastifyStatic, { root: distDir, prefix: '/', wildcard: false });

  const cookieOptions = { path: COOKIE_PATH, httpOnly: true, sameSite: 'strict' as const, secure: config.cookieSecure };
  const requestIsSecure = (request: { headers: Record<string, string | string[] | undefined>; protocol: string }): boolean => {
    if (request.protocol === 'https') return true;
    try { return Boolean(request.headers.origin && new URL(String(request.headers.origin)).protocol === 'https:'); }
    catch { return false; }
  };
  /** Secure is added only when the current request really arrives over HTTPS (ngrok), while local HTTP verification still works. */
  const sessionCookieOptions = (request: { headers: Record<string, string | string[] | undefined>; protocol: string }) => ({
    ...cookieOptions,
    secure: config.cookieSecure && requestIsSecure(request),
  });

  const addLease = (request: object, lease: RoomLease): void => {
    const target = request as { [LEASES]?: RoomLease[] };
    const leases = target[LEASES] ?? [];
    leases.push(lease);
    target[LEASES] = leases;
  };
  app.addHook('onResponse', async (request) => {
    const leases = (request as { [LEASES]?: RoomLease[] })[LEASES];
    if (!leases) return;
    for (const lease of leases) lease.release();
    delete (request as { [LEASES]?: RoomLease[] })[LEASES];
  });

  const requestedRoomId = (request: { headers: Record<string, string | string[] | undefined>; query?: unknown }): string | undefined => {
    const header = firstHeader(request.headers[ROOM_ID_HEADER]);
    if (header) return header;
    const query = request.query as Record<string, unknown> | undefined;
    const value = query?.roomId;
    return typeof value === 'string' ? value : undefined;
  };

  /** Harness requests have no room header; legacy cookies also identify the only room. */
  const fallbackRoomId = (request: { cookies: Record<string, string | undefined> }): string | undefined => {
    if (roomAccess.legacyCookie) return 'default';
    const names = Object.keys(request.cookies).filter((name) => name.startsWith(SESSION_COOKIE_PREFIX));
    if (names.length !== 1) return undefined;
    return names[0]!.slice(SESSION_COOKIE_PREFIX.length);
  };

  const resolveContext = (request: {
    headers: Record<string, string | string[] | undefined>;
    query?: unknown;
    cookies: Record<string, string | undefined>;
    protocol: string;
  }): RequestContext | { error: number; code?: string; message: string } => {
    const roomId = requestedRoomId(request) ?? fallbackRoomId(request);
    if (!roomId) return { error: 401, message: 'Сессия не найдена.' };
    const room = roomAccess.getRoom(roomId);
    if (!room) return { error: 401, message: 'Сессия не найдена.' };
    if (room.status !== 'active') {
      return { error: 403, code: room.status === 'disabled' ? 'ROOM_DISABLED' : 'ROOM_ARCHIVED', message: 'Комната недоступна.' };
    }
    const raw = request.cookies[sessionCookieName(room.id, roomAccess.legacyCookie)];
    if (!raw || raw.length > 100) return { error: 401, message: 'Сессия не найдена.' };
    let lease: RoomLease;
    try { lease = roomAccess.acquire(room.id); }
    catch (error) {
      if (error instanceof RoomUnavailableError) return { error: 403, code: error.code, message: 'Комната недоступна.' };
      return { error: 503, code: 'ROOM_CAPACITY', message: error instanceof Error ? error.message : 'Комната недоступна.' };
    }
    const sessionId = sessionDigest(raw);
    const identity = lease.store.getSession(sessionId);
    if (!identity) {
      lease.release();
      return { error: 401, message: 'Сессия не найдена.' };
    }
    addLease(request, lease);
    return { room, store: lease.store, lease, sessionId, identity };
  };

  const roomSocketMap = (roomId: string): Map<string, Set<WebSocket>> => {
    let map = sockets.get(roomId);
    if (!map) { map = new Map(); sockets.set(roomId, map); }
    return map;
  };

  const closeRoomSockets = (roomId: string, reason: string): void => {
    const map = sockets.get(roomId);
    if (!map) return;
    for (const connections of map.values()) {
      for (const socket of connections) {
        if (socket.readyState === 1) {
          socket.send(JSON.stringify({ type: 'room:closed', reason }));
          socket.close(1008, 'Room unavailable');
        }
      }
    }
    sockets.delete(roomId);
    if (options.roomManager) options.roomManager.requestClose(roomId);
  };

  const sendStateToRoom = (roomId: string): void => {
    const map = sockets.get(roomId);
    if (!map || map.size === 0) return;
    let lease: RoomLease;
    try { lease = roomAccess.acquire(roomId); }
    catch {
      closeRoomSockets(roomId, 'unavailable');
      return;
    }
    try {
      const store = lease.store;
      const room = lease.room;
      const connected = [...map.keys()].flatMap((sessionId) => {
        const identity = store.getSession(sessionId);
        return identity ? [identity] : [];
      });
      const participants = [...new Map(connected.map((identity) => [identity.participantId, identity])).values()];
      for (const [sessionId, connections] of map) {
        const identity = store.getSession(sessionId);
        if (!identity) continue;
        const snapshot = store.snapshot(identity);
        const payload = JSON.stringify({
          type: 'room:state', roomId: room.id, roomName: room.name, identity, participants,
          maxUploadBytes: config.maxUploadBytes, ...snapshot,
        });
        for (const socket of connections) if (socket.readyState === 1) socket.send(payload);
      }
    } finally { lease.release(); }
  };

  const immutableSystemError = (): BoardCommandError => new BoardCommandError(
    'Игровая система комнаты уже закреплена и не может быть изменена.',
    { code: ROOM_SYSTEM_IMMUTABLE, statusCode: 409 },
  );

  /** One-time system commit shared by WebSocket and the HTTP API. */
  const initializeRoomSystem = (store: RoomStore, identity: Identity, input: Record<string, unknown>): void => {
    if (store.roomSystem.fixed) throw immutableSystemError();
    if (identity.role !== 'gm') throw new BoardCommandError('Только ведущий может выбрать игровую систему.', { statusCode: 403 });
    if (Object.keys(input).some((key) => !['type', 'requestId', 'systemId', 'version', 'config'].includes(key))) {
      throw new BoardCommandError('Некорректная команда выбора системы.');
    }
    if (!Object.prototype.hasOwnProperty.call(input, 'systemId')) throw new BoardCommandError('Укажите систему комнаты или явный режим без системы.');
    const systemId = input.systemId;
    if (systemId === null) {
      if (input.version !== undefined && input.version !== null) throw new BoardCommandError('Для режима без системы версия не задаётся.');
      store.initializeSystem(null, null);
      return;
    }
    if (typeof systemId !== 'string' || !systemId || systemId.length > 64) throw new BoardCommandError('Выберите зарегистрированную систему.');
    if (typeof input.version !== 'string' || !input.version || input.version.length > 64) throw new BoardCommandError('Укажите версию системного модуля.');
    const module = findSystemMetadata(systemId, input.version);
    if (!module) throw new BoardCommandError('Выберите зарегистрированную системную версию.');
    const systemConfig = parseSystemConfig(input.config);
    if (!systemConfig) throw new BoardCommandError('Некорректная конфигурация системного модуля.');
    store.initializeSystem(module.id, module.version, systemConfig);
  };

  const prepareRoomSystem = async (room: CatalogRoom): Promise<void> => {
    if (!room.systemId || !room.systemVersion) return;
    try {
      const module = await loadSystemServer(room.systemId, room.systemVersion);
      const metadata = findSystemMetadata(room.systemId, room.systemVersion);
      if (!module.migrateRoomSheets || !metadata) return;
      let lease: RoomLease | undefined;
      try {
        lease = roomAccess.acquire(room.id);
        const report = module.migrateRoomSheets({
          store: lease.store,
          target: { id: metadata.id, version: metadata.version, schemaVersion: metadata.sheetSchemaVersion },
        });
        if (report.migratedSheetIds.length > 0) {
          app.log.info(
            { roomId: room.id, system: `${metadata.id}@${metadata.version}`, migrated: report.migratedSheetIds.length },
            'room sheets migrated',
          );
        }
      } finally {
        lease?.release();
      }
    } catch (error) {
      // Entry stays possible so the user sees the specific unsupported-version
      // or incompatible-schema message; no fallback and no data rewrite occur.
      app.log.warn({ err: error, roomId: room.id }, 'system module or sheet migration is not available');
    }
  };

  const createDiceRoll = async (store: RoomStore, identity: Identity, command: Record<string, unknown>): Promise<DiceRollEntry> => {
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
        createdAt: new Date().toISOString(), kind: 'free', systemId: null, systemVersion: null,
        dice: result.dice, keptDice: result.dice, discardedDie: null,
        characteristicName: null, characterId: null, characterOwnerId: null, characteristicBonus: null, situationalModifier: 0, disadvantage: false,
        sides: sides as number, total: result.total, category: null, critical: null, rerollOf: null,
        abilityId: null, abilitySheetId: null, abilityCharacterName: null, abilityName: null, abilityAssetId: null,
        abilitySummary: null, abilityDescription: null, abilityFontFamily: null,
      };
    }

    const active = store.fixedSystem;
    if (!active) {
      throw new BoardCommandError('Игровая система комнаты не закреплена.', { code: SYSTEM_MISMATCH, statusCode: 409 });
    }
    const module = await loadSystemServer(active.id, active.version);
    if (!module.handlesRollCommand?.(String(command.type)) || !module.createRoll) {
      throw new BoardCommandError(`Система ${active.id} не поддерживает этот бросок.`, { code: SYSTEM_MISMATCH, statusCode: 409 });
    }
    return module.createRoll({ store, identity, command, activeSystem: active, randomInt: secureRandomInt });
  };

  const withContext = (request: Parameters<typeof resolveContext>[0], reply: { code: (status: number) => { send: (body: unknown) => unknown } }): RequestContext | undefined => {
    const context = resolveContext(request);
    if ('error' in context) {
      reply.code(context.error).send({ error: context.message, ...(context.code ? { code: context.code } : {}) });
      return undefined;
    }
    return context;
  };

  app.get('/api/board', async (request, reply) => {
    const context = withContext(request, reply);
    if (!context) return;
    reply.header('Cache-Control', 'no-store');
    return { ...context.store.snapshot(context.identity), maxUploadBytes: config.maxUploadBytes };
  });

  /**
   * The only HTTP entry point for the one-time choice. Once the room is fixed
   * it always answers 409 ROOM_SYSTEM_IMMUTABLE.
   */
  app.put('/api/room/system', async (request, reply) => {
    if (!originAllowed(request)) return reply.code(403).send({ error: 'Origin not allowed.' });
    const context = withContext(request, reply);
    if (!context) return;
    const body = request.body && typeof request.body === 'object' && !Array.isArray(request.body)
      ? request.body as Record<string, unknown>
      : {};
    initializeRoomSystem(context.store, context.identity, body);
    reply.header('Cache-Control', 'no-store');
    sendStateToRoom(context.room.id);
    return { system: context.store.roomSystem };
  });

  app.get('/api/sheets', async (request, reply) => {
    const context = withContext(request, reply);
    if (!context) return;
    reply.header('Cache-Control', 'no-store');
    return { sheets: context.store.getSheetsFor(context.identity) };
  });

  app.get('/api/sheets/:id', async (request, reply) => {
    const context = withContext(request, reply);
    if (!context) return;
    const { id } = request.params as { id: string };
    const sheet = context.store.getSheetFor(id, context.identity);
    if (!sheet) return reply.code(404).send({ error: 'Лист персонажа не найден.' });
    reply.header('Cache-Control', 'no-store');
    return { sheet };
  });

  app.get('/api/notes', async (request, reply) => {
    const context = withContext(request, reply);
    if (!context) return;
    if (context.identity.role !== 'gm') return reply.code(403).send({ error: 'Список заметок доступен только ведущему.' });
    reply.header('Cache-Control', 'no-store');
    return { notes: context.store.listNotes() };
  });

  app.post('/api/notes', async (request, reply) => {
    if (!originAllowed(request)) return reply.code(403).send({ error: 'Origin not allowed.' });
    const context = withContext(request, reply);
    if (!context) return;
    if (context.identity.role !== 'gm') return reply.code(403).send({ error: 'Заметки может создавать только ведущий.' });
    const input = parseNotePayload(request.body, context.store);
    if (!input) return reply.code(400).send({ error: 'Проверьте заголовок, текст, доступ, участников и изображения заметки.' });
    const id = randomUUID();
    context.store.createNote({ id, ...input, creatorId: context.identity.participantId });
    reply.header('Cache-Control', 'no-store');
    sendStateToRoom(context.room.id);
    return { note: context.store.getNote(id) };
  });

  app.get('/api/notes/:id', async (request, reply) => {
    const context = withContext(request, reply);
    if (!context) return;
    const { id } = request.params as { id: string };
    const note = context.store.getNote(id);
    if (!note || note.noteType !== 'board' || !context.store.canReadNote(id, context.identity)) return reply.code(404).send({ error: 'Заметка не найдена.' });
    reply.header('Cache-Control', 'no-store');
    return { note };
  });

  app.put('/api/notes/:id', async (request, reply) => {
    if (!originAllowed(request)) return reply.code(403).send({ error: 'Origin not allowed.' });
    const context = withContext(request, reply);
    if (!context) return;
    if (context.identity.role !== 'gm') return reply.code(403).send({ error: 'Заметки может редактировать только ведущий.' });
    const { id } = request.params as { id: string };
    if (context.store.getNoteType(id) !== 'board') return reply.code(404).send({ error: 'Заметка не найдена.' });
    const input = parseNotePayload(request.body, context.store);
    if (!input) return reply.code(400).send({ error: 'Проверьте заголовок, текст, доступ, участников и изображения заметки.' });
    context.store.updateNote(id, input);
    reply.header('Cache-Control', 'no-store');
    sendStateToRoom(context.room.id);
    return { note: context.store.getNote(id) };
  });

  app.delete('/api/notes/:id', async (request, reply) => {
    if (!originAllowed(request)) return reply.code(403).send({ error: 'Origin not allowed.' });
    const context = withContext(request, reply);
    if (!context) return;
    if (context.identity.role !== 'gm') return reply.code(403).send({ error: 'Удалять заметки может только ведущий.' });
    const { id } = request.params as { id: string };
    if (context.store.getNoteType(id) !== 'board') return reply.code(404).send({ error: 'Заметка не найдена.' });
    context.store.deleteNote(id);
    sendStateToRoom(context.room.id);
    return reply.code(204).send();
  });

  app.get('/api/personal-notes', async (request, reply) => {
    const context = withContext(request, reply);
    if (!context) return;
    reply.header('Cache-Control', 'no-store');
    return { notes: context.store.listPersonalNotes(context.identity) };
  });

  app.post('/api/personal-notes', async (request, reply) => {
    if (!originAllowed(request)) return reply.code(403).send({ error: 'Origin not allowed.' });
    const context = withContext(request, reply);
    if (!context) return;
    if (context.identity.role !== 'player') return reply.code(403).send({ error: 'Личные заметки создают игроки.' });
    const input = parsePersonalNotePayload(request.body, context.store, context.identity);
    if (!input) return reply.code(400).send({ error: 'Проверьте название, текст и изображения личной заметки.' });
    const id = randomUUID();
    context.store.createNote({
      id, ...input, access: 'gm-only', selectedParticipantIds: [], creatorId: context.identity.participantId,
      markerType: 'text', markerText: '', noteType: 'personal',
      ownerId: context.identity.participantId, ownerName: context.identity.name,
    });
    reply.header('Cache-Control', 'no-store');
    sendStateToRoom(context.room.id);
    return { note: context.store.getNote(id) };
  });

  app.get('/api/personal-notes/:id', async (request, reply) => {
    const context = withContext(request, reply);
    if (!context) return;
    const { id } = request.params as { id: string };
    if (context.store.getNoteType(id) !== 'personal' || !context.store.canReadNote(id, context.identity)) return reply.code(404).send({ error: 'Заметка не найдена.' });
    reply.header('Cache-Control', 'no-store');
    return { note: context.store.getNote(id) };
  });

  app.put('/api/personal-notes/:id', async (request, reply) => {
    if (!originAllowed(request)) return reply.code(403).send({ error: 'Origin not allowed.' });
    const context = withContext(request, reply);
    if (!context) return;
    const { id } = request.params as { id: string };
    if (context.store.getNoteType(id) !== 'personal') return reply.code(404).send({ error: 'Заметка не найдена.' });
    if (!context.store.canEditPersonalNote(id, context.identity)) return reply.code(403).send({ error: 'Можно редактировать только собственную личную заметку.' });
    const input = parsePersonalNotePayload(request.body, context.store, context.identity);
    if (!input) return reply.code(400).send({ error: 'Проверьте название, текст и изображения личной заметки.' });
    context.store.updatePersonalNote(id, input);
    reply.header('Cache-Control', 'no-store');
    sendStateToRoom(context.room.id);
    return { note: context.store.getNote(id) };
  });

  app.delete('/api/personal-notes/:id', async (request, reply) => {
    if (!originAllowed(request)) return reply.code(403).send({ error: 'Origin not allowed.' });
    const context = withContext(request, reply);
    if (!context) return;
    const { id } = request.params as { id: string };
    if (context.store.getNoteType(id) !== 'personal') return reply.code(404).send({ error: 'Заметка не найдена.' });
    if (!context.store.canEditPersonalNote(id, context.identity)) return reply.code(403).send({ error: 'Можно удалять только собственную личную заметку.' });
    context.store.deleteNote(id);
    sendStateToRoom(context.room.id);
    return reply.code(204).send();
  });

  app.post('/api/session', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    if (!originAllowed(request)) {
      return reply.code(403).send({ error: 'Origin not allowed.' });
    }
    const result = authenticateRoom(request.body, roomAccess, config.sessionDays);
    if (!result) return reply.code(401).send({ error: 'Неверный код комнаты или пароль, либо комната недоступна.' });
    await prepareRoomSystem(result.room);
    reply.setCookie(sessionCookieName(result.room.id, roomAccess.legacyCookie), result.sessionId, {
      ...sessionCookieOptions(request),
      expires: new Date(Date.now() + config.sessionDays * 24 * 60 * 60 * 1000),
    });
    sendStateToRoom(result.room.id);
    return {
      identity: result.identity,
      room: {
        id: result.room.id,
        name: result.room.name,
        systemId: result.room.systemId,
        systemVersion: result.room.systemVersion,
      },
    };
  });

  app.get('/api/session', async (request, reply) => {
    const context = withContext(request, reply);
    if (!context) return;
    await prepareRoomSystem(context.room);
    return {
      identity: context.identity,
      room: { id: context.room.id, name: context.room.name, systemId: context.room.systemId, systemVersion: context.room.systemVersion },
    };
  });

  app.delete('/api/session', async (request, reply) => {
    if (!originAllowed(request)) {
      return reply.code(403).send({ error: 'Origin not allowed.' });
    }
    const resolved = resolveContext(request);
    if ('error' in resolved) {
      reply.clearCookie(sessionCookieName(requestedRoomId(request) ?? 'default', roomAccess.legacyCookie), sessionCookieOptions(request));
      return reply.code(204).send();
    }
    const context = resolved;
    const map = sockets.get(context.room.id);
    map?.get(context.sessionId)?.forEach((socket) => {
      if (socket.readyState === 1) {
        socket.send(JSON.stringify({ type: 'session:ended' }));
        socket.close();
      }
    });
    map?.delete(context.sessionId);
    if (map && map.size === 0) sockets.delete(context.room.id);
    context.store.deleteSession(context.sessionId);
    reply.clearCookie(sessionCookieName(context.room.id, roomAccess.legacyCookie), sessionCookieOptions(request));
    sendStateToRoom(context.room.id);
    return reply.code(204).send();
  });

  app.post('/api/assets', {
    config: { rateLimit: { max: 12, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    if (!originAllowed(request)) return reply.code(403).send({ error: 'Origin not allowed.' });
    const context = withContext(request, reply);
    if (!context) return;
    try {
      const file = await request.file({ limits: { fileSize: config.maxUploadBytes, files: 1, fields: 0 } });
      if (!file || file.fieldname !== 'image') return reply.code(400).send({ error: 'Выберите файл изображения.' });
      const bytes = await file.toBuffer();
      if (file.file.truncated) return reply.code(413).send({ error: 'Файл превышает установленный лимит.' });
      const result = await saveImageAsset(context.store, context.store.assetsDir, bytes, file.mimetype, file.filename, config.maxUploadBytes, context.identity.participantId);
      sendStateToRoom(context.room.id);
      return { asset: result.asset, deduplicated: result.deduplicated };
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'FST_REQ_FILE_TOO_LARGE') return reply.code(413).send({ error: `Максимальный размер файла: ${Math.round(config.maxUploadBytes / 1024 / 1024)} MB.` });
      if (error instanceof UnsupportedImageError) return reply.code(415).send({ error: error.message });
      throw error;
    }
  });

  app.get('/api/assets/:id/usage', async (request, reply) => {
    const context = withContext(request, reply);
    if (!context) return;
    if (context.identity.role !== 'gm') return reply.code(403).send({ error: 'Информация об использовании доступна только ведущему.' });
    const { id } = request.params as { id: string };
    if (!ASSET_ID_PATTERN.test(id) || !context.store.getAsset(id)) return reply.code(404).send({ error: 'Изображение не найдено.' });
    reply.header('Cache-Control', 'no-store');
    return { usage: context.store.getAssetUsage(id) };
  });

  app.delete('/api/assets/:id', async (request, reply) => {
    if (!originAllowed(request)) return reply.code(403).send({ error: 'Origin not allowed.' });
    const context = withContext(request, reply);
    if (!context) return;
    if (context.identity.role !== 'gm') return reply.code(403).send({ error: 'Удалять изображения может только ведущий.' });
    const { id } = request.params as { id: string };
    if (!ASSET_ID_PATTERN.test(id) || !context.store.getAsset(id)) return reply.code(404).send({ error: 'Изображение не найдено.' });
    const usage = context.store.getAssetUsage(id);
    if (usage.length > 0) return reply.code(409).send({ error: 'Изображение используется и не может быть удалено.', usage });
    try {
      await deleteImageAsset(context.store, context.store.assetsDir, id);
    } catch (error) {
      if (error instanceof AssetInUseError) return reply.code(409).send({ error: error.message, usage: error.usage });
      if (error instanceof AssetNotFoundError) return reply.code(404).send({ error: error.message });
      throw error;
    }
    sendStateToRoom(context.room.id);
    return reply.code(204).send();
  });

  app.get('/api/assets/:id', async (request, reply) => {
    const context = withContext(request, reply);
    if (!context) return;
    const { id } = request.params as { id: string };
    if (!ASSET_ID_PATTERN.test(id)) {
      return reply.code(404).send({ error: 'Изображение не найдено.' });
    }
    const asset = context.store.getAsset(id);
    if (!asset || !context.store.canReadAsset(id, context.identity)) {
      return reply.code(404).send({ error: 'Изображение не найдено.' });
    }
    reply.type(asset.mimeType).header('Cache-Control', 'private, no-store').header('X-Content-Type-Options', 'nosniff');
    return reply.send(createReadStream(join(context.store.assetsDir, id)));
  });

  app.get('/ws', { websocket: true }, (socket, request) => {
    if (!originAllowed(request)) {
      socket.close(1008, 'Origin not allowed');
      return;
    }
    const url = new URL(request.url, 'http://localhost');
    const roomId = requestedRoomId({ headers: request.headers, query: Object.fromEntries(url.searchParams) })
      ?? (roomAccess.legacyCookie ? 'default' : undefined);
    if (!roomId) { socket.close(1008, 'Authentication required'); return; }
    const room = roomAccess.getRoom(roomId);
    if (!room || room.status !== 'active') { socket.close(1008, 'Room unavailable'); return; }
    const rawToken = request.cookies[sessionCookieName(roomId, roomAccess.legacyCookie)];
    if (!rawToken || rawToken.length > 100) { socket.close(1008, 'Authentication required'); return; }
    let lease: RoomLease;
    try { lease = roomAccess.acquire(roomId); }
    catch { socket.close(1008, 'Room unavailable'); return; }
    const sessionId = sessionDigest(rawToken);
    const identity = lease.store.getSession(sessionId);
    if (!identity) { lease.release(); socket.close(1008, 'Authentication required'); return; }

    const map = roomSocketMap(roomId);
    const connections = map.get(sessionId) ?? new Set();
    connections.add(socket);
    map.set(sessionId, connections);
    sendStateToRoom(roomId);

    socket.on('message', async (data, isBinary) => {
      const liveRoom = roomAccess.getRoom(roomId);
      if (!liveRoom || liveRoom.status !== 'active') {
        closeRoomSockets(roomId, liveRoom?.status ?? 'missing');
        return;
      }
      const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (isBinary || bytes.byteLength > 16 * 1024) {
        socket.close(1009, 'Message too large');
        return;
      }
      const liveIdentity = lease.store.getSession(sessionId);
      if (!liveIdentity) {
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
        if (input.type === 'dice:pbta' || input.type === 'dice:free' || input.type === 'dice:reroll' || input.type === 'dice:nechronica') {
          const entry = await createDiceRoll(lease.store, liveIdentity, input);
          lease.store.saveDiceRoll(entry);
        } else if (typeof input.type === 'string' && input.type.startsWith('sheet:')) {
          await executeSheetCommand(lease.store, liveIdentity, input);
        } else if (input.type === 'room:background:set') {
          if (liveIdentity.role !== 'gm') throw new BoardCommandError('Только ведущий может менять фон доски.');
          if (Object.keys(input).some((key) => !['type', 'requestId', 'background', 'scene'].includes(key))) throw new BoardCommandError('Некорректные настройки фона.');
          if (input.background !== 'black' && input.background !== 'gray') throw new BoardCommandError('Доступны только чёрный и серый фон.');
          const scene: BoardScene = input.scene === undefined ? lease.store.activeScene : input.scene === 'battle' ? 'battle' : input.scene === 'board' ? 'board' : (() => { throw new BoardCommandError('Недопустимая сцена.'); })();
          if (scene === 'battle' && !lease.store.supportsBattleMap) throw new BoardCommandError('Боевая карта доступна только системе, которая её поддерживает.', { code: SYSTEM_MISMATCH, statusCode: 409 });
          lease.store.setBackground(scene, input.background);
        } else if (input.type === 'room:scene:set') {
          if (liveIdentity.role !== 'gm') throw new BoardCommandError('Только ведущий может переключать сцену комнаты.');
          if (Object.keys(input).some((key) => !['type', 'requestId', 'scene'].includes(key))) throw new BoardCommandError('Некорректная команда сцены.');
          if (input.scene !== 'board' && input.scene !== 'battle') throw new BoardCommandError('Доступны только основная доска и боевая карта.');
          if (input.scene === 'battle' && !lease.store.supportsBattleMap) throw new BoardCommandError('Боевая карта доступна только системе, которая её поддерживает.', { code: SYSTEM_MISMATCH, statusCode: 409 });
          lease.store.setActiveScene(input.scene);
        } else if (input.type === 'room:system:initialize') {
          initializeRoomSystem(lease.store, liveIdentity, input);
        } else if (input.type === 'room:system:set') {
          throw immutableSystemError();
        } else {
          executeBoardCommand(lease.store, liveIdentity, command);
        }
        socket.send(JSON.stringify({ type: 'command:result', requestId, ok: true }));
        sendStateToRoom(roomId);
      } catch (error) {
        const known = error instanceof BoardCommandError;
        const message = known ? error.message : 'Не удалось применить изменение.';
        socket.send(JSON.stringify({ type: 'command:result', requestId, ok: false, error: message, ...(known && error.code ? { code: error.code } : {}) }));
      }
    });
    socket.on('close', () => {
      connections.delete(socket);
      if (connections.size === 0) {
        map.delete(sessionId);
        if (map.size === 0) {
          sockets.delete(roomId);
          if (options.roomManager) options.roomManager.requestClose(roomId);
        }
      }
      lease.release();
      sendStateToRoom(roomId);
    });
  });

  /** CLI status changes are picked up without restarting the server. */
  const statusTimer = setInterval(() => {
    for (const roomId of [...sockets.keys()]) {
      const room = roomAccess.getRoom(roomId);
      if (!room || room.status !== 'active') closeRoomSockets(roomId, room?.status ?? 'missing');
    }
  }, 2000);
  statusTimer.unref();

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'same-origin');
    return payload;
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const statusCode = typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode <= 599
      ? error.statusCode
      : 500;
    if (statusCode >= 500) request.log.error({ err: error }, 'request failed');
    const message = statusCode >= 500 ? 'Внутренняя ошибка сервера.' : error.message || 'Запрос отклонён.';
    const code = error instanceof BoardCommandError && error.code ? error.code : undefined;
    if (request.url.startsWith('/api/')) return reply.code(statusCode).send({ error: message, ...(code ? { code } : {}) });
    return reply.code(statusCode).type('text/plain; charset=utf-8').send(message);
  });

  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith('/api/') || request.url.startsWith('/ws')) {
      return reply.code(404).send({ error: 'Ресурс не найден.' });
    }
    const pathname = request.url.split('?')[0] ?? '';
    if (pathname.startsWith('/room/') && /^[a-z0-9][a-z0-9-]{0,63}$/.test(pathname.slice('/room/'.length))) {
      return reply.sendFile('index.html');
    }
    if (/\.[^/]+$/.test(pathname)) return reply.code(404).type('text/plain; charset=utf-8').send('Ресурс не найден.');
    return reply.sendFile('index.html');
  });
  app.addHook('onClose', async () => {
    clearInterval(statusTimer);
    const openConnections = [...sockets.values()].flatMap((map) => [...map.values()].flatMap((connections) => [...connections]));
    await Promise.all(openConnections.map((connection) => new Promise<void>((resolve) => {
      if (connection.readyState === 3) return resolve();
      connection.on('close', resolve);
      connection.close();
    })));
    if (options.roomManager) options.roomManager.close();
  });
  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let releaseLock: (() => void) | undefined;
  try {
    const config = loadConfig();
    if (config.cookieSecure && !existsSync(resolve(process.cwd(), 'dist', 'index.html'))) {
      throw new Error('Frontend build not found. Run "npm run build" before starting the production server.');
    }
    releaseLock = acquireServerLock(config.dataDir);
    let roomManager: RoomManager;
    try {
      const catalog = RoomCatalog.open(config.dataDir);
      roomManager = new RoomManager({ dataDir: resolve(config.dataDir), catalog, maxOpenRooms: config.maxOpenRooms ?? 8 });
    } catch (error) {
      if (error instanceof CatalogNotInitializedError) throw error;
      throw error;
    }
    const app = await buildServer({ config, roomManager });
    await app.listen({ host: config.host, port: config.port });
    app.log.info(`Room server listening on ${config.host}:${config.port}`);
    process.once('exit', () => releaseLock?.());
    const shutdown = (): void => {
      void app.close().finally(() => {
        releaseLock?.();
        releaseLock = undefined;
        process.exit(0);
      });
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  } catch (error) {
    releaseLock?.();
    console.error(`Не удалось запустить сервер: ${error instanceof Error ? error.message : 'неизвестная ошибка'}`);
    process.exitCode = 1;
  }
}
