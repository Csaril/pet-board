import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import type { BoardAsset, BoardAssetUsage, BoardAssetUsageKind, BoardBackground, BoardImage, BoardLayer, BoardSnapshot, BoardSticker, CharacterSheet, CharacterSheetAbility, CharacterSheetCounter, CropRect, DiceRollEntry, LayerAudience, NoteAccess, NoteListItem, NoteMarker, NoteRecord, SheetCharacteristicKey, StickerBackground, StickerTextColor } from '../src/shared/board.js';

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
export interface NoteMarkerInput { id: string; noteId: string; layerId: string; x: number; y: number; width?: number; height?: number }
export interface SheetInput {
  id: string; creatorId: string; creatorName: string; assignedPlayerId: string | null; assignedPlayerName: string | null;
  systemId: string; systemVersion: string; schemaVersion: number;
  characterName: string; portraitAssetId: string | null; characteristics: Record<SheetCharacteristicKey, number>; fate: number;
}
export interface SheetPatch { characterName?: string; portraitAssetId?: string | null; characteristics?: Record<SheetCharacteristicKey, number>; fate?: number }
export interface CounterPatch { name?: string; value?: number }
export interface AbilityInput { id: string; name: string; description: string; assetId: string | null; counterEnabled: boolean; counterName: string; counterValue: number; checkboxEnabled: boolean; checkboxLabel: string; checked: boolean }
export interface AbilityPatch { name?: string; description?: string; assetId?: string | null; counterEnabled?: boolean; counterName?: string; counterValue?: number; checkboxEnabled?: boolean; checkboxLabel?: string; checked?: boolean; orderIndex?: number }

