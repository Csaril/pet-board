export interface Camera { x: number; y: number; scale: number }
export interface Point { x: number; y: number }
export interface Bounds { minX: number; minY: number; maxX: number; maxY: number }

export function screenToWorld(point: Point, camera: Camera): Point {
  return { x: (point.x - camera.x) / camera.scale, y: (point.y - camera.y) / camera.scale };
}

export function worldToScreen(point: Point, camera: Camera): Point {
  return { x: point.x * camera.scale + camera.x, y: point.y * camera.scale + camera.y };
}

export function zoomKeepingScreenPoint(camera: Camera, point: Point, scale: number): Camera {
  const worldPoint = screenToWorld(point, camera);
  return { x: point.x - worldPoint.x * scale, y: point.y - worldPoint.y * scale, scale };
}

export function cameraForBounds(bounds: Bounds | undefined, width: number, height: number, padding = 64, maxZoom = 4): Camera {
  const center = { x: width / 2, y: height / 2 };
  if (!bounds) return { x: center.x, y: center.y, scale: 1 };
  const boundsWidth = Math.max(1, bounds.maxX - bounds.minX);
  const boundsHeight = Math.max(1, bounds.maxY - bounds.minY);
  const scale = Math.min(maxZoom, Math.max(1, width - padding * 2) / boundsWidth, Math.max(1, height - padding * 2) / boundsHeight);
  return {
    x: center.x - ((bounds.minX + bounds.maxX) / 2) * scale,
    y: center.y - ((bounds.minY + bounds.maxY) / 2) * scale,
    scale,
  };
}

export function isValidCamera(value: unknown, maxCoordinate = 40_000_000, minScale = 0.00001, maxScale = 4): value is Camera {
  if (!value || typeof value !== 'object') return false;
  const camera = value as Partial<Camera>;
  return Number.isFinite(camera.x) && Math.abs(camera.x!) <= maxCoordinate
    && Number.isFinite(camera.y) && Math.abs(camera.y!) <= maxCoordinate
    && Number.isFinite(camera.scale) && camera.scale! >= minScale && camera.scale! <= maxScale;
}
