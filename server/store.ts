import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';

export type Role = 'gm' | 'player';
export interface Identity { name: string; role: Role }

export class RoomStore {
  readonly db: Database.Database;

  constructor(dataDir: string, roomName: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    chmodSync(dataDir, 0o700);
    const path = join(dataDir, 'room.sqlite');
    this.db = new Database(path);
    chmodSync(path, 0o600);
    this.db.pragma('journal_mode = DELETE');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS room (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('gm', 'player')),
        expires_at INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
    `);
    this.db.prepare('INSERT OR IGNORE INTO room (id, name) VALUES (1, ?)').run(roomName);
  }

  get roomName(): string {
    return (this.db.prepare('SELECT name FROM room WHERE id = 1').get() as { name: string }).name;
  }

  createSession(sessionId: string, identity: Identity, expiresAt: number): boolean {
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
    if (identity.role === 'gm') {
      const gmExists = this.db.prepare("SELECT 1 FROM sessions WHERE role = 'gm' LIMIT 1").get();
      if (gmExists) return false;
    }
    this.db.prepare('INSERT INTO sessions (id, name, role, expires_at) VALUES (?, ?, ?, ?)')
      .run(sessionId, identity.name, identity.role, expiresAt);
    return true;
  }

  getSession(sessionId: string): Identity | undefined {
    const row = this.db.prepare('SELECT name, role, expires_at FROM sessions WHERE id = ?').get(sessionId) as
      { name: string; role: Role; expires_at: number } | undefined;
    if (!row) return undefined;
    if (row.expires_at <= Date.now()) {
      this.deleteSession(sessionId);
      return undefined;
    }
    return { name: row.name, role: row.role };
  }

  deleteSession(sessionId: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
  }

  backup(path: string): Promise<Database.BackupMetadata> {
    return this.db.backup(path);
  }

  close(): void { this.db.close(); }
}