type LayerRow = { id: string; name: string; order_index: number; visible: number; locked: number; audience: LayerAudience };
type ObjectRow = {
  id: string; asset_id: string; layer_id: string; x: number; y: number; width: number; height: number;
  order_index: number; flip_x: number; flip_y: number; crop_json: string | null; allow_player_move: number; free_stretch: number;
};
type AssetRow = { id: string; sha256: string; mime_type: BoardAsset['mimeType']; original_name: string; size: number; width: number; height: number; created_at: string };
type StickerRow = { id: string; creator_id: string; layer_id: string; text: string; x: number; y: number; width: number; height: number; bg_color: StickerBackground; text_color: StickerTextColor; font_size: number; order_index: number };
type NoteRow = { id: string; title: string; body: string; access: NoteAccess; selected_participant_ids: string; created_by: string; created_at: string; updated_at: string; marker_id?: string; marker_type: 'text' | 'image'; marker_text: string | null; marker_asset_id: string | null };
type NoteMarkerRow = { id: string; note_id: string; layer_id: string; x: number; y: number; width: number | null; height: number | null; order_index: number; title: string; marker_type: 'text' | 'image'; marker_text: string | null; marker_asset_id: string | null; asset_width: number | null; asset_height: number | null };
type SheetRow = {
  id: string; creator_id: string; creator_name: string; assigned_player_id: string | null; assigned_player_name: string | null;
  system_id: string; system_version: string; schema_version: number;
  character_name: string; portrait_asset_id: string | null; characteristics_json: string; fate: number; created_at: string; updated_at: string;
};
type CounterRow = { id: string; sheet_id: string; name: string; value: number; order_index: number };
type AbilityRow = {
  id: string; sheet_id: string; name: string; description: string; asset_id: string | null;
  counter_enabled: number; counter_name: string; counter_value: number;
  checkbox_enabled: number; checkbox_label: string; checked: number; order_index: number;
};

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
function textMarkerSize(text: string): { width: number; height: number } {
  return { width: Math.min(200, Math.max(64, text.length * 8 + 18)), height: 34 };
}
function imageMarkerSize(assetWidth: number | null, assetHeight: number | null): { width: number; height: number } {
  const width = assetWidth && assetWidth > 0 ? assetWidth : 84;
  const height = assetHeight && assetHeight > 0 ? assetHeight : 60;
  const ratio = Math.min(84 / width, 60 / height);
  return { width: Math.max(1, Math.round(width * ratio)), height: Math.max(1, Math.round(height * ratio)) };
}
function defaultMarkerSize(type: 'text' | 'image', text: string, assetWidth: number | null, assetHeight: number | null): { width: number; height: number } {
  return type === 'image' ? imageMarkerSize(assetWidth, assetHeight) : textMarkerSize(text);
}
function toNoteMarker(row: NoteMarkerRow): NoteMarker {
  const text = row.marker_text || row.title;
  const fallback = defaultMarkerSize(row.marker_type, text, row.asset_width, row.asset_height);
  return {
    id: row.id, noteId: row.note_id, layerId: row.layer_id, x: row.x, y: row.y,
    width: row.width ?? fallback.width, height: row.height ?? fallback.height,
    orderIndex: row.order_index, type: row.marker_type, text,
    ...(row.marker_asset_id ? { assetId: row.marker_asset_id, assetWidth: row.asset_width || 1, assetHeight: row.asset_height || 1 } : {}),
  };
}
function toCounter(row: CounterRow): CharacterSheetCounter {
  return { id: row.id, name: row.name, value: row.value, orderIndex: row.order_index };
}
function toAbility(row: AbilityRow): CharacterSheetAbility {
  return {
    id: row.id, name: row.name, description: row.description, assetId: row.asset_id,
    counterEnabled: row.counter_enabled === 1, counterName: row.counter_name, counterValue: row.counter_value,
    checkboxEnabled: row.checkbox_enabled === 1, checkboxLabel: row.checkbox_label, checked: row.checked === 1,
    orderIndex: row.order_index,
  };
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
        background TEXT NOT NULL DEFAULT 'gray' CHECK (background IN ('black', 'gray')),
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
      CREATE TABLE IF NOT EXISTS dice_rolls (
        id TEXT PRIMARY KEY,
        author_id TEXT NOT NULL,
        author_name TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        actor_name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('pbta', 'free')),
        dice_json TEXT NOT NULL,
        kept_dice_json TEXT NOT NULL,
        discarded_die INTEGER,
        characteristic_name TEXT,
        character_id TEXT,
        character_owner_id TEXT,
        characteristic_bonus INTEGER,
        situational_modifier INTEGER NOT NULL DEFAULT 0 CHECK (situational_modifier IN (-1, 0, 1)),
        disadvantage INTEGER NOT NULL DEFAULT 0 CHECK (disadvantage IN (0, 1)),
        sides INTEGER,
        total INTEGER NOT NULL,
        category TEXT CHECK (category IN ('failure', 'success', 'triumph')),
        critical TEXT CHECK (critical IN ('critical-failure', 'critical-success')),
        reroll_of TEXT
      );
      CREATE INDEX IF NOT EXISTS dice_rolls_created ON dice_rolls(created_at DESC, id DESC);
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
        width REAL NOT NULL,
        height REAL NOT NULL,
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
      CREATE TABLE IF NOT EXISTS asset_uploaders (
        asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
        participant_id TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (asset_id, participant_id)
      );
      CREATE INDEX IF NOT EXISTS asset_uploaders_participant ON asset_uploaders(participant_id);
      CREATE TABLE IF NOT EXISTS character_sheets (
        id TEXT PRIMARY KEY,
        creator_id TEXT NOT NULL,
        creator_name TEXT NOT NULL,
        assigned_player_id TEXT,
        assigned_player_name TEXT,
        system_id TEXT NOT NULL,
        system_version TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        character_name TEXT NOT NULL DEFAULT '',
        portrait_asset_id TEXT REFERENCES assets(id) ON DELETE RESTRICT,
        characteristics_json TEXT NOT NULL,
        fate INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS character_sheets_system ON character_sheets(system_id);
      CREATE TABLE IF NOT EXISTS character_counters (
        id TEXT PRIMARY KEY,
        sheet_id TEXT NOT NULL REFERENCES character_sheets(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        value INTEGER NOT NULL,
        order_index INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS character_counters_sheet_order ON character_counters(sheet_id, order_index);
      CREATE TABLE IF NOT EXISTS character_abilities (
        id TEXT PRIMARY KEY,
        sheet_id TEXT NOT NULL REFERENCES character_sheets(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        asset_id TEXT REFERENCES assets(id) ON DELETE RESTRICT,
        counter_enabled INTEGER NOT NULL DEFAULT 0 CHECK (counter_enabled IN (0, 1)),
        counter_name TEXT NOT NULL DEFAULT '',
        counter_value INTEGER NOT NULL DEFAULT 0,
        checkbox_enabled INTEGER NOT NULL DEFAULT 0 CHECK (checkbox_enabled IN (0, 1)),
        checkbox_label TEXT NOT NULL DEFAULT '',
        checked INTEGER NOT NULL DEFAULT 0 CHECK (checked IN (0, 1)),
        order_index INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS character_abilities_sheet_order ON character_abilities(sheet_id, order_index);
      CREATE INDEX IF NOT EXISTS character_abilities_asset ON character_abilities(asset_id);
    `);
    const sheetColumns = this.db.pragma('table_info(character_sheets)') as Array<{ name: string }>;
    if (sheetColumns.length > 0 && !sheetColumns.some((column) => column.name === 'creator_id')) {
      this.db.pragma('foreign_keys = OFF');
      try {
        this.db.transaction(() => {
          this.db.exec('DROP TABLE IF EXISTS character_sheets_new');
          this.db.exec(`CREATE TABLE character_sheets_new (
            id TEXT PRIMARY KEY,
            creator_id TEXT NOT NULL,
            creator_name TEXT NOT NULL,
            assigned_player_id TEXT,
            assigned_player_name TEXT,
            system_id TEXT NOT NULL,
            system_version TEXT NOT NULL,
            schema_version INTEGER NOT NULL,
            character_name TEXT NOT NULL DEFAULT '',
            portrait_asset_id TEXT REFERENCES assets(id) ON DELETE RESTRICT,
            characteristics_json TEXT NOT NULL,
            fate INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
          )`);
          this.db.exec(`INSERT INTO character_sheets_new
            (id, creator_id, creator_name, assigned_player_id, assigned_player_name, system_id, system_version, schema_version,
             character_name, portrait_asset_id, characteristics_json, fate, created_at, updated_at)
            SELECT id, owner_id, owner_name, owner_id, owner_name, system_id, system_version, schema_version,
             character_name, portrait_asset_id, characteristics_json, fate, created_at, updated_at
            FROM character_sheets`);
          this.db.exec('DROP TABLE character_sheets');
          this.db.exec('ALTER TABLE character_sheets_new RENAME TO character_sheets');
          this.db.exec('CREATE INDEX IF NOT EXISTS character_sheets_system ON character_sheets(system_id)');
          this.db.exec('CREATE INDEX IF NOT EXISTS character_sheets_assigned ON character_sheets(assigned_player_id)');
        })();
      } finally {
        this.db.pragma('foreign_keys = ON');
      }
      const violations = this.db.pragma('foreign_key_check') as unknown[];
      if (violations.length > 0) throw new Error('Не удалось проверить целостность листов персонажей после миграции.');
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS character_sheets_assigned ON character_sheets(assigned_player_id)');
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
    if (!roomColumns.some((column) => column.name === 'active_system_id')) this.db.exec('ALTER TABLE room ADD COLUMN active_system_id TEXT');
    if (!roomColumns.some((column) => column.name === 'active_system_version')) this.db.exec('ALTER TABLE room ADD COLUMN active_system_version TEXT');
    if (!roomColumns.some((column) => column.name === 'background')) {
      this.db.exec("ALTER TABLE room ADD COLUMN background TEXT NOT NULL DEFAULT 'gray' CHECK (background IN ('black', 'gray'))");
    }
    const noteColumns = this.db.pragma('table_info(notes)') as Array<{ name: string }>;
    if (!noteColumns.some((column) => column.name === 'marker_type')) this.db.exec("ALTER TABLE notes ADD COLUMN marker_type TEXT NOT NULL DEFAULT 'text' CHECK (marker_type IN ('text', 'image'))");
    if (!noteColumns.some((column) => column.name === 'marker_text')) this.db.exec('ALTER TABLE notes ADD COLUMN marker_text TEXT');
    if (!noteColumns.some((column) => column.name === 'marker_asset_id')) this.db.exec('ALTER TABLE notes ADD COLUMN marker_asset_id TEXT REFERENCES assets(id) ON DELETE RESTRICT');
    const markerColumns = this.db.pragma('table_info(note_markers)') as Array<{ name: string }>;
    if (!markerColumns.some((column) => column.name === 'width')) this.db.exec('ALTER TABLE note_markers ADD COLUMN width REAL');
    if (!markerColumns.some((column) => column.name === 'height')) this.db.exec('ALTER TABLE note_markers ADD COLUMN height REAL');
    const markerRows = this.db.prepare(`SELECT marker.id, marker.width, marker.height, note.marker_type, COALESCE(note.marker_text, note.title) AS marker_text,
      asset.width AS asset_width, asset.height AS asset_height
      FROM note_markers AS marker JOIN notes AS note ON note.id = marker.note_id
      LEFT JOIN assets AS asset ON asset.id = note.marker_asset_id`).all() as Array<{
        id: string; width: number | null; height: number | null; marker_type: 'text' | 'image';
        marker_text: string; asset_width: number | null; asset_height: number | null;
      }>;
    const updateMarkerSize = this.db.prepare('UPDATE note_markers SET width = ?, height = ? WHERE id = ?');
    this.db.transaction(() => {
      for (const row of markerRows) {
        const fallback = defaultMarkerSize(row.marker_type, row.marker_text, row.asset_width, row.asset_height);
        if (row.width === null || row.height === null) updateMarkerSize.run(row.width ?? fallback.width, row.height ?? fallback.height, row.id);
      }
    })();
    const diceColumns = this.db.pragma('table_info(dice_rolls)') as Array<{ name: string }>;
    if (!diceColumns.some((column) => column.name === 'character_id')) this.db.exec('ALTER TABLE dice_rolls ADD COLUMN character_id TEXT');
    if (!diceColumns.some((column) => column.name === 'character_owner_id')) this.db.exec('ALTER TABLE dice_rolls ADD COLUMN character_owner_id TEXT');
    this.db.prepare('INSERT OR IGNORE INTO room (id, name) VALUES (1, ?)').run(roomName);
    const layerCount = (this.db.prepare('SELECT COUNT(*) AS count FROM board_layers').get() as { count: number }).count;
    if (layerCount === 0) this.createLayer('Основной слой', 'all-players');
  }

  get roomName(): string {
    return (this.db.prepare('SELECT name FROM room WHERE id = 1').get() as { name: string }).name;
  }

  get boardBackground(): BoardBackground {
    const row = this.db.prepare('SELECT background FROM room WHERE id = 1').get() as { background: string } | undefined;
    return row?.background === 'black' ? 'black' : 'gray';
  }
  setBoardBackground(background: BoardBackground): void {
    this.db.prepare('UPDATE room SET background = ? WHERE id = 1').run(background);
  }

  get activeSystem(): { id: string; version: string } | null {
    const row = this.db.prepare('SELECT active_system_id, active_system_version FROM room WHERE id = 1').get() as { active_system_id: string | null; active_system_version: string | null };
    return row.active_system_id && row.active_system_version ? { id: row.active_system_id, version: row.active_system_version } : null;
  }
  setActiveSystem(id: string | null, version: string | null): void {
    if ((id === null) !== (version === null)) throw new Error('System id and version must both be set or cleared.');
    this.db.prepare('UPDATE room SET active_system_id = ?, active_system_version = ? WHERE id = 1').run(id, version);
  }
  saveDiceRoll(entry: DiceRollEntry): void {
    const insert = this.db.prepare(`INSERT INTO dice_rolls
      (id, author_id, author_name, actor_id, actor_name, created_at, kind, dice_json, kept_dice_json, discarded_die,
       characteristic_name, character_id, character_owner_id, characteristic_bonus, situational_modifier, disadvantage, sides, total, category, critical, reroll_of)
      VALUES (@id, @authorId, @authorName, @actorId, @actorName, @createdAt, @kind, @dice, @keptDice, @discardedDie,
       @characteristicName, @characterId, @characterOwnerId, @characteristicBonus, @situationalModifier, @disadvantage, @sides, @total, @category, @critical, @rerollOf)`);
    this.db.transaction(() => {
      insert.run({
        id: entry.id, authorId: entry.authorId, authorName: entry.authorName, actorId: entry.actorId, actorName: entry.actorName,
        createdAt: entry.createdAt, kind: entry.kind, dice: JSON.stringify(entry.dice), keptDice: JSON.stringify(entry.keptDice),
        discardedDie: entry.discardedDie, characteristicName: entry.characteristicName, characterId: entry.characterId, characterOwnerId: entry.characterOwnerId, characteristicBonus: entry.characteristicBonus,
        situationalModifier: entry.situationalModifier, disadvantage: Number(entry.disadvantage), sides: entry.sides,
        total: entry.total, category: entry.category, critical: entry.critical, rerollOf: entry.rerollOf,
      });
      this.db.exec('DELETE FROM dice_rolls WHERE id NOT IN (SELECT id FROM dice_rolls ORDER BY created_at DESC, rowid DESC LIMIT 10)');
    })();
  }
  getDiceRolls(): DiceRollEntry[] {
    const rows = this.db.prepare('SELECT * FROM dice_rolls ORDER BY created_at DESC, rowid DESC LIMIT 10').all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id), authorId: String(row.author_id), authorName: String(row.author_name), actorId: String(row.actor_id), actorName: String(row.actor_name),
      createdAt: String(row.created_at), kind: row.kind as DiceRollEntry['kind'], dice: JSON.parse(String(row.dice_json)) as number[],
      keptDice: JSON.parse(String(row.kept_dice_json)) as number[], discardedDie: row.discarded_die === null ? null : Number(row.discarded_die),
      characteristicName: row.characteristic_name === null ? null : String(row.characteristic_name),
      characterId: row.character_id === null ? null : String(row.character_id), characterOwnerId: row.character_owner_id === null ? null : String(row.character_owner_id),
      characteristicBonus: row.characteristic_bonus === null ? null : Number(row.characteristic_bonus),
      situationalModifier: Number(row.situational_modifier) as -1 | 0 | 1, disadvantage: Number(row.disadvantage) === 1,
      sides: row.sides === null ? null : Number(row.sides), total: Number(row.total),
      category: row.category as DiceRollEntry['category'], critical: row.critical as DiceRollEntry['critical'],
      rerollOf: row.reroll_of === null ? null : String(row.reroll_of),
    }));
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
  getAssetUsage(assetId: string): BoardAssetUsage[] {
    const rows = this.db.prepare(`
      SELECT 'board-object' AS kind, COUNT(*) AS count FROM board_objects WHERE asset_id = @id
      UNION ALL SELECT 'note-attachment', COUNT(*) FROM note_assets WHERE asset_id = @id
      UNION ALL SELECT 'note-marker', COUNT(*) FROM notes WHERE marker_asset_id = @id
      UNION ALL SELECT 'sheet-portrait', COUNT(*) FROM character_sheets WHERE portrait_asset_id = @id
      UNION ALL SELECT 'sheet-ability', COUNT(*) FROM character_abilities WHERE asset_id = @id
    `).all({ id: assetId }) as Array<{ kind: BoardAssetUsageKind; count: number }>;
    return rows.filter((row) => row.count > 0);
  }
  deleteAssetIfUnused(id: string): boolean {
    return this.db.transaction(() => {
      if (this.getAssetUsage(id).length > 0) return false;
      this.db.prepare('DELETE FROM assets WHERE id = ?').run(id);
      return true;
    })();
  }
  restoreAsset(asset: BoardAsset): void {
    this.db.prepare(`INSERT INTO assets (id, sha256, mime_type, original_name, size, width, height, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(asset.id, asset.sha256, asset.mimeType, asset.originalName, asset.size, asset.width, asset.height, asset.createdAt);
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
    if (this.isAssetUploadedBy(assetId, identity.participantId)) return true;
    if (this.isAssetUsedBySheet(assetId, identity)) return true;
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
    const note = this.db.prepare(`SELECT note.marker_type, COALESCE(note.marker_text, note.title) AS marker_text,
      asset.width AS asset_width, asset.height AS asset_height
      FROM notes AS note LEFT JOIN assets AS asset ON asset.id = note.marker_asset_id WHERE note.id = ?`)
      .get(marker.noteId) as { marker_type: 'text' | 'image'; marker_text: string; asset_width: number | null; asset_height: number | null } | undefined;
    const fallback = note ? defaultMarkerSize(note.marker_type, note.marker_text, note.asset_width, note.asset_height) : { width: 84, height: 34 };
    this.db.prepare('INSERT INTO note_markers (id, note_id, layer_id, x, y, width, height, order_index) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(marker.id, marker.noteId, marker.layerId, marker.x, marker.y, marker.width ?? fallback.width, marker.height ?? fallback.height, orderIndex);
  }
  updateNoteMarker(id: string, patch: Partial<Pick<NoteMarker, 'layerId' | 'x' | 'y' | 'width' | 'height'>>): void {
    const columns = { layerId: 'layer_id', x: 'x', y: 'y', width: 'width', height: 'height' } as const;
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

  getSheets(): CharacterSheet[] {
    const rows = this.db.prepare(`SELECT * FROM character_sheets
      ORDER BY assigned_player_id IS NULL DESC, assigned_player_name COLLATE NOCASE ASC, character_name COLLATE NOCASE ASC, updated_at DESC`).all() as SheetRow[];
    return rows.map((row) => this.hydrateSheet(row));
  }
  getSheetsFor(identity: Identity): CharacterSheet[] {
    if (identity.role === 'gm') return this.getSheets();
    const rows = this.db.prepare(`SELECT * FROM character_sheets
      WHERE assigned_player_id IS NOT NULL
      ORDER BY character_name COLLATE NOCASE ASC, updated_at DESC`).all() as SheetRow[];
    return rows.map((row) => this.hydrateSheet(row));
  }
  getSheet(id: string): CharacterSheet | undefined {
    const row = this.db.prepare('SELECT * FROM character_sheets WHERE id = ?').get(id) as SheetRow | undefined;
    return row ? this.hydrateSheet(row) : undefined;
  }
  /** Players only receive sheets that have an assigned player; unassigned drafts stay GM-only. */
  getSheetFor(id: string, identity: Identity): CharacterSheet | undefined {
    const sheet = this.getSheet(id);
    if (!sheet) return undefined;
    if (identity.role === 'gm' || sheet.assignedPlayerId) return sheet;
    return undefined;
  }
  getSheetsByAssignedPlayer(participantId: string, systemId?: string): CharacterSheet[] {
    const rows = systemId
      ? this.db.prepare('SELECT * FROM character_sheets WHERE assigned_player_id = ? AND system_id = ? ORDER BY created_at ASC').all(participantId, systemId) as SheetRow[]
      : this.db.prepare('SELECT * FROM character_sheets WHERE assigned_player_id = ? ORDER BY created_at ASC').all(participantId) as SheetRow[];
    return rows.map((row) => this.hydrateSheet(row));
  }
  canEditSheet(id: string, identity: Identity): boolean {
    const row = this.db.prepare('SELECT assigned_player_id FROM character_sheets WHERE id = ?').get(id) as { assigned_player_id: string | null } | undefined;
    return Boolean(row) && (identity.role === 'gm' || row!.assigned_player_id === identity.participantId);
  }
  assignSheet(id: string, playerId: string | null, playerName: string | null): void {
    this.db.prepare('UPDATE character_sheets SET assigned_player_id = ?, assigned_player_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(playerId, playerName, id);
  }
  deleteUnassignedSheet(id: string): boolean {
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT assigned_player_id FROM character_sheets WHERE id = ?').get(id) as { assigned_player_id: string | null } | undefined;
      if (!row || row.assigned_player_id !== null) return false;
      this.db.prepare('DELETE FROM character_sheets WHERE id = ? AND assigned_player_id IS NULL').run(id);
      return true;
    })();
  }
  private hydrateSheet(row: SheetRow): CharacterSheet {
    let characteristics: Record<SheetCharacteristicKey, number> = { might: 0, insight: 0, glory: 0, will: 0 };
    try {
      const parsed = JSON.parse(row.characteristics_json) as Partial<Record<SheetCharacteristicKey, unknown>>;
      if (parsed && typeof parsed === 'object') {
        for (const key of ['might', 'insight', 'glory', 'will'] as const) {
          const value = parsed[key];
          if (typeof value === 'number' && Number.isSafeInteger(value)) characteristics[key] = value;
        }
      }
    } catch { /* Invalid legacy values fall back to zero. */ }
    const counters = (this.db.prepare('SELECT * FROM character_counters WHERE sheet_id = ? ORDER BY order_index ASC, rowid ASC').all(row.id) as CounterRow[]).map(toCounter);
    const abilities = (this.db.prepare('SELECT * FROM character_abilities WHERE sheet_id = ? ORDER BY order_index ASC, rowid ASC').all(row.id) as AbilityRow[]).map(toAbility);
    return {
      id: row.id, creatorId: row.creator_id, creatorName: row.creator_name,
      assignedPlayerId: row.assigned_player_id, assignedPlayerName: row.assigned_player_name,
      systemId: row.system_id, systemVersion: row.system_version, schemaVersion: row.schema_version,
      characterName: row.character_name, portraitAssetId: row.portrait_asset_id, characteristics,
      fate: row.fate, counters, abilities, createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }
  createSheet(sheet: SheetInput): void {
    this.db.prepare(`INSERT INTO character_sheets
      (id, creator_id, creator_name, assigned_player_id, assigned_player_name, system_id, system_version, schema_version, character_name, portrait_asset_id, characteristics_json, fate)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(sheet.id, sheet.creatorId, sheet.creatorName, sheet.assignedPlayerId, sheet.assignedPlayerName, sheet.systemId, sheet.systemVersion, sheet.schemaVersion, sheet.characterName, sheet.portraitAssetId, JSON.stringify(sheet.characteristics), sheet.fate);
  }
  updateSheet(id: string, patch: SheetPatch): void {
    const columns: Record<keyof SheetPatch, string> = { characterName: 'character_name', portraitAssetId: 'portrait_asset_id', characteristics: 'characteristics_json', fate: 'fate' };
    const entries = Object.entries(patch) as Array<[keyof SheetPatch, SheetPatch[keyof SheetPatch]]>;
    if (!entries.length) return;
    this.db.prepare(`UPDATE character_sheets SET ${entries.map(([key]) => `${columns[key]} = @${key}`).join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = @id`)
      .run({ id, ...Object.fromEntries(entries.map(([key, value]) => [key, key === 'characteristics' ? JSON.stringify(value) : value])) });
  }
  createCounter(sheetId: string, counter: Omit<CharacterSheetCounter, 'orderIndex'>): CharacterSheetCounter {
    const orderIndex = (this.db.prepare('SELECT COALESCE(MAX(order_index), -1) + 1 AS next FROM character_counters WHERE sheet_id = ?').get(sheetId) as { next: number }).next;
    this.db.prepare('INSERT INTO character_counters (id, sheet_id, name, value, order_index) VALUES (?, ?, ?, ?, ?)')
      .run(counter.id, sheetId, counter.name, counter.value, orderIndex);
    this.touchSheet(sheetId);
    return { ...counter, orderIndex };
  }
  updateCounter(sheetId: string, id: string, patch: CounterPatch): void {
    const columns: Record<keyof CounterPatch, string> = { name: 'name', value: 'value' };
    const entries = Object.entries(patch) as Array<[keyof CounterPatch, CounterPatch[keyof CounterPatch]]>;
    if (!entries.length) return;
    this.db.prepare(`UPDATE character_counters SET ${entries.map(([key]) => `${columns[key]} = @${key}`).join(', ')} WHERE id = @id AND sheet_id = @sheetId`)
      .run({ id, sheetId, ...Object.fromEntries(entries) });
    this.touchSheet(sheetId);
  }
  deleteCounter(sheetId: string, id: string): void {
    this.db.prepare('DELETE FROM character_counters WHERE id = ? AND sheet_id = ?').run(id, sheetId);
    this.touchSheet(sheetId);
  }
  reorderCounters(sheetId: string, ids: string[]): void {
    const update = this.db.prepare('UPDATE character_counters SET order_index = ? WHERE id = ? AND sheet_id = ?');
    this.db.transaction(() => ids.forEach((id, index) => update.run(index, id, sheetId)))();
    this.touchSheet(sheetId);
  }
  createAbility(sheetId: string, ability: AbilityInput): CharacterSheetAbility {
    const orderIndex = (this.db.prepare('SELECT COALESCE(MAX(order_index), -1) + 1 AS next FROM character_abilities WHERE sheet_id = ?').get(sheetId) as { next: number }).next;
    this.db.prepare(`INSERT INTO character_abilities
      (id, sheet_id, name, description, asset_id, counter_enabled, counter_name, counter_value, checkbox_enabled, checkbox_label, checked, order_index)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(ability.id, sheetId, ability.name, ability.description, ability.assetId, Number(ability.counterEnabled), ability.counterName, ability.counterValue, Number(ability.checkboxEnabled), ability.checkboxLabel, Number(ability.checked), orderIndex);
    this.touchSheet(sheetId);
    return { ...ability, orderIndex };
  }
  updateAbility(sheetId: string, id: string, patch: AbilityPatch): void {
    const columns: Record<keyof AbilityPatch, string> = {
      name: 'name', description: 'description', assetId: 'asset_id', counterEnabled: 'counter_enabled', counterName: 'counter_name',
      counterValue: 'counter_value', checkboxEnabled: 'checkbox_enabled', checkboxLabel: 'checkbox_label', checked: 'checked', orderIndex: 'order_index',
    };
    const entries = Object.entries(patch) as Array<[keyof AbilityPatch, AbilityPatch[keyof AbilityPatch]]>;
    if (!entries.length) return;
    this.db.prepare(`UPDATE character_abilities SET ${entries.map(([key]) => `${columns[key]} = @${key}`).join(', ')} WHERE id = @id AND sheet_id = @sheetId`)
      .run({
        id, sheetId, ...Object.fromEntries(entries.map(([key, value]) => [
          key, key === 'counterEnabled' || key === 'checkboxEnabled' || key === 'checked' ? Number(value) : value,
        ])),
      });
    this.touchSheet(sheetId);
  }
  deleteAbility(sheetId: string, id: string): void {
    this.db.prepare('DELETE FROM character_abilities WHERE id = ? AND sheet_id = ?').run(id, sheetId);
    this.touchSheet(sheetId);
  }
  reorderAbilities(sheetId: string, ids: string[]): void {
    const update = this.db.prepare('UPDATE character_abilities SET order_index = ? WHERE id = ? AND sheet_id = ?');
    this.db.transaction(() => ids.forEach((id, index) => update.run(index, id, sheetId)))();
    this.touchSheet(sheetId);
  }
  private touchSheet(id: string): void {
    this.db.prepare('UPDATE character_sheets SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
  }
  recordAssetUploader(assetId: string, participantId: string): void {
    this.db.prepare('INSERT OR IGNORE INTO asset_uploaders (asset_id, participant_id) VALUES (?, ?)').run(assetId, participantId);
  }
  isAssetUploadedBy(assetId: string, participantId: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM asset_uploaders WHERE asset_id = ? AND participant_id = ?').get(assetId, participantId));
  }
  isAssetUsedBySheet(assetId: string, identity: Identity): boolean {
    const assignedFilter = identity.role === 'gm' ? '' : 'AND sheet.assigned_player_id IS NOT NULL';
    return Boolean(this.db.prepare(`SELECT 1 FROM character_sheets AS sheet WHERE sheet.portrait_asset_id = ? ${assignedFilter}
      UNION SELECT 1 FROM character_abilities AS ability JOIN character_sheets AS sheet ON sheet.id = ability.sheet_id
      WHERE ability.asset_id = ? ${assignedFilter} LIMIT 1`).get(assetId, assetId));
  }

  snapshot(identityOrRole: Identity | Role, participantId = ''): BoardSnapshot {
    const role = typeof identityOrRole === 'string' ? identityOrRole : identityOrRole.role;
    const identity = typeof identityOrRole === 'string' ? { participantId, name: '', role } : identityOrRole;
    const allLayers = this.getLayers();
    const common = { background: this.boardBackground, activeSystem: this.activeSystem, diceRolls: this.getDiceRolls(), sheets: this.getSheetsFor(identity) };
    if (role === 'gm') return { ...common, layers: allLayers, objects: this.getObjects(), stickers: this.getStickers(), noteMarkers: this.getNoteMarkers(), assets: this.getAssets() };
    const layers = this.getLayers().filter((layer) => layer.audience === 'all-players' && layer.visible);
    const visibleIds = new Set(layers.map((layer) => layer.id));
    const stickers = this.getStickers().filter((sticker) => visibleIds.has(sticker.layerId));
    const noteMarkers = this.getNoteMarkers().filter((marker) => visibleIds.has(marker.layerId) && this.canReadNote(marker.noteId, identity));
    const availableAssets = this.getAssets().filter((asset) => this.canReadAsset(asset.id, identity));
    return { ...common, layers, objects: this.getObjects().filter((object) => visibleIds.has(object.layerId)), stickers, noteMarkers, availableAssets };
  }

  backup(path: string): Promise<Database.BackupMetadata> { return this.db.backup(path); }
  close(): void { this.db.close(); }
}
