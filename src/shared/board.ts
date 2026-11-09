export type LayerAudience = 'gm-only' | 'all-players';

export interface BoardLayer {
  id: string;
  name: string;
  orderIndex: number;
  visible: boolean;
  locked: boolean;
  audience: LayerAudience;
}

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BoardImage {
  id: string;
  assetId: string;
  layerId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  orderIndex: number;
  flipX: boolean;
  flipY: boolean;
  crop: CropRect | null;
  allowPlayerMove: boolean;
}

export interface BoardAsset {
  id: string;
  sha256: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  originalName: string;
  size: number;
  width: number;
  height: number;
  createdAt: string;
}

export interface BoardSnapshot {
  layers: BoardLayer[];
  objects: BoardImage[];
  assets?: BoardAsset[];
}

export interface BoardStateMessage extends BoardSnapshot {
  type: 'room:state';
  roomName: string;
  identity: { name: string; role: 'gm' | 'player' };
  maxUploadBytes?: number;
}
