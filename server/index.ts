import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { createReadStream, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type WebSocket from 'ws';
import { authenticate, SESSION_COOKIE, sessionDigest } from './auth.js';
import { executeBoardCommand, BoardCommandError } from './board.js';
import { loadConfig, type AppConfig } from './config.js';
import { saveImageAsset, UnsupportedImageError } from './assets.js';
import { RoomStore, type Identity } from './store.js';

const COOKIE_PATH = '/';

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

export async function buildServer(options?: { config?: AppConfig; store?: RoomStore; logger?: boolean }): Promise<FastifyInstance> {
  const config = options?.config ?? loadConfig();
  const store = options?.store ?? new RoomStore(config.dataDir, config.roomName);
  const app = Fastify({ logger: options?.logger ?? true, bodyLimit: config.maxUploadBytes + 1024 * 1024 });
  const sockets = new Map<string, Set<WebSocket>>();
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
      const snapshot = store.snapshot(identity.role);
      const payload = JSON.stringify({ type: 'room:state', roomName: store.roomName, identity, participants, maxUploadBytes: config.maxUploadBytes, ...snapshot });
      for (const socket of connections) if (socket.readyState === 1) socket.send(payload);
    }
  };

  app.get('/api/board', async (request, reply) => {
    const session = sessionFor(request.cookies[SESSION_COOKIE]);
    if (!session) return reply.code(401).send({ error: 'Сессия не найдена.' });
    reply.header('Cache-Control', 'no-store');
    return { ...store.snapshot(session.identity.role), maxUploadBytes: config.maxUploadBytes };
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
    if (session.identity.role !== 'gm') return reply.code(403).send({ error: 'Загрузка доступна только ведущему.' });
    try {
      const file = await request.file({ limits: { fileSize: config.maxUploadBytes, files: 1, fields: 0 } });
      if (!file || file.fieldname !== 'image') return reply.code(400).send({ error: 'Выберите файл изображения.' });
      const bytes = await file.toBuffer();
      if (file.file.truncated) return reply.code(413).send({ error: 'Файл превышает установленный лимит.' });
      const result = await saveImageAsset(store, config.dataDir, bytes, file.mimetype, file.filename, config.maxUploadBytes);
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
    if (!asset || (session.identity.role !== 'gm' && !store.isAssetUsedByPublicObject(id))) {
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
        executeBoardCommand(store, liveSession.identity, command);
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
