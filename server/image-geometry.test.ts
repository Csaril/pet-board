import assert from 'node:assert/strict';
import test from 'node:test';
import type { CropRect } from '../src/shared/board.js';
import { cropToDisplayRect, displayRectToCrop, lockTransformScales, transformedSize } from '../src/shared/image-geometry.js';

test('locked resize preserves source aspect ratio and free stretch uses independent scales', () => {
  const horizontal = lockTransformScales(500, 400, 1.5, 1, 5 / 4);
  const vertical = lockTransformScales(500, 400, 1, 1.5, 5 / 4);
  assert.deepEqual(transformedSize(500, 400, horizontal.scaleX, horizontal.scaleY, false, 5 / 4), { width: 750, height: 600 });
  assert.deepEqual(transformedSize(500, 400, vertical.scaleX, vertical.scaleY, false, 5 / 4), { width: 750, height: 600 });
  const distorted = lockTransformScales(500, 300, 1, 1.5, 5 / 4);
  assert.deepEqual(transformedSize(500, 300, distorted.scaleX, distorted.scaleY, false, 5 / 4), { width: 750, height: 600 });
  assert.deepEqual(transformedSize(500, 400, 1.5, 0.75, true, 5 / 4), { width: 750, height: 300 });
});

test('crop is a mask in display coordinates and survives repeated editing with both flips', () => {
  const crop: CropRect = { x: 0.2, y: 0.1, width: 0.6, height: 0.5 };
  const display = cropToDisplayRect(crop, 500, 400, true, false);
  assert.ok(Math.abs(display.x - 100) < 1e-10);
  assert.ok(Math.abs(display.y - 40) < 1e-10);
  assert.ok(Math.abs(display.width - 300) < 1e-10);
  assert.ok(Math.abs(display.height - 200) < 1e-10);
  const restoredX = displayRectToCrop(display, 500, 400, true, false);
  assert.ok(Math.abs(restoredX.x - crop.x) < 1e-10);
  assert.ok(Math.abs(restoredX.y - crop.y) < 1e-10);
  assert.ok(Math.abs(restoredX.width - crop.width) < 1e-10);
  assert.ok(Math.abs(restoredX.height - crop.height) < 1e-10);
  const bothFlipped = cropToDisplayRect(crop, 500, 400, true, true);
  const restoredBoth = displayRectToCrop(bothFlipped, 500, 400, true, true);
  assert.ok(Math.abs(restoredBoth.x - crop.x) < 1e-10);
  assert.ok(Math.abs(restoredBoth.y - crop.y) < 1e-10);
  assert.equal(display.width, 300);
  assert.equal(display.height, 200);
});

test('moving or resizing the crop mask does not mutate another image instance', () => {
  const sharedAsset = { id: 'asset' };
  const first = { assetId: sharedAsset.id, crop: null as CropRect | null, x: 100, y: 200, width: 1000, height: 800 };
  const second = { assetId: sharedAsset.id, crop: null as CropRect | null, x: 300, y: 400, width: 1000, height: 800 };
  const confirmed = displayRectToCrop({ x: 200, y: 100, width: 600, height: 400 }, first.width, first.height);
  first.crop = confirmed;
  assert.equal(second.crop, null);
  assert.deepEqual(cropToDisplayRect(first.crop, first.width, first.height), { x: 200, y: 100, width: 600, height: 400 });
  assert.deepEqual(cropToDisplayRect(second.crop, second.width, second.height), { x: 0, y: 0, width: 1000, height: 800 });
});
