import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import type { BoardAsset, BoardImage, BoardLayer, BoardSnapshot, BoardSticker, CropRect, LayerAudience, NoteAccess, NoteListItem, NoteMarker, NoteRecord, StickerBackground, StickerTextColor } from '../src/shared/board.js';

export type Role = 'gm' | 'player';
export interface Identity { participantId: string; name: string; role: Role }
export type NewIdentity = Omit<Identity, 'participantId'>;
export interface AssetInput { id: string; sha256: string; mimeType: BoardAsset['mimeType']; originalName: string; size: number; width: number; height: number }
export interface LayerPatch { name?: string; visible?: boolean; locked?: boolean; audience?: LayerAudience }
export interface ObjectPatch {
  x?: number; y?: number; width?: number; height?: number; layerId?: string;
  flipX?: boolean; flipY?: boolean; crop?: CropRect | null; allowPlayerMove?: boolean; freeStretch?: boolean; orderIndex?: number;
}
export interface StickerInput extends Omit<BoardSticker, 'orderIndex'> { orderIndex?: number }
export interface StickerPatch { text?: string; x?: number; y?: number; width?: number; height?: number; bgColor?: StickerBackground; textColor?: StickerTextColor; fontSize?: number; layerId?: string }
export interface NoteInput { id: string; title: string; body: string; access: NoteAccess; selectedParticipantIds: string[]; creatorId: string; assetIds: string[]; markerType?: 'text' | 'image'; markerText?: string; markerAssetId?: string }
export interface NotePatch { title: string; body: string; access: NoteAccess; selectedParticipantIds: string[]; assetIds: string[]; markerType: 'text' | 'image'; markerText: string; markerAssetId?: string }
export interface NoteMarkerInput { id: string; noteId: string; layerId: string; x: number; y: number }

