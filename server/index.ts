import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authenticate, SESSION_COOKIE, sessionDigest } from './auth.js';
import { loadConfig, type AppConfig } from './config.js';
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
      (parsed.port || defaultPort) === (requestHost.port || '80');
  } catch { return false; }
}

export async function buildServer(options?: { config?: AppConfig; store?: RoomStore; logger?: boolean }): Promise<FastifyInstance> {
  const config = options?.config ?? loadConfig();
  const store = options?.store ?? new RoomStore(config.dataDir, config.roomName);
  const app = Fastify({ logger: options?.logger ?? true, bodyLimit: 16 * 1024 });
  const sockets = new Map<string, Set<{
    send: (data: string) => void;
    close: () => void;
    readyState: number;
    on: (event: string, listener: () => void) => void;
  }>>();
  const distDir = resolve(process.cwd(), 'dist');
  mkdirSync(distDir, { recursive: true });

  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  await app.register(websocket);
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
      const payload = JSON.stringify({ type: 'room:state', roomName: store.roomName, identity, participants });
      for (const socket of connections) if (socket.readyState === 1) socket.send(payload);
    }
  };

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
    const connection = socket as unknown as { send: (data: string) => void; close: () => void; readyState: number; on: (event: string, listener: () => void) => void };
    const connections = sockets.get(session.sessionId) ?? new Set();
    connections.add(connection);
    sockets.set(session.sessionId, connections);
    sendState();
    connection.on('close', () => {
      connections.delete(connection);
      if (connections.size === 0) sockets.delete(session.sessionId);
      sendState();
    });
  });

  app.setNotFoundHandler(async (_request, reply) => {
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
