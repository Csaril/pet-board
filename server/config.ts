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
  };
}
