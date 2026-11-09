import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import type { BoardAsset, BoardImage, BoardLayer, BoardSnapshot, CropRect, LayerAudience } from '../src/shared/board.js';

export type Role = 'gm' | 'player';
export interface Identity { name: string; role: Role }
export interface AssetInput { id: string; sha256: string; mimeType: BoardAsset['mimeType']; originalName: string; size: number; width: number; height: number }
export interface LayerPatch { name?: string; visible?: boolean; locked?: boolean; audience?: LayerAudience }
export interface ObjectPatch {
  x?: number; y?: number; width?: number; height?: number; layerId?: string;
  flipX?: boolean; flipY?: boolean; crop?: CropRect | null; allowPlayerMove?: boolean; orderIndex?: number;
}

type LayerRow = { id: string; name: string; order_index: number; visible: number; locked: number; audience: LayerAudience };
type ObjectRow = {
  id: string; asset_id: string; layer_id: string; x: number; y: number; width: number; height: number;
  order_index: number; flip_x: number; flip_y: number; crop_json: string | null; allow_player_move: number;
};
type AssetRow = { id: string; sha256: string; mime_type: BoardAsset['mimeType']; original_name: string; size: number; width: number; height: number; created_at: string };

function toLayer(row: LayerRow): BoardLayer {
  return { id: row.id, name: row.name, orderIndex: row.order_index, visible: row.visible === 1, locked: row.locked === 1, audience: row.audience };
}
function toObject(row: ObjectRow): BoardImage {
  return {
    id: row.id, assetId: row.asset_id, layerId: row.layer_id, x: row.x, y: row.y,
    width: row.width, height: row.height, orderIndex: row.order_index,
    flipX: row.flip_x === 1, flipY: row.flip_y === 1,
    crop: row.crop_json ? JSON.parse(row.crop_json) as CropRect : null,
    allowPlayerMove: row.allow_player_move === 1,
  };
}
function toAsset(row: AssetRow): BoardAsset {
  return { id: row.id, sha256: row.sha256, mimeType: row.mime_type, originalName: row.original_name, size: row.size, width: row.width, height: row.height, createdAt: row.created_at };
}

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
      CREATE TABLE IF NOT EXISTS board_layers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        order_index INTEGER NOT NULL,
        visible INTEGER NOT NULL CHECK (visible IN (0, 1)),
        locked INTEGER NOT NULL CHECK (locked IN (0, 1)),
        audience TEXT NOT NULL CHECK (audience IN ('gm-only', 'all-players'))
      );
      CREATE TABLE IF NOT EXISTS assets (
        id TEXT PRIMARY KEY,
        sha256 TEXT NOT NULL,
        mime_type TEXT NOT NULL CHECK (mime_type IN ('image/png', 'image/jpeg', 'image/webp')),
        original_name TEXT NOT NULL,
        size INTEGER NOT NULL,
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (sha256, mime_type)
      );
      CREATE TABLE IF NOT EXISTS board_objects (
        id TEXT PRIMARY KEY,
        asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
        layer_id TEXT NOT NULL REFERENCES board_layers(id) ON DELETE RESTRICT,
        x REAL NOT NULL,
        y REAL NOT NULL,
        width REAL NOT NULL,
        height REAL NOT NULL,
        order_index INTEGER NOT NULL,
        flip_x INTEGER NOT NULL DEFAULT 0 CHECK (flip_x IN (0, 1)),
        flip_y INTEGER NOT NULL DEFAULT 0 CHECK (flip_y IN (0, 1)),
        crop_json TEXT,
        allow_player_move INTEGER NOT NULL DEFAULT 0 CHECK (allow_player_move IN (0, 1))
      );
      CREATE INDEX IF NOT EXISTS board_objects_layer_order ON board_objects(layer_id, order_index);
      CREATE INDEX IF NOT EXISTS board_objects_asset ON board_objects(asset_id);
    `);
    this.db.prepare('INSERT OR IGNORE INTO room (id, name) VALUES (1, ?)').run(roomName);
    const layerCount = (this.db.prepare('SELECT COUNT(*) AS count FROM board_layers').get() as { count: number }).count;
    if (layerCount === 0) this.createLayer('Основной слой', 'all-players');
  }

  get roomName(): string {
    return (this.db.prepare('SELECT name FROM room WHERE id = 1').get() as { name: string }).name;
  }

  createSession(sessionId: string, identity: Identity, expiresAt: number): boolean {
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
    if (identity.role === 'gm' && this.db.prepare("SELECT 1 FROM sessions WHERE role = 'gm' LIMIT 1").get()) return false;
    this.db.prepare('INSERT INTO sessions (id, name, role, expires_at) VALUES (?, ?, ?, ?)')
      .run(sessionId, identity.name, identity.role, expiresAt);
    return true;
  }

  getSession(sessionId: string): Identity | undefined {
    const row = this.db.prepare('SELECT name, role, expires_at FROM sessions WHERE id = ?').get(sessionId) as
      { name: string; role: Role; expires_at: number } | undefined;
    if (!row) return undefined;
    if (row.expires_at <= Date.now()) { this.deleteSession(sessionId); return undefined; }
    return { name: row.name, role: row.role };
  }

  deleteSession(sessionId: string): void { this.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId); }

  getLayers(): BoardLayer[] {
    return (this.db.prepare('SELECT * FROM board_layers ORDER BY order_index ASC').all() as LayerRow[]).map(toLayer);
  }
  getLayer(id: string): BoardLayer | undefined {
    const row = this.db.prepare('SELECT * FROM board_layers WHERE id = ?').get(id) as LayerRow | undefined;
    return row ? toLayer(row) : undefined;
  }
  createLayer(name: string, audience: LayerAudience = 'all-players'): BoardLayer {
    const id = randomUUID();
    const orderIndex = (this.db.prepare('SELECT COALESCE(MAX(order_index), -1) + 1 AS next FROM board_layers').get() as { next: number }).next;
    this.db.prepare('INSERT INTO board_layers (id, name, order_index, visible, locked, audience) VALUES (?, ?, ?, 1, 0, ?)')
      .run(id, name, orderIndex, audience);
    return this.getLayer(id)!;
  }
  updateLayer(id: string, patch: LayerPatch): void {
    const columns: Record<keyof LayerPatch, string> = { name: 'name', visible: 'visible', locked: 'locked', audience: 'audience' };
    const entries = Object.entries(patch) as Array<[keyof LayerPatch, LayerPatch[keyof LayerPatch]]>;
    if (entries.length === 0) return;
    this.db.prepare(`UPDATE board_layers SET ${entries.map(([key]) => `${columns[key]} = @${key}`).join(', ')} WHERE id = @id`)
      .run({ id, ...Object.fromEntries(entries.map(([key, value]) => [key, typeof value === 'boolean' ? Number(value) : value])) });
  }
  reorderLayers(ids: string[]): void {
    const update = this.db.prepare('UPDATE board_layers SET order_index = ? WHERE id = ?');
    const transaction = this.db.transaction((layerIds: string[]) => layerIds.forEach((id, index) => update.run(index, id)));
    transaction(ids);
  }
  countObjectsInLayer(layerId: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS count FROM board_objects WHERE layer_id = ?').get(layerId) as { count: number }).count;
  }
  deleteLayer(id: string, targetLayerId?: string, deleteObjects = false): void {
    const transaction = this.db.transaction(() => {
      if (targetLayerId) this.db.prepare('UPDATE board_objects SET layer_id = ? WHERE layer_id = ?').run(targetLayerId, id);
      else if (deleteObjects) this.db.prepare('DELETE FROM board_objects WHERE layer_id = ?').run(id);
      this.db.prepare('DELETE FROM board_layers WHERE id = ?').run(id);
      const rows = this.db.prepare('SELECT id FROM board_layers ORDER BY order_index ASC').all() as Array<{ id: string }>;
      const update = this.db.prepare('UPDATE board_layers SET order_index = ? WHERE id = ?');
      rows.forEach((row, index) => update.run(index, row.id));
    });
    transaction();
  }

  findAsset(sha256: string, mimeType: BoardAsset['mimeType']): BoardAsset | undefined {
    const row = this.db.prepare('SELECT * FROM assets WHERE sha256 = ? AND mime_type = ?').get(sha256, mimeType) as AssetRow | undefined;
    return row ? toAsset(row) : undefined;
  }
  getAsset(id: string): BoardAsset | undefined {
    const row = this.db.prepare('SELECT * FROM assets WHERE id = ?').get(id) as AssetRow | undefined;
    return row ? toAsset(row) : undefined;
  }
  createAsset(asset: AssetInput): void {
    this.db.prepare('INSERT INTO assets (id, sha256, mime_type, original_name, size, width, height) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(asset.id, asset.sha256, asset.mimeType, asset.originalName, asset.size, asset.width, asset.height);
  }
  getAssets(): BoardAsset[] {
    return (this.db.prepare('SELECT * FROM assets ORDER BY created_at DESC, id DESC').all() as AssetRow[]).map(toAsset);
  }
  isAssetUsedByPublicObject(assetId: string): boolean {
    return Boolean(this.db.prepare(`
      SELECT 1 FROM board_objects AS object
      JOIN board_layers AS layer ON layer.id = object.layer_id
      WHERE object.asset_id = ? AND layer.audience = 'all-players' AND layer.visible = 1
      LIMIT 1
    `).get(assetId));
  }

  getObjects(): BoardImage[] {
    return (this.db.prepare('SELECT * FROM board_objects ORDER BY order_index ASC').all() as ObjectRow[]).map(toObject);
  }
  getObject(id: string): BoardImage | undefined {
    const row = this.db.prepare('SELECT * FROM board_objects WHERE id = ?').get(id) as ObjectRow | undefined;
    return row ? toObject(row) : undefined;
  }
  createObject(object: BoardImage): void {
    this.db.prepare(`INSERT INTO board_objects
      (id, asset_id, layer_id, x, y, width, height, order_index, flip_x, flip_y, crop_json, allow_player_move)
      VALUES (@id, @assetId, @layerId, @x, @y, @width, @height, @orderIndex, @flipX, @flipY, @crop, @allowPlayerMove)`)
      .run({ ...object, flipX: Number(object.flipX), flipY: Number(object.flipY), crop: object.crop ? JSON.stringify(object.crop) : null, allowPlayerMove: Number(object.allowPlayerMove) });
  }
  updateObject(id: string, patch: ObjectPatch): void {
    const columns: Record<keyof ObjectPatch, string> = {
      x: 'x', y: 'y', width: 'width', height: 'height', layerId: 'layer_id', flipX: 'flip_x', flipY: 'flip_y',
      crop: 'crop_json', allowPlayerMove: 'allow_player_move', orderIndex: 'order_index',
    };
    const entries = Object.entries(patch) as Array<[keyof ObjectPatch, ObjectPatch[keyof ObjectPatch]]>;
    if (entries.length === 0) return;
    this.db.prepare(`UPDATE board_objects SET ${entries.map(([key]) => `${columns[key]} = @${key}`).join(', ')} WHERE id = @id`)
      .run({ id, ...Object.fromEntries(entries.map(([key, value]) => [
        key, key === 'flipX' || key === 'flipY' || key === 'allowPlayerMove' ? Number(value) : key === 'crop' ? value ? JSON.stringify(value) : null : value,
      ])) });
  }
  deleteObject(id: string): void { this.db.prepare('DELETE FROM board_objects WHERE id = ?').run(id); }
  nextObjectOrder(layerId: string): number {
    return (this.db.prepare('SELECT COALESCE(MAX(order_index), -1) + 1 AS next FROM board_objects WHERE layer_id = ?').get(layerId) as { next: number }).next;
  }
  getVisibleObjects(): BoardImage[] {
    return (this.db.prepare(`SELECT object.* FROM board_objects AS object
      JOIN board_layers AS layer ON layer.id = object.layer_id
      WHERE layer.audience = 'all-players' AND layer.visible = 1
      ORDER BY object.order_index ASC`).all() as ObjectRow[]).map(toObject);
  }
  reorderObject(id: string, direction: 'front' | 'back'): void {
    const object = this.getObject(id);
    if (!object) return;
    const next = direction === 'front' ? this.nextObjectOrder(object.layerId) :
      (this.db.prepare('SELECT COALESCE(MIN(order_index), 0) - 1 AS next FROM board_objects WHERE layer_id = ?').get(object.layerId) as { next: number }).next;
    this.updateObject(id, { orderIndex: next });
  }

  snapshot(role: Role): BoardSnapshot {
    if (role === 'gm') return { layers: this.getLayers(), objects: this.getObjects(), assets: this.getAssets() };
    const layers = this.getLayers().filter((layer) => layer.audience === 'all-players' && layer.visible);
    const visibleIds = new Set(layers.map((layer) => layer.id));
    return { layers, objects: this.getObjects().filter((object) => visibleIds.has(object.layerId)) };
  }

  backup(path: string): Promise<Database.BackupMetadata> { return this.db.backup(path); }
  close(): void { this.db.close(); }
}
