import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BoardAsset } from '../src/shared/board.js';
import type { RoomStore } from './store.js';
import { inspectImage, UnsupportedImageError } from './images.js';

export { UnsupportedImageError };

export async function saveImageAsset(
  store: RoomStore,
  dataDir: string,
  bytes: Buffer,
  claimedMime: string,
  originalName: string,
  maxBytes: number,
): Promise<{ asset: BoardAsset; deduplicated: boolean }> {
  if (bytes.length === 0 || bytes.length > maxBytes) throw new UnsupportedImageError('Размер файла превышает установленный лимит.');
  const info = inspectImage(bytes, claimedMime);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const existing = store.findAsset(sha256, info.mimeType);
  if (existing) return { asset: existing, deduplicated: true };

  const safeName = originalName.split(/[\\/]/).pop()?.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 255) || 'image';
  const asset = {
    id: randomUUID(), sha256, mimeType: info.mimeType, originalName: safeName,
    size: bytes.length, width: info.width, height: info.height,
  } satisfies Omit<BoardAsset, 'createdAt'>;
  const assetDir = join(dataDir, 'assets');
  await mkdir(assetDir, { recursive: true, mode: 0o700 });
  await chmod(assetDir, 0o700);
  const filePath = join(assetDir, asset.id);
  await writeFile(filePath, bytes, { flag: 'wx', mode: 0o600 });
  try {
    store.createAsset(asset);
    const saved = store.getAsset(asset.id);
    if (!saved) throw new Error('Stored asset could not be read back.');
    return { asset: saved, deduplicated: false };
  } catch (error) {
    await unlink(filePath).catch(() => undefined);
    const duplicate = store.findAsset(sha256, info.mimeType);
    if (duplicate) return { asset: duplicate, deduplicated: true };
    throw error;
  }
}
