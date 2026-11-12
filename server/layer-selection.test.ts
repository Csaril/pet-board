import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { isImagePickable, isLayerPickable } from '../src/shared/layer-selection.js';

const clientSource = readFileSync('src/client/app.ts', 'utf8');

test('board hit testing: active layer, player permission and pointer wiring', async (t) => {
  await t.test('1. GM picks only items from the active layer', () => {
    assert.equal(isLayerPickable('gm', 'active', 'active'), true);
    assert.equal(isLayerPickable('gm', 'other', 'active'), false);
  });

  await t.test('2. GM cannot pick anything before an active layer is known', () => {
    assert.equal(isLayerPickable('gm', 'any', undefined), false);
  });

  await t.test('3. Players keep the previous layer behaviour', () => {
    assert.equal(isLayerPickable('player', 'active', 'active'), true);
    assert.equal(isLayerPickable('player', 'other', 'active'), true);
    assert.equal(isLayerPickable('player', 'other', undefined), true);
  });

  await t.test('4. Players only pick images with the existing move permission', () => {
    assert.equal(isImagePickable('player', 'layer', 'active', true), true);
    assert.equal(isImagePickable('player', 'layer', 'active', false), false);
    // A missing identity behaves like a player until state arrives.
    assert.equal(isImagePickable(undefined, 'layer', 'active', false), false);
    assert.equal(isImagePickable(undefined, 'layer', 'active', true), true);
  });

  await t.test('5. The GM ignores the player permission and keeps active-layer selection', () => {
    assert.equal(isImagePickable('gm', 'active', 'active', false), true);
    assert.equal(isImagePickable('gm', 'other', 'active', true), false);
    assert.equal(isImagePickable('gm', 'active', undefined, true), false);
  });

  await t.test('6. Images use the permission-aware filter for listening and dragging', () => {
    assert.match(clientSource, /import \{ isImagePickable, isLayerPickable \} from '\.\.\/shared\/layer-selection\.js';/);
    assert.match(clientSource, /const pickable = isImagePickable\(identity\?\.role, layer\.id, activeLayerId, item\.allowPlayerMove\);/);
    assert.match(clientSource, /const group = new Konva\.Group\(\{\n\s+x: item\.x, y: item\.y,[\s\S]*?listening: pickable,/);
    assert.match(clientSource, /new Konva\.Image\(\{ image: htmlImage, listening: pickable \}\)/);
    assert.match(clientSource, /draggable: pickable && canMove\(item, layer\)/);
    // Stickers and note markers still use the role/layer rule only.
    assert.equal(clientSource.match(/const pickable = isLayerPickable\(identity\?\.role, layer\.id, activeLayerId\);/g)?.length, 2);
  });

  await t.test('7. Programmatic selection rejects forbidden images', () => {
    assert.match(clientSource, /if \(!item \|\| !layer \|\| !isImagePickable\(identity\?\.role, layer\.id, activeLayerId, item\.allowPlayerMove\)\) id = undefined;/);
    assert.match(clientSource, /if \(object && objectLayer && !isImagePickable\(identity\?\.role, objectLayer\.id, activeLayerId, object\.allowPlayerMove\)\) selectedObjectId = undefined;/);
  });

  await t.test('8. Camera panning still starts only when the stage itself is the target', () => {
    assert.match(clientSource, /stage\.on\('mousedown touchstart', \(event\) => \{\n\s*if \(event\.target !== stage \|\| cropMode\) return;/);
    assert.match(clientSource, /stage\.on\('click tap', \(event\) => \{\n\s*if \(event\.target !== stage\) return;/);
  });

  await t.test('9. GM editing tools and layer switches still honour the active layer', () => {
    assert.match(clientSource, /const canEditSticker = [^;]*isLayerPickable\(identity\?\.role, stickerLayer\.id, activeLayerId\)/);
    assert.match(clientSource, /const canResizeMarker = [^;]*isLayerPickable\(identity\?\.role, markerLayer\.id, activeLayerId\)/);
    assert.match(clientSource, /const editable = isGm && !layer\.locked && isLayerPickable\(identity\?\.role, layer\.id, activeLayerId\)/);
    assert.match(clientSource, /function setActiveLayer\(layerId: string\): void \{[\s\S]*?clearSelectionOutsideActiveLayer\(\);[\s\S]*?drawObjects\(\);/);
    assert.match(clientSource, /choose\.addEventListener\('click', \(\) => setActiveLayer\(layer\.id\)\)/);
    assert.match(clientSource, /function clearSelectionOutsideActiveLayer\(\): void \{[\s\S]*?selectedObjectId = undefined;[\s\S]*?cropMode = false;[\s\S]*?markerResizeMode = false;/);
    assert.match(clientSource, /clearSelectionOutsideActiveLayer\(\);\n\s*renderLayers\(\);/);
  });
});
