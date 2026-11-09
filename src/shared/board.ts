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
  freeStretch: boolean;
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

export type NoteAccess = 'gm-only' | 'all-players' | 'selected-players';
export type StickerBackground = 'butter' | 'rose' | 'sky' | 'sage';
export type StickerTextColor = 'ink' | 'plum';

export interface BoardSticker {
  id: string;
  creatorId: string;
  layerId: string;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  bgColor: StickerBackground;
  textColor: StickerTextColor;
  fontSize: number;
  orderIndex: number;
}

export interface NoteMarker {
  id: string;
  noteId: string;
  layerId: string;
  x: number;
  y: number;
  orderIndex: number;
}

export interface RoomParticipant {
  participantId: string;
  name: string;
  role: 'gm' | 'player';
}

export interface NoteRecord {
  id: string;
  title: string;
  body: string;
  access: NoteAccess;
  selectedParticipantIds: string[];
  assetIds: string[];
  createdAt: string;
  updatedAt: string;
  images: Array<Pick<BoardAsset, 'id' | 'originalName' | 'width' | 'height'>>;
}

export interface NoteListItem {
  id: string;
  title: string;
  access: NoteAccess;
  updatedAt: string;
  markerId?: string;
}

export interface BoardSnapshot {
  layers: BoardLayer[];
  objects: BoardImage[];
  stickers: BoardSticker[];
  noteMarkers: NoteMarker[];
  allowPlayerStickers: boolean;
  assets?: BoardAsset[];
}

export interface BoardStateMessage extends BoardSnapshot {
  type: 'room:state';
  roomName: string;
  identity: { participantId: string; name: string; role: 'gm' | 'player' };
  participants?: RoomParticipant[];
  maxUploadBytes?: number;
}
