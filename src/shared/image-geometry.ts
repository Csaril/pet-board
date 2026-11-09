import type { CropRect } from './board.js';

export interface Rect { x: number; y: number; width: number; height: number }

export function cropToDisplayRect(crop: CropRect | null, width: number, height: number, flipX = false, flipY = false): Rect {
  const value = crop ?? { x: 0, y: 0, width: 1, height: 1 };
  return {
    x: (flipX ? 1 - value.x - value.width : value.x) * width,
    y: (flipY ? 1 - value.y - value.height : value.y) * height,
    width: value.width * width,
    height: value.height * height,
  };
}

export function displayRectToCrop(rect: Rect, width: number, height: number, flipX = false, flipY = false): CropRect {
  const displayX = rect.x / width;
  const displayY = rect.y / height;
  const cropWidth = rect.width / width;
  const cropHeight = rect.height / height;
  return {
    x: flipX ? 1 - displayX - cropWidth : displayX,
    y: flipY ? 1 - displayY - cropHeight : displayY,
    width: cropWidth,
    height: cropHeight,
  };
}

export function clampRect(rect: Rect, width: number, height: number, minSize = 1): Rect {
  const x = Math.max(0, Math.min(width - minSize, rect.x));
  const y = Math.max(0, Math.min(height - minSize, rect.y));
  return {
    x, y,
    width: Math.max(minSize, Math.min(width - x, rect.width)),
    height: Math.max(minSize, Math.min(height - y, rect.height)),
  };
}

export function transformedSize(width: number, height: number, scaleX: number, scaleY: number, freeStretch: boolean, sourceAspectRatio: number): { width: number; height: number } {
  if (freeStretch) return { width: Math.max(1, width * Math.abs(scaleX)), height: Math.max(1, height * Math.abs(scaleY)) };
  const nextWidth = Math.max(1, width * Math.abs(scaleX));
  return { width: nextWidth, height: Math.max(1, nextWidth / sourceAspectRatio) };
}

export function lockTransformScales(width: number, height: number, scaleX: number, scaleY: number, sourceAspectRatio: number): { scaleX: number; scaleY: number } {
  const changedX = Math.abs(Math.abs(scaleX) - 1);
  const changedY = Math.abs(Math.abs(scaleY) - 1);
  const scale = changedX >= changedY ? Math.abs(scaleX) : Math.abs(scaleY);
  return {
    scaleX: Math.sign(scaleX || 1) * scale,
    scaleY: Math.sign(scaleY || 1) * scale * width / height / sourceAspectRatio,
  };
}
