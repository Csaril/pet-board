import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { executeBoardCommand } from './board.js';
import { RoomStore } from './store.js';

const gm = { name: 'Keeper', role: 'gm' as const };
const player = { name: 'Ari', role: 'player' as const };

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
