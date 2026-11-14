import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import test from 'node:test';
import { saveImageAsset } from './assets.js';
import { RoomStore } from './store.js';

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function png(color: number): Buffer {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const chunk = (name: string, data: Buffer) => {
    const type = Buffer.from(name);
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(Buffer.concat([type, data])));
    return Buffer.concat([length, type, data, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([
    signature,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([0, color, 45, 60, 255]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

test('two RoomStore instances keep databases, assets and capabilities independent', async () => {
  const pbtaDir = mkdtempSync(join(tmpdir(), 'tabletop-store-pbta-'));
  const nechDir = mkdtempSync(join(tmpdir(), 'tabletop-store-nechronica-'));
  let pbta: RoomStore | undefined;
  let nech: RoomStore | undefined;
  try {
    pbta = new RoomStore(pbtaDir, 'PbtA room');
    nech = new RoomStore(nechDir, 'Nechronica room');
    pbta.initializeSystem('pbta-2d6', '1.0.0');
    nech.initializeSystem('nechronica', '1.0.0');
    assert.equal(pbta.supportsBattleMap, false);
    assert.equal(nech.supportsBattleMap, true);
    assert.notEqual(pbta.roomDir, nech.roomDir);
    assert.equal(pbta.assetsDir, join(pbtaDir, 'assets'));
    assert.equal(nech.assetsDir, join(nechDir, 'assets'));

    const bytes = png(120);
    const first = await saveImageAsset(pbta, pbta.assetsDir, bytes, 'image/png', 'shared.png', 1024 * 1024);
    const duplicate = await saveImageAsset(pbta, pbta.assetsDir, bytes, 'image/png', 'renamed.png', 1024 * 1024);
    // SHA-256 deduplication is scoped to this room only.
    assert.equal(duplicate.deduplicated, true);
    assert.equal(duplicate.asset.id, first.asset.id);

    const other = await saveImageAsset(nech, nech.assetsDir, bytes, 'image/png', 'shared.png', 1024 * 1024);
    assert.equal(other.deduplicated, false);
    assert.notEqual(other.asset.id, first.asset.id);

    assert.ok(pbta.getAsset(first.asset.id));
    assert.equal(pbta.getAsset(other.asset.id), undefined);
    assert.ok(nech.getAsset(other.asset.id));
    assert.equal(nech.getAsset(first.asset.id), undefined);

    assert.ok(readdirSync(pbta.assetsDir).includes(first.asset.id));
    assert.ok(readdirSync(nech.assetsDir).includes(other.asset.id));
    assert.equal(readdirSync(pbta.assetsDir).includes(other.asset.id), false);

    pbta.createLayer('Only in PbtA');
    nech.createLayer('Only in Nechronica');
    assert.ok(pbta.getLayers().some((layer) => layer.name === 'Only in PbtA'));
    assert.equal(nech.getLayers().some((layer) => layer.name === 'Only in PbtA'), false);

    assert.equal(pbta.createSession('pbta-session', { name: 'Ari', role: 'player' }, Date.now() + 60_000), true);
    const participantId = pbta.getSession('pbta-session')!.participantId;
    assert.equal(nech.getSession('pbta-session'), undefined);

    // Closing one instance must not affect the other.
    pbta.close();
    pbta = undefined;
    assert.ok(nech.getAsset(other.asset.id));
    assert.ok(nech.getLayers().some((layer) => layer.name === 'Only in Nechronica'));

    const reopened = new RoomStore(pbtaDir, 'PbtA room');
    try {
      assert.equal(reopened.roomSystem.id, 'pbta-2d6');
      assert.ok(reopened.getAsset(first.asset.id));
      assert.deepEqual(reopened.getSession('pbta-session'), { participantId, name: 'Ari', role: 'player' });
      assert.ok(reopened.getLayers().some((layer) => layer.name === 'Only in PbtA'));
    } finally { reopened.close(); }
  } finally {
    pbta?.close();
    nech?.close();
    rmSync(pbtaDir, { recursive: true, force: true });
    rmSync(nechDir, { recursive: true, force: true });
  }
});
