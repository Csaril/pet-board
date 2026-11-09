import assert from 'node:assert/strict';
import test from 'node:test';
import { cameraForBounds, isValidCamera, screenToWorld, worldToScreen, zoomKeepingScreenPoint } from '../src/shared/camera.js';

test('camera coordinate transforms and 100 percent zoom preserve the screen center world point', () => {
  const camera = { x: -215, y: 86, scale: 1.7 };
  const point = { x: 480, y: 320 };
  const world = screenToWorld(point, camera);
  assert.deepEqual(worldToScreen(world, camera), point);
  const reset = zoomKeepingScreenPoint(camera, point, 1);
  assert.equal(reset.scale, 1);
  assert.deepEqual(screenToWorld(point, reset), world);
});

test('fit centers visible bounds, fits them with padding, and centers an empty board at origin', () => {
  const viewport = { width: 1000, height: 700 };
  const bounds = { minX: -300, minY: 120, maxX: 500, maxY: 520 };
  const fitted = cameraForBounds(bounds, viewport.width, viewport.height, 64);
  const first = worldToScreen({ x: bounds.minX, y: bounds.minY }, fitted);
  const last = worldToScreen({ x: bounds.maxX, y: bounds.maxY }, fitted);
  assert.ok(first.x >= 64 && first.y >= 64);
  assert.ok(last.x <= viewport.width - 64 && last.y <= viewport.height - 64);
  assert.deepEqual(worldToScreen({ x: 0, y: 0 }, cameraForBounds(undefined, viewport.width, viewport.height)), { x: 500, y: 350 });
});

test('camera storage validation rejects stale, malformed, and out-of-range values', () => {
  assert.equal(isValidCamera({ x: 20, y: -50, scale: 1 }), true);
  assert.equal(isValidCamera({ x: 9e20, y: 0, scale: 1 }), false);
  assert.equal(isValidCamera({ x: 0, y: 0, scale: 0 }), false);
  assert.equal(isValidCamera(null), false);
});
