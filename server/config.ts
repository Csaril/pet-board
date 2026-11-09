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
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const roomCode = env.ROOM_CODE?.trim();
  const gmPassword = env.GM_PASSWORD;
  if (!roomCode || roomCode.length < 12) {
    throw new Error('ROOM_CODE is required and must contain at least 12 characters.');
  }
  if (!gmPassword || gmPassword.length < 12) {
    throw new Error('GM_PASSWORD is required and must contain at least 12 characters.');
  }
  const port = Number(env.PORT ?? 4321);
  const sessionDays = Number(env.SESSION_DAYS ?? 30);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
  if (!Number.isInteger(sessionDays) || sessionDays < 1 || sessionDays > 365) throw new Error('SESSION_DAYS must be between 1 and 365.');

  return {
    host: env.HOST ?? '127.0.0.1',
    port,
    dataDir: resolve(env.APP_DATA_DIR ?? './data'),
    roomName: env.ROOM_NAME?.trim() || 'Игровая комната',
    roomCode,
    gmPassword,
    sessionDays,
    cookieSecure: env.NODE_ENV === 'production',
  };
}
