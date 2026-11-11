import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { BoardAsset, BoardAssetUsage } from '../src/shared/board.js';
import type { RoomStore } from './store.js';
import { inspectImage, UnsupportedImageError } from './images.js';

export { UnsupportedImageError };

const ASSET_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class AssetStorageError extends Error {}
export class AssetNotFoundError extends Error {}
export class AssetInUseError extends Error {
  constructor(readonly usage: BoardAssetUsage[]) {
    super('Изображение используется в комнате и не может быть удалено.');
    this.name = 'AssetInUseError';
  }
}

interface AssetDeleteOperations {
  /** Test seam for verifying compensation when a filesystem operation fails. */
  unlink?: (path: string) => Promise<void>;
}

function assetsDirectory(dataDir: string): string {
  return resolve(dataDir, 'assets');
}

function assertAssetId(id: string): void {
  if (!ASSET_ID_PATTERN.test(id)) throw new AssetStorageError('Некорректный идентификатор изображения.');
}

function originalAssetPath(dataDir: string, id: string): string {
  assertAssetId(id);
  const directory = assetsDirectory(dataDir);
  const path = resolve(directory, id);
  if (dirname(path) !== directory) throw new AssetStorageError('Путь к изображению находится вне хранилища.');
  return path;
}

function safeAssetFile(directory: string, id: string, name: string): string | undefined {
  if (name !== id && !name.startsWith(`${id}.`) && !name.startsWith(`${id}-`)) return undefined;
  const path = resolve(directory, name);
  if (dirname(path) !== directory) return undefined;
  return path;
}

async function listAssetFiles(dataDir: string, id: string): Promise<Array<{ name: string; path: string }>> {
  const directory = assetsDirectory(dataDir);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return entries.flatMap((entry) => {
    const path = safeAssetFile(directory, id, entry.name);
    return path ? [{ name: entry.name, path }] : [];
  });
}

/**
 * Removes the database record, the original file and any id-based derived files.
 *
 * Files are first moved to a temporary sibling name, then the database row is
 * deleted, and only after that are the temporary files unlinked. If the row
 * cannot be deleted or a filesystem operation fails, the row and all still
 * existing files are restored. This keeps the visible library and the disk in
 * a consistent state and never follows a user-controlled path outside assets/.
 */
export async function deleteImageAsset(
  store: RoomStore,
  dataDir: string,
  assetId: string,
  operations: AssetDeleteOperations = {},
): Promise<void> {
  originalAssetPath(dataDir, assetId);
  const asset = store.getAsset(assetId);
  if (!asset) throw new AssetNotFoundError('Изображение не найдено.');
  const usage = store.getAssetUsage(assetId);
  if (usage.length > 0) throw new AssetInUseError(usage);

  const files = await listAssetFiles(dataDir, assetId);
  const suffix = `.deleting-${randomUUID()}`;
  const staged: Array<{ name: string; original: string; temporary: string }> = [];
  const restoreStaged = async (): Promise<void> => {
    for (const file of [...staged].reverse()) await rename(file.temporary, file.original).catch(() => undefined);
  };

  try {
    for (const file of files) {
      const temporary = `${file.path}${suffix}`;
      await rename(file.path, temporary);
      staged.push({ name: file.name, original: file.path, temporary });
    }
  } catch (error) {
    await restoreStaged();
    throw error;
  }

  try {
    if (!store.deleteAssetIfUnused(assetId)) {
      const currentUsage = store.getAssetUsage(assetId);
      await restoreStaged();
      throw new AssetInUseError(currentUsage);
    }
  } catch (error) {
    if (!(error instanceof AssetInUseError)) await restoreStaged();
    throw error;
  }

  const remove = operations.unlink ?? unlink;
  let failure: unknown;
  // The original is deleted last so a failed deletion can always be restored.
  staged.sort((left, right) => Number(left.name === assetId) - Number(right.name === assetId));
  for (const file of staged) {
    try {
      await remove(file.temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      failure = error;
      break;
    }
  }

  if (failure) {
    try {
      store.restoreAsset(asset);
    } catch (error) {
      throw new AssetStorageError(`Не удалось восстановить запись изображения после ошибки файловой системы: ${error instanceof Error ? error.message : 'неизвестная ошибка'}`);
    }
    await restoreStaged();
    throw failure;
  }
}

export async function saveImageAsset(
  store: RoomStore,
  dataDir: string,
  bytes: Buffer,
  claimedMime: string,
  originalName: string,
  maxBytes: number,
  uploadedById?: string,
): Promise<{ asset: BoardAsset; deduplicated: boolean }> {
  if (bytes.length === 0 || bytes.length > maxBytes) throw new UnsupportedImageError('Размер файла превышает установленный лимит.');
  const info = inspectImage(bytes, claimedMime);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const existing = store.findAsset(sha256, info.mimeType);
  if (existing) {
    if (uploadedById) store.recordAssetUploader(existing.id, uploadedById);
    return { asset: existing, deduplicated: true };
  }

  const safeName = originalName.split(/[\\/]/).pop()?.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 255) || 'image';
  const asset = {
    id: randomUUID(), sha256, mimeType: info.mimeType, originalName: safeName,
    size: bytes.length, width: info.width, height: info.height,
  } satisfies Omit<BoardAsset, 'createdAt'>;
  const assetDir = assetsDirectory(dataDir);
  await mkdir(assetDir, { recursive: true, mode: 0o700 });
  await chmod(assetDir, 0o700);
  const filePath = join(assetDir, asset.id);
  await writeFile(filePath, bytes, { flag: 'wx', mode: 0o600 });
  try {
    store.createAsset(asset);
    if (uploadedById) store.recordAssetUploader(asset.id, uploadedById);
    const saved = store.getAsset(asset.id);
    if (!saved) throw new Error('Stored asset could not be read back.');
    return { asset: saved, deduplicated: false };
  } catch (error) {
    await unlink(filePath).catch(() => undefined);
    const duplicate = store.findAsset(sha256, info.mimeType);
    if (duplicate) {
      if (uploadedById) store.recordAssetUploader(duplicate.id, uploadedById);
      return { asset: duplicate, deduplicated: true };
    }
    throw error;
  }
}
