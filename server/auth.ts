import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AppConfig } from './config.js';
import type { Identity, Role, RoomStore } from './store.js';

export const SESSION_COOKIE = 'tb_session';

function constantTimeEqual(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function authenticate(
  input: unknown,
  config: AppConfig,
  store: RoomStore,
  now = Date.now(),
): { sessionId: string; identity: Identity } | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const body = input as Record<string, unknown>;
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const submittedRoomCode = typeof body.roomCode === 'string' ? body.roomCode : '';
  const roomCode = config.roomCode.length <= 8 ? submittedRoomCode.toUpperCase() : submittedRoomCode;
  const role: Role | undefined = body.role === 'gm' || body.role === 'player' ? body.role : undefined;
  if (name.length < 1 || name.length > 40 || !role || !constantTimeEqual(roomCode, config.roomCode)) return undefined;
  if (role === 'gm' && (typeof body.gmPassword !== 'string' || !constantTimeEqual(body.gmPassword, config.gmPassword))) return undefined;

  const token = randomBytes(32).toString('base64url');
  const sessionId = sessionDigest(token);
  const expiresAt = now + config.sessionDays * 24 * 60 * 60 * 1000;
  if (!store.createSession(sessionId, { name, role }, expiresAt)) return undefined;
  const identity = store.getSession(sessionId);
  return identity ? { sessionId: token, identity } : undefined;
}

export function sessionDigest(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex');
}
