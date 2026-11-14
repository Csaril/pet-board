import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AppConfig } from './config.js';
import type { CatalogRoom } from './catalog.js';
import type { RoomAccess } from './room-manager.js';
import { SingleRoomAccess } from './room-manager.js';
import type { Identity, Role, RoomStore } from './store.js';

/** Legacy cookie used by the single-room test harness. */
export const SESSION_COOKIE = 'tb_session';
/** Production cookies are scoped by room, so one browser can hold several rooms. */
export const SESSION_COOKIE_PREFIX = 'tb_session_';

function constantTimeEqual(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function sessionCookieName(roomId: string, legacy = false): string {
  return legacy ? SESSION_COOKIE : `${SESSION_COOKIE_PREFIX}${roomId}`;
}

export interface AuthenticationResult {
  sessionId: string;
  identity: Identity;
  room: CatalogRoom;
}

/**
 * Resolves the room by HMAC (inside the catalog) and only then creates a
 * session in that room's own database. Failures are deliberately
 * indistinguishable: unknown, disabled and wrong-password rooms all return
 * `undefined`.
 */
export function authenticateRoom(
  input: unknown,
  access: RoomAccess,
  sessionDays: number,
  now = Date.now(),
): AuthenticationResult | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const body = input as Record<string, unknown>;
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const submittedRoomCode = typeof body.roomCode === 'string' ? body.roomCode : '';
  const role: Role | undefined = body.role === 'gm' || body.role === 'player' ? body.role : undefined;
  if (name.length < 1 || name.length > 40 || !role || !submittedRoomCode.trim() || submittedRoomCode.length > 128) return undefined;

  const room = access.findByCode(submittedRoomCode);
  if (!room || room.status !== 'active') return undefined;
  if (role === 'gm') {
    if (typeof body.gmPassword !== 'string' || !access.verifyGmPassword(room.id, body.gmPassword)) return undefined;
  }

  const lease = access.acquire(room.id);
  try {
    const token = randomBytes(32).toString('base64url');
    const sessionId = sessionDigest(token);
    const expiresAt = now + sessionDays * 24 * 60 * 60 * 1000;
    if (!lease.store.createSession(sessionId, { name, role }, expiresAt)) return undefined;
    const identity = lease.store.getSession(sessionId);
    return identity ? { sessionId: token, identity, room } : undefined;
  } finally {
    lease.release();
  }
}

/** Legacy wrapper for the single-room tests. Production uses `authenticateRoom`. */
export function authenticate(
  input: unknown,
  config: AppConfig,
  store: RoomStore,
  now = Date.now(),
): AuthenticationResult | undefined {
  return authenticateRoom(input, new SingleRoomAccess(store, config), config.sessionDays, now);
}

export function sessionDigest(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex');
}

export function safeEqual(actual: string, expected: string): boolean {
  return constantTimeEqual(actual, expected);
}
