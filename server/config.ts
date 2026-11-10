import 'dotenv/config';
import { resolve } from 'node:path';

export interface AppConfig {
  host: string;
  port: number;
  dataDir: string;
  roomName: string;
  roomCode: string;
  gmPassword: string;
  sessionDays: number;
  cookieSecure: boolean;
  maxUploadBytes: number;
  /** Extra browser origins allowed to call the HTTP API and open the WebSocket. */
  publicOrigins?: string[];
  /** Trust X-Forwarded-* headers. Only enable when the server is reachable exclusively through a local proxy. */
  trustProxy?: boolean;
}

function normalizeOrigin(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) return undefined;
    return url.origin.toLowerCase();
  } catch {
    return undefined;
  }
}

function parsePublicOrigins(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  const origins = raw.split(',').map((entry) => entry.trim()).filter(Boolean);
  const normalized: string[] = [];
  for (const origin of origins) {
    const value = normalizeOrigin(origin);
    if (!value) throw new Error('PUBLIC_ORIGIN must contain only http(s) origins, separated by commas.');
    normalized.push(value);
  }
  return [...new Set(normalized)];
}

function parseTrustProxy(raw: string | undefined): boolean {
  if (raw === undefined || raw.trim() === '') return false;
  const value = raw.trim().toLowerCase();
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new Error('TRUST_PROXY must be true or false.');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const rawRoomCode = env.ROOM_CODE?.trim();
  const gmPassword = env.GM_PASSWORD;
  const shortRoomCodePattern = /^[A-HJ-NP-Z2-9]{6,8}$/i;
  const legacyRoomCode = Boolean(rawRoomCode && rawRoomCode.length >= 12);
  if (!rawRoomCode || (!shortRoomCodePattern.test(rawRoomCode) && !legacyRoomCode)) {
    throw new Error('ROOM_CODE must be 6–8 letters/digits (excluding O, 0, I and 1), or a legacy code of at least 12 characters.');
  }
  if (!gmPassword || gmPassword.length < 10) {
    throw new Error('GM_PASSWORD is required and must contain at least 10 characters.');
  }
  const port = Number(env.PORT ?? 4321);
  const sessionDays = Number(env.SESSION_DAYS ?? 30);
  const maxUploadMb = Number(env.MAX_UPLOAD_MB ?? 25);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
  if (!Number.isInteger(sessionDays) || sessionDays < 1 || sessionDays > 365) throw new Error('SESSION_DAYS must be between 1 and 365.');
  if (!Number.isInteger(maxUploadMb) || maxUploadMb < 1 || maxUploadMb > 250) throw new Error('MAX_UPLOAD_MB must be between 1 and 250.');

  return {
    host: env.HOST ?? '127.0.0.1',
    port,
    dataDir: resolve(env.APP_DATA_DIR ?? './data'),
    roomName: env.ROOM_NAME?.trim() || 'Игровая комната',
    roomCode: rawRoomCode.length <= 8 ? rawRoomCode.toUpperCase() : rawRoomCode,
    gmPassword,
    sessionDays,
    cookieSecure: env.NODE_ENV === 'production',
    maxUploadBytes: maxUploadMb * 1024 * 1024,
    publicOrigins: parsePublicOrigins(env.PUBLIC_ORIGIN),
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
  };
}
