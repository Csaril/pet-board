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

test('notes stay out of board projections and sticker commands enforce setting and ownership', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tabletop-board-notes-'));
  const store = new RoomStore(dataDir, 'Test');
  const gmIdentity = { ...gm, participantId: 'gm-note-session' };
  const ari = { ...player, participantId: 'ari-note-session' };
  const bea = { name: 'Bea', role: 'player' as const, participantId: 'bea-note-session' };
  try {
    const layer = store.getLayers()[0]!;
    store.createSession(ari.participantId, { name: ari.name, role: 'player' }, Date.now() + 60_000);
    store.createSession(bea.participantId, { name: bea.name, role: 'player' }, Date.now() + 60_000);
    store.createNote({ id: 'note-public', title: 'Public', body: 'Secret payload', access: 'all-players', selectedParticipantIds: [], creatorId: gmIdentity.participantId, assetIds: [] });
    store.createNote({ id: 'note-selected', title: 'Selected', body: 'For Ari', access: 'selected-players', selectedParticipantIds: [ari.participantId], creatorId: gmIdentity.participantId, assetIds: [] });
    store.createNote({ id: 'note-private', title: 'Private', body: 'GM only', access: 'gm-only', selectedParticipantIds: [], creatorId: gmIdentity.participantId, assetIds: [] });
    store.createNoteMarker({ id: 'marker-public', noteId: 'note-public', layerId: layer.id, x: 10, y: 20 });
    store.createNoteMarker({ id: 'marker-selected', noteId: 'note-selected', layerId: layer.id, x: 30, y: 40 });
    store.createNoteMarker({ id: 'marker-private', noteId: 'note-private', layerId: layer.id, x: 50, y: 60 });
    const ariProjection = store.snapshot(ari);
    assert.deepEqual(ariProjection.noteMarkers.map((marker) => marker.noteId).sort(), ['note-public', 'note-selected']);
    assert.equal(JSON.stringify(ariProjection).includes('Secret payload'), false);
    assert.deepEqual(store.snapshot(bea).noteMarkers.map((marker) => marker.noteId), ['note-public']);
    assert.equal(store.canReadNote('note-private', ari), false);
    assert.equal(store.canReadNote('note-selected', bea), false);

    const stickerCommand = { type: 'sticker:create', layerId: layer.id, text: 'Hello', x: 10, y: 20 };
    assert.throws(() => executeBoardCommand(store, ari, stickerCommand), /недоступно/i);
    executeBoardCommand(store, gmIdentity, { type: 'settings:update', changes: { allowPlayerStickers: true } });
    executeBoardCommand(store, ari, stickerCommand);
    const sticker = store.getStickers()[0]!;
    assert.equal(sticker.creatorId, ari.participantId);
    assert.throws(() => executeBoardCommand(store, bea, { type: 'sticker:update', id: sticker.id, changes: { text: 'changed' } }), /свой стикер/i);
    executeBoardCommand(store, ari, { type: 'sticker:update', id: sticker.id, changes: { x: 70 } });
    assert.equal(store.getSticker(sticker.id)?.x, 70);
    store.setAllowPlayerStickers(false);
    assert.throws(() => executeBoardCommand(store, ari, { type: 'sticker:create', layerId: layer.id, text: 'No', x: 0, y: 0 }), /недоступно/i);
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
