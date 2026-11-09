import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import test from 'node:test';
import { saveImageAsset } from './assets.js';
import { inspectImage, UnsupportedImageError } from './images.js';
import { RoomStore } from './store.js';

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function png(width: number, height: number, color: number): Buffer {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const chunk = (name: string, data: Buffer) => {
    const type = Buffer.from(name);
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(Buffer.concat([type, data])));
    return Buffer.concat([length, type, data, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 6;
  const row = Buffer.alloc(1 + width * 4);
  for (let x = 0; x < width; x += 1) { row[1 + x * 4] = color; row[4 + x * 4] = 255; }
  const data = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([signature, chunk('IHDR', header), chunk('IDAT', deflateSync(data)), chunk('IEND', Buffer.alloc(0))]);
}

test('image signature and MIME must agree and image dimensions are read from file content', () => {
  const bytes = png(2, 1, 90);
  assert.deepEqual(inspectImage(bytes, 'image/png'), { mimeType: 'image/png', width: 2, height: 1 });
  const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAAaADAAQAAAABAAAAAQAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgAAQABAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8AAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/bAEMAAgICAgICAwICAwUDAwMFBgUFBQUGCAYGBgYGCAoICAgICAgKCgoKCgoKCgwMDAwMDA4ODg4ODw8PDw8PDw8PD//bAEMBAgICBAQEBwQEBxALCQsQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEP/dAAQAAf/aAAwDAQACEQMRAD8A+R6KKK/Hz/VA/9k=', 'base64');
  const webp = Buffer.from('UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAdQjyIXpf+BiOh/AAA=', 'base64');
  assert.deepEqual(inspectImage(jpeg, 'image/jpeg'), { mimeType: 'image/jpeg', width: 1, height: 1 });
  assert.deepEqual(inspectImage(webp, 'image/webp'), { mimeType: 'image/webp', width: 1, height: 1 });
  assert.throws(() => inspectImage(bytes, 'image/jpeg'), UnsupportedImageError);
  assert.throws(() => inspectImage(Buffer.from('not an image'), 'image/png'), UnsupportedImageError);
  const damaged = Buffer.from(bytes); damaged[29] ^= 0xff;
  assert.throws(() => inspectImage(damaged, 'image/png'), /CRC/);
});

test('asset upload deduplicates by content and MIME, not by file name', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tabletop-assets-'));
  const store = new RoomStore(dataDir, 'Assets');
  try {
    const firstBytes = png(1, 1, 30);
    const first = await saveImageAsset(store, dataDir, firstBytes, 'image/png', '../../map.png', 1024 * 1024);
    const sameContent = await saveImageAsset(store, dataDir, firstBytes, 'image/png', 'renamed-map.png', 1024 * 1024);
    const differentContent = await saveImageAsset(store, dataDir, png(1, 1, 220), 'image/png', 'map.png', 1024 * 1024);
    assert.equal(first.deduplicated, false);
    assert.equal(sameContent.deduplicated, true);
    assert.equal(sameContent.asset.id, first.asset.id);
    assert.equal(sameContent.asset.originalName, 'map.png');
    assert.equal(differentContent.deduplicated, false);
    assert.notEqual(differentContent.asset.id, first.asset.id);
    assert.equal(store.getAssets().length, 2);
    assert.equal(readdirSync(join(dataDir, 'assets')).length, 2);
    assert.equal(first.asset.width, 1);
    assert.equal(first.asset.height, 1);
    const layer = store.getLayers()[0]!;
    store.createObject({
      id: 'crop-check', assetId: first.asset.id, layerId: layer.id, x: 0, y: 0, width: 1, height: 1,
      orderIndex: 0, flipX: false, flipY: false, crop: null, allowPlayerMove: false,
    });
    store.updateObject('crop-check', { crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 } });
    assert.deepEqual(readFileSync(join(dataDir, 'assets', first.asset.id)), firstBytes);
  } finally { store.close(); rmSync(dataDir, { recursive: true, force: true }); }
});
