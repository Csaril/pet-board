import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { isLayerPickable } from '../src/shared/layer-selection.js';

const clientSource = readFileSync('src/client/app.ts', 'utf8');

test('active layer hit testing 1-5: rules and wiring', async (t) => {
  await t.test('1. GM picks only items from the active layer', () => {
    assert.equal(isLayerPickable('gm', 'active', 'active'), true);
    assert.equal(isLayerPickable('gm', 'other', 'active'), false);
  });

  await t.test('2. GM cannot pick anything before an active layer is known', () => {
    assert.equal(isLayerPickable('gm', 'any', undefined), false);
  });

  await t.test('3. Players keep the previous behaviour on every layer', () => {
    assert.equal(isLayerPickable('player', 'active', 'active'), true);
    assert.equal(isLayerPickable('player', 'other', 'active'), true);
    assert.equal(isLayerPickable('player', 'other', undefined), true);
  });

  await t.test('4. Images, stickers and markers all use the filter for listening and dragging', () => {
    assert.match(clientSource, /import \{ isLayerPickable \} from '\.\.\/shared\/layer-selection\.js';/);
    assert.equal(clientSource.match(/const pickable = isLayerPickable\(identity\?\.role, layer\.id, activeLayerId\);/g)?.length, 3);
    assert.equal(clientSource.match(/listening: pickable/g)?.length, 4);
    assert.match(clientSource, /new Konva\.Image\(\{ image: htmlImage, listening: pickable \}\)/);
    assert.match(clientSource, /draggable: pickable && canMove\(item, layer\)/);
    assert.match(clientSource, /draggable: pickable && !layer\.locked && \(identity\?\.role === 'gm'/);
    assert.match(clientSource, /draggable: pickable && identity\?\.role === 'gm' && !layer\.locked/);
  });

  await t.test('5. Selection, editing tools and layer switches honour the active layer', () => {
    assert.equal(clientSource.match(/if \(!layer \|\| !isLayerPickable\(identity\?\.role, layer\.id, activeLayerId\)\) id = undefined;/g)?.length, 3);
    assert.match(clientSource, /const canEditSticker = [^;]*isLayerPickable\(identity\?\.role, stickerLayer\.id, activeLayerId\)/);
    assert.match(clientSource, /const canResizeMarker = [^;]*isLayerPickable\(identity\?\.role, markerLayer\.id, activeLayerId\)/);
    assert.match(clientSource, /const editable = isGm && !layer\.locked && isLayerPickable\(identity\?\.role, layer\.id, activeLayerId\)/);
    assert.match(clientSource, /function setActiveLayer\(layerId: string\): void \{[\s\S]*?clearSelectionOutsideActiveLayer\(\);[\s\S]*?drawObjects\(\);/);
    assert.match(clientSource, /choose\.addEventListener\('click', \(\) => setActiveLayer\(layer\.id\)\)/);
    assert.match(clientSource, /function clearSelectionOutsideActiveLayer\(\): void \{[\s\S]*?selectedObjectId = undefined;[\s\S]*?cropMode = false;[\s\S]*?markerResizeMode = false;/);
    assert.match(clientSource, /clearSelectionOutsideActiveLayer\(\);\n\s*renderLayers\(\);/);
  });

  await t.test('6. Camera panning still starts only on empty stage space', () => {
    assert.match(clientSource, /stage\.on\('mousedown touchstart', \(event\) => \{\n\s*if \(event\.target !== stage \|\| cropMode\) return;/);
    assert.match(clientSource, /stage\.on\('click tap', \(event\) => \{\n\s*if \(event\.target !== stage\) return;/);
  });
});
