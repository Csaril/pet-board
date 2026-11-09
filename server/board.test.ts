import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { executeBoardCommand } from './board.js';
import { RoomStore } from './store.js';

const gm = { participantId: 'gm-session', name: 'Keeper', role: 'gm' as const };
const player = { participantId: 'player-session', name: 'Ari', role: 'player' as const };

test('board commands enforce role, layer lock, object permission, and private projections', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tabletop-board-domain-'));
  const store = new RoomStore(dataDir, 'Test');
  try {
    const publicLayer = store.getLayers()[0]!;
    const privateLayerBefore = store.getLayers().length;
    assert.throws(() => executeBoardCommand(store, player, { type: 'layer:create', name: 'forbidden' }), /только ведущему/i);
    executeBoardCommand(store, gm, { type: 'layer:create', name: 'Секреты', audience: 'gm-only' });
    const privateLayer = store.getLayers().find((layer) => layer.name === 'Секреты')!;
    assert.equal(store.snapshot('player').layers.some((layer) => layer.id === privateLayer.id), false);
    assert.equal(store.getLayers().length, privateLayerBefore + 1);

    store.createAsset({ id: 'asset-1', sha256: 'hash-1', mimeType: 'image/png', originalName: 'map.png', size: 20, width: 2, height: 2 });
    executeBoardCommand(store, gm, { type: 'object:create', assetId: 'asset-1', layerId: publicLayer.id, x: 5, y: 7 });
    const object = store.getObjects()[0]!;
    assert.equal(store.snapshot('player').objects.length, 1);
    assert.equal(store.snapshot('player').assets, undefined);
    store.updateLayer(publicLayer.id, { visible: false });
    assert.equal(store.snapshot('player').objects.length, 0);
    assert.equal(store.snapshot('gm').objects.length, 1);
    store.updateLayer(publicLayer.id, { visible: true });

    executeBoardCommand(store, gm, { type: 'object:update', id: object.id, changes: { allowPlayerMove: true } });
    executeBoardCommand(store, player, { type: 'object:update', id: object.id, changes: { x: 90, y: 100 } });
    assert.deepEqual({ x: store.getObject(object.id)?.x, y: store.getObject(object.id)?.y }, { x: 90, y: 100 });
    assert.throws(() => executeBoardCommand(store, player, { type: 'object:update', id: object.id, changes: { width: 900 } }), /только перемещение/i);

    executeBoardCommand(store, gm, { type: 'layer:update', id: publicLayer.id, changes: { locked: true } });
    assert.throws(() => executeBoardCommand(store, player, { type: 'object:update', id: object.id, changes: { x: 1 } }), /заблокирован/i);
    for (const changes of [
      { x: 1 }, { width: 20 }, { height: 30 }, { flipX: true }, { flipY: true },
      { crop: { x: 0, y: 0, width: 0.5, height: 0.5 } }, { layerId: privateLayer.id }, { orderIndex: 5 },
    ]) {
      assert.throws(() => executeBoardCommand(store, gm, { type: 'object:update', id: object.id, changes }), /заблокирован/i);
    }
    assert.throws(() => executeBoardCommand(store, gm, { type: 'object:delete', id: object.id }), /заблокирован/i);
    assert.throws(() => executeBoardCommand(store, gm, { type: 'object:duplicate', id: object.id }), /заблокирован/i);
    assert.throws(() => executeBoardCommand(store, gm, { type: 'object:order', id: object.id, direction: 'front' }), /заблокирован/i);
    assert.throws(() => executeBoardCommand(store, gm, { type: 'layer:delete', id: publicLayer.id, targetLayerId: privateLayer.id }), /заблокирован/i);
    assert.throws(() => executeBoardCommand(store, gm, { type: 'layer:delete', id: publicLayer.id, deleteObjects: true }), /заблокирован/i);
    assert.equal(store.getObject(object.id)?.x, 90);
    executeBoardCommand(store, gm, { type: 'layer:update', id: publicLayer.id, changes: { locked: false } });
    executeBoardCommand(store, gm, { type: 'layer:update', id: privateLayer.id, changes: { locked: true } });
    assert.throws(() => executeBoardCommand(store, gm, { type: 'object:update', id: object.id, changes: { layerId: privateLayer.id } }), /целевой слой заблокирован/i);
  } finally { store.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test('notes stay out of board projections and player stickers are public and owner-controlled', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tabletop-board-notes-'));
  const store = new RoomStore(dataDir, 'Test');
  const gmIdentity = { ...gm, participantId: 'gm-note-session' };
  const ari = { ...player, participantId: 'ari-note-session' };
  const bea = { name: 'Bea', role: 'player' as const, participantId: 'bea-note-session' };
  try {
    const layer = store.getLayers()[0]!;
    store.createSession(ari.participantId, { name: ari.name, role: 'player' }, Date.now() + 60_000);
    store.createSession(bea.participantId, { name: bea.name, role: 'player' }, Date.now() + 60_000);
    store.createAsset({ id: 'marker-asset', sha256: 'marker-hash', mimeType: 'image/png', originalName: 'marker.png', size: 20, width: 400, height: 200 });
    store.createNote({ id: 'note-public', title: 'Public', body: 'Secret payload', access: 'all-players', selectedParticipantIds: [], creatorId: gmIdentity.participantId, assetIds: [] });
    store.createNote({ id: 'note-selected', title: 'Selected', body: 'For Ari', access: 'selected-players', selectedParticipantIds: [ari.participantId], creatorId: gmIdentity.participantId, assetIds: [] });
    store.createNote({ id: 'note-private', title: 'Private', body: 'GM only', access: 'gm-only', selectedParticipantIds: [], creatorId: gmIdentity.participantId, assetIds: [] });
    store.createNote({ id: 'note-image', title: 'Image label', body: '', access: 'selected-players', selectedParticipantIds: [ari.participantId], creatorId: gmIdentity.participantId, assetIds: [], markerType: 'image', markerAssetId: 'marker-asset' });
    store.createNoteMarker({ id: 'marker-public', noteId: 'note-public', layerId: layer.id, x: 10, y: 20 });
    store.createNoteMarker({ id: 'marker-selected', noteId: 'note-selected', layerId: layer.id, x: 30, y: 40 });
    store.createNoteMarker({ id: 'marker-private', noteId: 'note-private', layerId: layer.id, x: 50, y: 60 });
    store.createNoteMarker({ id: 'marker-image', noteId: 'note-image', layerId: layer.id, x: 70, y: 80 });
    const ariProjection = store.snapshot(ari);
    assert.deepEqual(ariProjection.noteMarkers.map((marker) => marker.noteId).sort(), ['note-image', 'note-public', 'note-selected']);
    const imageMarker = ariProjection.noteMarkers.find((marker) => marker.noteId === 'note-image')!;
    assert.deepEqual({ type: imageMarker.type, assetId: imageMarker.assetId, assetWidth: imageMarker.assetWidth, assetHeight: imageMarker.assetHeight }, { type: 'image', assetId: 'marker-asset', assetWidth: 400, assetHeight: 200 });
    assert.equal(JSON.stringify(ariProjection).includes('Secret payload'), false);
    assert.deepEqual(store.snapshot(bea).noteMarkers.map((marker) => marker.noteId), ['note-public']);
    assert.equal(store.canReadNote('note-private', ari), false);
    assert.equal(store.canReadNote('note-selected', bea), false);
    assert.equal(store.canReadAsset('marker-asset', ari), true);
    assert.equal(store.canReadAsset('marker-asset', bea), false);

    const stickerCommand = { type: 'sticker:create', text: 'Hello', x: 10, y: 20, fontSize: 24, textColor: 'white' };
    executeBoardCommand(store, ari, stickerCommand);
    const sticker = store.getStickers()[0]!;
    assert.equal(sticker.creatorId, ari.participantId);
    assert.equal(sticker.layerId, layer.id);
    assert.equal(sticker.fontSize, 24);
    assert.equal(sticker.textColor, 'white');
    assert.throws(() => executeBoardCommand(store, ari, { type: 'sticker:update', id: sticker.id, changes: { textColor: 'plum' } }), /цвет текста/i);
    assert.throws(() => executeBoardCommand(store, ari, { type: 'sticker:update', id: sticker.id, changes: { fontSize: 15 } }), /размер текста/i);
    assert.throws(() => executeBoardCommand(store, bea, { type: 'sticker:update', id: sticker.id, changes: { text: 'changed' } }), /свой стикер/i);
    executeBoardCommand(store, ari, { type: 'sticker:update', id: sticker.id, changes: { x: 70 } });
    assert.equal(store.getSticker(sticker.id)?.x, 70);
    executeBoardCommand(store, gmIdentity, { type: 'sticker:update', id: sticker.id, changes: { text: 'GM changed' } });
    assert.equal(store.getSticker(sticker.id)?.text, 'GM changed');
    executeBoardCommand(store, gmIdentity, { type: 'layer:update', id: layer.id, changes: { locked: true } });
    executeBoardCommand(store, bea, { type: 'sticker:create', text: 'Safe layer', x: 0, y: 0 });
    const safeLayerSticker = store.getStickers().find((entry) => entry.text === 'Safe layer')!;
    const safeLayer = store.getLayer(safeLayerSticker.layerId)!;
    assert.equal(safeLayer.audience, 'all-players'); assert.equal(safeLayer.visible, true); assert.equal(safeLayer.locked, false);
    assert.throws(() => executeBoardCommand(store, ari, { type: 'object:update', id: 'not-a-sticker', changes: { x: 50 } }), /не найден/i);
  } finally { store.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test('layer deletion must preserve or explicitly remove its objects and assets remain shared', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tabletop-board-layers-'));
  const store = new RoomStore(dataDir, 'Test');
  try {
    const source = store.getLayers()[0]!;
    const target = store.createLayer('Target');
    store.createAsset({ id: 'shared', sha256: 'shared-hash', mimeType: 'image/png', originalName: 'shared.png', size: 22, width: 4, height: 3 });
    executeBoardCommand(store, gm, { type: 'object:create', assetId: 'shared', layerId: source.id });
    const object = store.getObjects()[0]!;
    assert.throws(() => executeBoardCommand(store, gm, { type: 'layer:delete', id: source.id }), /переместите объекты/i);
    executeBoardCommand(store, gm, { type: 'layer:delete', id: source.id, targetLayerId: target.id });
    assert.equal(store.getObject(object.id)?.layerId, target.id);
    executeBoardCommand(store, gm, { type: 'object:duplicate', id: object.id });
    assert.equal(store.getObjects().length, 2);
    assert.equal(new Set(store.getObjects().map((item) => item.assetId)).size, 1);
    assert.equal(store.getAssets().length, 1);
    assert.throws(() => executeBoardCommand(store, gm, { type: 'layer:delete', id: target.id, deleteObjects: true }), /хотя бы один слой/i);
  } finally { store.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test('crop and dimensions persist per object without changing a shared source asset or sibling object', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tabletop-board-crop-'));
  let store = new RoomStore(dataDir, 'Test');
  const layer = store.getLayers()[0]!;
  store.createAsset({ id: 'source', sha256: 'source-hash', mimeType: 'image/png', originalName: 'original.png', size: 22, width: 1000, height: 800 });
  executeBoardCommand(store, gm, { type: 'object:create', assetId: 'source', layerId: layer.id });
  executeBoardCommand(store, gm, { type: 'object:create', assetId: 'source', layerId: layer.id });
  const [cropped, untouched] = store.getObjects();
  assert.ok(cropped && untouched);
  const crop = { x: 0.2, y: 0.125, width: 0.6, height: 0.5 };
  executeBoardCommand(store, gm, { type: 'object:update', id: cropped.id, changes: { crop, width: 600, height: 480, freeStretch: true } });
  store.close();

  store = new RoomStore(dataDir, 'Test');
  try {
    assert.deepEqual(store.getObject(cropped.id)?.crop, crop);
    assert.equal(store.getObject(cropped.id)?.freeStretch, true);
    assert.deepEqual({ width: store.getObject(cropped.id)?.width, height: store.getObject(cropped.id)?.height }, { width: 600, height: 480 });
    assert.equal(store.getObject(untouched.id)?.crop, null);
    assert.equal(store.getObject(untouched.id)?.freeStretch, false);
    assert.deepEqual({ width: store.getAsset('source')?.width, height: store.getAsset('source')?.height }, { width: 1000, height: 800 });
  } finally { store.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test('server enforces natural proportions unless free stretch is enabled for that object', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tabletop-board-ratio-'));
  const store = new RoomStore(dataDir, 'Test');
  try {
    const layer = store.getLayers()[0]!;
    store.createAsset({ id: 'wide', sha256: 'wide-hash', mimeType: 'image/png', originalName: 'wide.png', size: 22, width: 1000, height: 800 });
    executeBoardCommand(store, gm, { type: 'object:create', assetId: 'wide', layerId: layer.id });
    const object = store.getObjects()[0]!;
    executeBoardCommand(store, gm, { type: 'object:update', id: object.id, changes: { width: 500 } });
    assert.deepEqual({ width: store.getObject(object.id)?.width, height: store.getObject(object.id)?.height }, { width: 500, height: 400 });
    executeBoardCommand(store, gm, { type: 'object:update', id: object.id, changes: { height: 1000 } });
    assert.deepEqual({ width: store.getObject(object.id)?.width, height: store.getObject(object.id)?.height }, { width: 1250, height: 1000 });
    executeBoardCommand(store, gm, { type: 'object:update', id: object.id, changes: { freeStretch: true, width: 500, height: 1000 } });
    assert.deepEqual({ width: store.getObject(object.id)?.width, height: store.getObject(object.id)?.height }, { width: 500, height: 1000 });
    executeBoardCommand(store, gm, { type: 'object:update', id: object.id, changes: { freeStretch: false } });
    assert.deepEqual({ width: store.getObject(object.id)?.width, height: store.getObject(object.id)?.height }, { width: 500, height: 400 });
  } finally { store.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test('existing object tables receive the free-stretch column without losing legacy rows', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tabletop-board-migration-'));
  const legacy = new Database(join(dataDir, 'room.sqlite'));
  legacy.exec(`
    CREATE TABLE board_layers (id TEXT PRIMARY KEY, name TEXT NOT NULL, order_index INTEGER NOT NULL, visible INTEGER NOT NULL, locked INTEGER NOT NULL, audience TEXT NOT NULL);
    CREATE TABLE assets (id TEXT PRIMARY KEY, sha256 TEXT NOT NULL, mime_type TEXT NOT NULL, original_name TEXT NOT NULL, size INTEGER NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE board_objects (
      id TEXT PRIMARY KEY, asset_id TEXT NOT NULL REFERENCES assets(id), layer_id TEXT NOT NULL REFERENCES board_layers(id),
      x REAL NOT NULL, y REAL NOT NULL, width REAL NOT NULL, height REAL NOT NULL, order_index INTEGER NOT NULL,
      flip_x INTEGER NOT NULL DEFAULT 0, flip_y INTEGER NOT NULL DEFAULT 0, crop_json TEXT,
      allow_player_move INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO board_layers VALUES ('legacy-layer', 'Legacy', 0, 1, 0, 'all-players');
    INSERT INTO assets (id, sha256, mime_type, original_name, size, width, height) VALUES ('legacy-asset', 'legacy-hash', 'image/png', 'legacy.png', 10, 800, 600);
    INSERT INTO board_objects (id, asset_id, layer_id, x, y, width, height, order_index, crop_json) VALUES ('legacy-object', 'legacy-asset', 'legacy-layer', 25, 40, 400, 300, 0, '{"x":0.1,"y":0.2,"width":0.7,"height":0.6}');
  `);
  legacy.close();
  const store = new RoomStore(dataDir, 'Test');
  try {
    const restored = store.getObject('legacy-object');
    assert.equal(restored?.freeStretch, false);
    assert.deepEqual(restored?.crop, { x: 0.1, y: 0.2, width: 0.7, height: 0.6 });
    assert.deepEqual({ x: restored?.x, y: restored?.y, width: restored?.width, height: restored?.height }, { x: 25, y: 40, width: 400, height: 300 });
  } finally { store.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test('legacy plum sticker text color migrates to white and preserves sticker data', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tabletop-board-sticker-migration-'));
  const legacy = new Database(join(dataDir, 'room.sqlite'));
  legacy.exec(`
    CREATE TABLE room (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    INSERT INTO room (id, name) VALUES (1, 'Legacy room');
    CREATE TABLE board_layers (id TEXT PRIMARY KEY, name TEXT NOT NULL, order_index INTEGER NOT NULL, visible INTEGER NOT NULL, locked INTEGER NOT NULL, audience TEXT NOT NULL);
    INSERT INTO board_layers VALUES ('layer-old', 'Main', 0, 1, 0, 'all-players');
    CREATE TABLE stickers (
      id TEXT PRIMARY KEY, creator_id TEXT NOT NULL, layer_id TEXT NOT NULL REFERENCES board_layers(id) ON DELETE RESTRICT,
      text TEXT NOT NULL, x REAL NOT NULL, y REAL NOT NULL, width REAL NOT NULL, height REAL NOT NULL,
      bg_color TEXT NOT NULL CHECK (bg_color IN ('butter', 'rose', 'sky', 'sage')),
      text_color TEXT NOT NULL CHECK (text_color IN ('ink', 'plum')), font_size INTEGER NOT NULL, order_index INTEGER NOT NULL
    );
    CREATE INDEX stickers_layer_order ON stickers(layer_id, order_index);
    INSERT INTO stickers VALUES ('sticker-old', 'player-old', 'layer-old', 'Saved', 12, 34, 240, 140, 'sky', 'plum', 24, 7);
  `);
  legacy.close();
  const store = new RoomStore(dataDir, 'Ignored');
  try {
    assert.deepEqual(store.getSticker('sticker-old'), { id: 'sticker-old', creatorId: 'player-old', layerId: 'layer-old', text: 'Saved', x: 12, y: 34, width: 240, height: 140, bgColor: 'sky', textColor: 'white', fontSize: 24, orderIndex: 7 });
    assert.equal((store.db.prepare('SELECT text_color FROM stickers WHERE id = ?').get('sticker-old') as { text_color: string }).text_color, 'white');
  } finally { store.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test('legacy notes receive text-marker defaults without losing note content', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tabletop-board-note-migration-'));
  const legacy = new Database(join(dataDir, 'room.sqlite'));
  legacy.exec(`
    CREATE TABLE room (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    INSERT INTO room (id, name) VALUES (1, 'Legacy room');
    CREATE TABLE notes (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL,
      access TEXT NOT NULL CHECK (access IN ('gm-only', 'all-players', 'selected-players')),
      selected_participant_ids TEXT NOT NULL DEFAULT '[]', created_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO notes (id, title, body, access, selected_participant_ids, created_by) VALUES ('note-old', 'Old title', 'Saved body', 'all-players', '[]', 'gm-old');
  `);
  legacy.close();
  const store = new RoomStore(dataDir, 'Ignored');
  try {
    const note = store.getNote('note-old')!;
    assert.equal(note.title, 'Old title'); assert.equal(note.body, 'Saved body');
    assert.equal(note.markerType, 'text'); assert.equal(note.markerText, 'Old title');
    assert.equal(note.markerAssetId, undefined);
  } finally { store.close(); rmSync(dataDir, { recursive: true, force: true }); }
});