type LayerRow = { id: string; name: string; order_index: number; visible: number; locked: number; audience: LayerAudience };
type ObjectRow = {
  id: string; asset_id: string; layer_id: string; x: number; y: number; width: number; height: number;
  order_index: number; flip_x: number; flip_y: number; crop_json: string | null; allow_player_move: number; free_stretch: number;
};
type AssetRow = { id: string; sha256: string; mime_type: BoardAsset['mimeType']; original_name: string; size: number; width: number; height: number; created_at: string };
type StickerRow = { id: string; creator_id: string; layer_id: string; text: string; x: number; y: number; width: number; height: number; bg_color: StickerBackground; text_color: StickerTextColor; font_size: number; order_index: number };
type NoteRow = { id: string; title: string; body: string; access: NoteAccess; selected_participant_ids: string; created_by: string; created_at: string; updated_at: string; marker_id?: string; marker_type: 'text' | 'image'; marker_text: string | null; marker_asset_id: string | null };
type NoteMarkerRow = { id: string; note_id: string; layer_id: string; x: number; y: number; order_index: number; title: string; marker_type: 'text' | 'image'; marker_text: string | null; marker_asset_id: string | null; asset_width: number | null; asset_height: number | null };

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
    freeStretch: row.free_stretch === 1,
  };
}
function toAsset(row: AssetRow): BoardAsset {
  return { id: row.id, sha256: row.sha256, mimeType: row.mime_type, originalName: row.original_name, size: row.size, width: row.width, height: row.height, createdAt: row.created_at };
}
function toSticker(row: StickerRow): BoardSticker {
  return { id: row.id, creatorId: row.creator_id, layerId: row.layer_id, text: row.text, x: row.x, y: row.y, width: row.width, height: row.height, bgColor: row.bg_color, textColor: row.text_color, fontSize: row.font_size, orderIndex: row.order_index };
}
function toNoteMarker(row: NoteMarkerRow): NoteMarker {
  return { id: row.id, noteId: row.note_id, layerId: row.layer_id, x: row.x, y: row.y, orderIndex: row.order_index, type: row.marker_type, text: row.marker_text || row.title, ...(row.marker_asset_id ? { assetId: row.marker_asset_id, assetWidth: row.asset_width || 1, assetHeight: row.asset_height || 1 } : {}) };
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
        allow_player_stickers INTEGER NOT NULL DEFAULT 0 CHECK (allow_player_stickers IN (0, 1)),
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
        allow_player_move INTEGER NOT NULL DEFAULT 0 CHECK (allow_player_move IN (0, 1)),
        free_stretch INTEGER NOT NULL DEFAULT 0 CHECK (free_stretch IN (0, 1))
      );
      CREATE INDEX IF NOT EXISTS board_objects_layer_order ON board_objects(layer_id, order_index);
      CREATE INDEX IF NOT EXISTS board_objects_asset ON board_objects(asset_id);
      CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        access TEXT NOT NULL CHECK (access IN ('gm-only', 'all-players', 'selected-players')),
        selected_participant_ids TEXT NOT NULL DEFAULT '[]',
        marker_type TEXT NOT NULL DEFAULT 'text' CHECK (marker_type IN ('text', 'image')),
        marker_text TEXT,
        marker_asset_id TEXT REFERENCES assets(id) ON DELETE RESTRICT,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS note_assets (
        note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
        asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
        order_index INTEGER NOT NULL,
        PRIMARY KEY (note_id, asset_id)
      );
      CREATE INDEX IF NOT EXISTS note_assets_asset ON note_assets(asset_id);
      CREATE TABLE IF NOT EXISTS note_markers (
        id TEXT PRIMARY KEY,
        note_id TEXT NOT NULL UNIQUE REFERENCES notes(id) ON DELETE CASCADE,
        layer_id TEXT NOT NULL REFERENCES board_layers(id) ON DELETE RESTRICT,
        x REAL NOT NULL,
        y REAL NOT NULL,
        order_index INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS note_markers_layer_order ON note_markers(layer_id, order_index);
      CREATE TABLE IF NOT EXISTS stickers (
        id TEXT PRIMARY KEY,
        creator_id TEXT NOT NULL,
        layer_id TEXT NOT NULL REFERENCES board_layers(id) ON DELETE RESTRICT,
        text TEXT NOT NULL,
        x REAL NOT NULL,
        y REAL NOT NULL,
        width REAL NOT NULL,
        height REAL NOT NULL,
        bg_color TEXT NOT NULL CHECK (bg_color IN ('butter', 'rose', 'sky', 'sage')),
        text_color TEXT NOT NULL CHECK (text_color IN ('black', 'white')),
        font_size INTEGER NOT NULL,
        order_index INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS stickers_layer_order ON stickers(layer_id, order_index);
    `);
    const stickerSchema = this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'stickers'").get() as { sql: string } | undefined;
    if (stickerSchema && !stickerSchema.sql.includes("'black'")) {
      const migrateStickerColors = this.db.transaction(() => {
        this.db.exec('DROP INDEX IF EXISTS stickers_layer_order');
        this.db.exec('ALTER TABLE stickers RENAME TO stickers_legacy_colors');
        this.db.exec(`CREATE TABLE stickers (
          id TEXT PRIMARY KEY, creator_id TEXT NOT NULL, layer_id TEXT NOT NULL REFERENCES board_layers(id) ON DELETE RESTRICT,
          text TEXT NOT NULL, x REAL NOT NULL, y REAL NOT NULL, width REAL NOT NULL, height REAL NOT NULL,
          bg_color TEXT NOT NULL CHECK (bg_color IN ('butter', 'rose', 'sky', 'sage')),
          text_color TEXT NOT NULL CHECK (text_color IN ('black', 'white')), font_size INTEGER NOT NULL, order_index INTEGER NOT NULL
        )`);
        this.db.exec(`INSERT INTO stickers (id, creator_id, layer_id, text, x, y, width, height, bg_color, text_color, font_size, order_index)
          SELECT id, creator_id, layer_id, text, x, y, width, height, bg_color, CASE text_color WHEN 'plum' THEN 'white' ELSE 'black' END, font_size, order_index FROM stickers_legacy_colors`);
        this.db.exec('DROP TABLE stickers_legacy_colors');
        this.db.exec('CREATE INDEX stickers_layer_order ON stickers(layer_id, order_index)');
      });
      migrateStickerColors();
    }
    const objectColumns = this.db.pragma('table_info(board_objects)') as Array<{ name: string }>;
    if (!objectColumns.some((column) => column.name === 'free_stretch')) {
      this.db.exec('ALTER TABLE board_objects ADD COLUMN free_stretch INTEGER NOT NULL DEFAULT 0 CHECK (free_stretch IN (0, 1))');
    }
    const roomColumns = this.db.pragma('table_info(room)') as Array<{ name: string }>;
    if (!roomColumns.some((column) => column.name === 'allow_player_stickers')) {
      this.db.exec('ALTER TABLE room ADD COLUMN allow_player_stickers INTEGER NOT NULL DEFAULT 0 CHECK (allow_player_stickers IN (0, 1))');
    }
    const noteColumns = this.db.pragma('table_info(notes)') as Array<{ name: string }>;
    if (!noteColumns.some((column) => column.name === 'marker_type')) this.db.exec("ALTER TABLE notes ADD COLUMN marker_type TEXT NOT NULL DEFAULT 'text' CHECK (marker_type IN ('text', 'image'))");
    if (!noteColumns.some((column) => column.name === 'marker_text')) this.db.exec('ALTER TABLE notes ADD COLUMN marker_text TEXT');
    if (!noteColumns.some((column) => column.name === 'marker_asset_id')) this.db.exec('ALTER TABLE notes ADD COLUMN marker_asset_id TEXT REFERENCES assets(id) ON DELETE RESTRICT');
    this.db.prepare('INSERT OR IGNORE INTO room (id, name) VALUES (1, ?)').run(roomName);
    const layerCount = (this.db.prepare('SELECT COUNT(*) AS count FROM board_layers').get() as { count: number }).count;
    if (layerCount === 0) this.createLayer('Основной слой', 'all-players');
  }

  get roomName(): string {
    return (this.db.prepare('SELECT name FROM room WHERE id = 1').get() as { name: string }).name;
  }

  createSession(sessionId: string, identity: NewIdentity, expiresAt: number): boolean {
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
    if (identity.role === 'gm' && this.db.prepare("SELECT 1 FROM sessions WHERE role = 'gm' LIMIT 1").get()) return false;
    this.db.prepare('INSERT INTO sessions (id, name, role, expires_at) VALUES (?, ?, ?, ?)')
      .run(sessionId, identity.name, identity.role, expiresAt);
    return true;
  }

  getSession(sessionId: string): Identity | undefined {
    const row = this.db.prepare('SELECT id, name, role, expires_at FROM sessions WHERE id = ?').get(sessionId) as
      { id: string; name: string; role: Role; expires_at: number } | undefined;
    if (!row) return undefined;
    if (row.expires_at <= Date.now()) { this.deleteSession(sessionId); return undefined; }
    return { participantId: row.id, name: row.name, role: row.role };
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
    return (this.db.prepare(`SELECT
      (SELECT COUNT(*) FROM board_objects WHERE layer_id = ?) +
      (SELECT COUNT(*) FROM stickers WHERE layer_id = ?) +
      (SELECT COUNT(*) FROM note_markers WHERE layer_id = ?) AS count`).get(layerId, layerId, layerId) as { count: number }).count;
  }
  deleteLayer(id: string, targetLayerId?: string, deleteObjects = false): void {
    const transaction = this.db.transaction(() => {
      if (targetLayerId) {
        this.db.prepare('UPDATE board_objects SET layer_id = ? WHERE layer_id = ?').run(targetLayerId, id);
        this.db.prepare('UPDATE stickers SET layer_id = ? WHERE layer_id = ?').run(targetLayerId, id);
        this.db.prepare('UPDATE note_markers SET layer_id = ? WHERE layer_id = ?').run(targetLayerId, id);
      } else if (deleteObjects) {
        this.db.prepare('DELETE FROM board_objects WHERE layer_id = ?').run(id);
        this.db.prepare('DELETE FROM stickers WHERE layer_id = ?').run(id);
        this.db.prepare('DELETE FROM note_markers WHERE layer_id = ?').run(id);
      }
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
      (id, asset_id, layer_id, x, y, width, height, order_index, flip_x, flip_y, crop_json, allow_player_move, free_stretch)
      VALUES (@id, @assetId, @layerId, @x, @y, @width, @height, @orderIndex, @flipX, @flipY, @crop, @allowPlayerMove, @freeStretch)`)
      .run({ ...object, flipX: Number(object.flipX), flipY: Number(object.flipY), crop: object.crop ? JSON.stringify(object.crop) : null, allowPlayerMove: Number(object.allowPlayerMove), freeStretch: Number(object.freeStretch) });
  }
  updateObject(id: string, patch: ObjectPatch): void {
    const columns: Record<keyof ObjectPatch, string> = {
      x: 'x', y: 'y', width: 'width', height: 'height', layerId: 'layer_id', flipX: 'flip_x', flipY: 'flip_y',
      crop: 'crop_json', allowPlayerMove: 'allow_player_move', freeStretch: 'free_stretch', orderIndex: 'order_index',
    };
    const entries = Object.entries(patch) as Array<[keyof ObjectPatch, ObjectPatch[keyof ObjectPatch]]>;
    if (entries.length === 0) return;
    this.db.prepare(`UPDATE board_objects SET ${entries.map(([key]) => `${columns[key]} = @${key}`).join(', ')} WHERE id = @id`)
      .run({ id, ...Object.fromEntries(entries.map(([key, value]) => [
        key, key === 'flipX' || key === 'flipY' || key === 'allowPlayerMove' || key === 'freeStretch' ? Number(value) : key === 'crop' ? value ? JSON.stringify(value) : null : value,
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

  createNote(note: NoteInput): void {
    const transaction = this.db.transaction(() => {
      this.db.prepare('INSERT INTO notes (id, title, body, access, selected_participant_ids, created_by, marker_type, marker_text, marker_asset_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(note.id, note.title, note.body, note.access, JSON.stringify(note.selectedParticipantIds), note.creatorId, note.markerType || 'text', note.markerText || null, note.markerAssetId || null);
      const insertAsset = this.db.prepare('INSERT INTO note_assets (note_id, asset_id, order_index) VALUES (?, ?, ?)');
      note.assetIds.forEach((assetId, index) => insertAsset.run(note.id, assetId, index));
    });
    transaction();
  }
  updateNote(id: string, patch: NotePatch): void {
    const transaction = this.db.transaction(() => {
      this.db.prepare(`UPDATE notes SET title = ?, body = ?, access = ?, selected_participant_ids = ?, marker_type = ?, marker_text = ?, marker_asset_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(patch.title, patch.body, patch.access, JSON.stringify(patch.selectedParticipantIds), patch.markerType, patch.markerText || null, patch.markerAssetId || null, id);
      this.db.prepare('DELETE FROM note_assets WHERE note_id = ?').run(id);
      const insertAsset = this.db.prepare('INSERT INTO note_assets (note_id, asset_id, order_index) VALUES (?, ?, ?)');
      patch.assetIds.forEach((assetId, index) => insertAsset.run(id, assetId, index));
    });
    transaction();
  }
  deleteNote(id: string): void { this.db.prepare('DELETE FROM notes WHERE id = ?').run(id); }
  getNote(id: string): NoteRecord | undefined {
    const row = this.db.prepare('SELECT * FROM notes WHERE id = ?').get(id) as NoteRow | undefined;
    if (!row) return undefined;
    const images = this.db.prepare(`SELECT asset.id, asset.original_name, asset.width, asset.height FROM note_assets AS attachment
      JOIN assets AS asset ON asset.id = attachment.asset_id WHERE attachment.note_id = ? ORDER BY attachment.order_index`)
      .all(id) as NoteRecord['images'];
    const assetIds = this.db.prepare('SELECT asset_id FROM note_assets WHERE note_id = ? ORDER BY order_index').all(id) as Array<{ asset_id: string }>;
    let selectedParticipantIds: string[] = [];
    try {
      const parsed = JSON.parse(row.selected_participant_ids) as unknown;
      if (Array.isArray(parsed)) selectedParticipantIds = parsed.filter((value): value is string => typeof value === 'string');
    } catch { /* Invalid legacy access metadata grants no player access. */ }
    return {
      id: row.id, title: row.title, body: row.body, access: row.access,
      selectedParticipantIds, assetIds: assetIds.map((asset) => asset.asset_id),
      createdAt: row.created_at, updatedAt: row.updated_at, images,
      markerType: row.marker_type || 'text', markerText: row.marker_text || row.title,
      ...(row.marker_asset_id ? { markerAssetId: row.marker_asset_id } : {}),
    };
  }
  listNotes(): NoteListItem[] {
    const rows = this.db.prepare(`SELECT note.id, note.title, note.access, note.updated_at, marker.id AS marker_id
      FROM notes AS note LEFT JOIN note_markers AS marker ON marker.note_id = note.id
      ORDER BY note.updated_at DESC, note.created_at DESC`).all() as NoteRow[];
    return rows.map((row) => ({ id: row.id, title: row.title, access: row.access, updatedAt: row.updated_at, ...(row.marker_id ? { markerId: row.marker_id } : {}) }));
  }
  canReadNote(id: string, identity: Identity): boolean {
    if (identity.role === 'gm') return Boolean(this.db.prepare('SELECT 1 FROM notes WHERE id = ?').get(id));
    const row = this.db.prepare('SELECT access, selected_participant_ids FROM notes WHERE id = ?').get(id) as { access: NoteAccess; selected_participant_ids: string } | undefined;
    if (!row) return false;
    if (row.access === 'all-players') return true;
    if (row.access !== 'selected-players') return false;
    try { return (JSON.parse(row.selected_participant_ids) as unknown[]).includes(identity.participantId); }
    catch { return false; }
  }
  isPlayerParticipant(participantId: string): boolean {
    const identity = this.getSession(participantId);
    return identity?.role === 'player';
  }
  canReadAsset(assetId: string, identity: Identity): boolean {
    if (!this.getAsset(assetId)) return false;
    if (identity.role === 'gm') return true;
    if (this.isAssetUsedByPublicObject(assetId)) return true;
    const noteIds = this.db.prepare('SELECT note_id FROM note_assets WHERE asset_id = ?').all(assetId) as Array<{ note_id: string }>;
    const markerNoteIds = this.db.prepare("SELECT id AS note_id FROM notes WHERE marker_asset_id = ? AND marker_type = 'image'").all(assetId) as Array<{ note_id: string }>;
    return [...noteIds, ...markerNoteIds].some(({ note_id }) => this.canReadNote(note_id, identity));
  }
  getNoteMarker(id: string): NoteMarker | undefined {
    const row = this.db.prepare(`SELECT marker.*, note.title, note.marker_type, note.marker_text, note.marker_asset_id, asset.width AS asset_width, asset.height AS asset_height FROM note_markers AS marker JOIN notes AS note ON note.id = marker.note_id LEFT JOIN assets AS asset ON asset.id = note.marker_asset_id WHERE marker.id = ?`).get(id) as NoteMarkerRow | undefined;
    return row ? toNoteMarker(row) : undefined;
  }
  getNoteMarkers(): NoteMarker[] {
    return (this.db.prepare(`SELECT marker.*, note.title, note.marker_type, note.marker_text, note.marker_asset_id, asset.width AS asset_width, asset.height AS asset_height FROM note_markers AS marker JOIN notes AS note ON note.id = marker.note_id LEFT JOIN assets AS asset ON asset.id = note.marker_asset_id ORDER BY marker.order_index`).all() as NoteMarkerRow[]).map(toNoteMarker);
  }
  createNoteMarker(marker: NoteMarkerInput): void {
    const orderIndex = (this.db.prepare('SELECT COALESCE(MAX(order_index), -1) + 1 AS next FROM note_markers WHERE layer_id = ?').get(marker.layerId) as { next: number }).next;
    this.db.prepare('INSERT INTO note_markers (id, note_id, layer_id, x, y, order_index) VALUES (?, ?, ?, ?, ?, ?)')
      .run(marker.id, marker.noteId, marker.layerId, marker.x, marker.y, orderIndex);
  }
  updateNoteMarker(id: string, patch: Partial<Pick<NoteMarker, 'layerId' | 'x' | 'y'>>): void {
    const columns = { layerId: 'layer_id', x: 'x', y: 'y' } as const;
    const entries = Object.entries(patch) as Array<[keyof typeof columns, string | number]>;
    if (!entries.length) return;
    this.db.prepare(`UPDATE note_markers SET ${entries.map(([key]) => `${columns[key]} = @${key}`).join(', ')} WHERE id = @id`)
      .run({ id, ...Object.fromEntries(entries) });
  }
  deleteNoteMarker(id: string): void { this.db.prepare('DELETE FROM note_markers WHERE id = ?').run(id); }

  getSticker(id: string): BoardSticker | undefined {
    const row = this.db.prepare('SELECT * FROM stickers WHERE id = ?').get(id) as StickerRow | undefined;
    return row ? toSticker(row) : undefined;
  }
  getStickers(): BoardSticker[] {
    return (this.db.prepare('SELECT * FROM stickers ORDER BY order_index').all() as StickerRow[]).map(toSticker);
  }
  createSticker(sticker: StickerInput): void {
    const orderIndex = sticker.orderIndex ?? (this.db.prepare('SELECT COALESCE(MAX(order_index), -1) + 1 AS next FROM stickers WHERE layer_id = ?').get(sticker.layerId) as { next: number }).next;
    this.db.prepare(`INSERT INTO stickers (id, creator_id, layer_id, text, x, y, width, height, bg_color, text_color, font_size, order_index)
      VALUES (@id, @creatorId, @layerId, @text, @x, @y, @width, @height, @bgColor, @textColor, @fontSize, @orderIndex)`)
      .run({ ...sticker, orderIndex });
  }
  updateSticker(id: string, patch: StickerPatch): void {
    const columns: Record<keyof StickerPatch, string> = { text: 'text', x: 'x', y: 'y', width: 'width', height: 'height', bgColor: 'bg_color', textColor: 'text_color', fontSize: 'font_size', layerId: 'layer_id' };
    const entries = Object.entries(patch) as Array<[keyof StickerPatch, StickerPatch[keyof StickerPatch]]>;
    if (!entries.length) return;
    this.db.prepare(`UPDATE stickers SET ${entries.map(([key]) => `${columns[key]} = @${key}`).join(', ')} WHERE id = @id`)
      .run({ id, ...Object.fromEntries(entries) });
  }
  deleteSticker(id: string): void { this.db.prepare('DELETE FROM stickers WHERE id = ?').run(id); }

  snapshot(identityOrRole: Identity | Role, participantId = ''): BoardSnapshot {
    const role = typeof identityOrRole === 'string' ? identityOrRole : identityOrRole.role;
    const identity = typeof identityOrRole === 'string' ? { participantId, name: '', role } : identityOrRole;
    const allLayers = this.getLayers();
    if (role === 'gm') return { layers: allLayers, objects: this.getObjects(), stickers: this.getStickers(), noteMarkers: this.getNoteMarkers(), assets: this.getAssets() };
    const layers = this.getLayers().filter((layer) => layer.audience === 'all-players' && layer.visible);
    const visibleIds = new Set(layers.map((layer) => layer.id));
    const stickers = this.getStickers().filter((sticker) => visibleIds.has(sticker.layerId));
    const noteMarkers = this.getNoteMarkers().filter((marker) => visibleIds.has(marker.layerId) && this.canReadNote(marker.noteId, identity));
    return { layers, objects: this.getObjects().filter((object) => visibleIds.has(object.layerId)), stickers, noteMarkers };
  }

  backup(path: string): Promise<Database.BackupMetadata> { return this.db.backup(path); }
  close(): void { this.db.close(); }
}
