export type LayerAudience = 'gm-only' | 'all-players';
export type BoardBackground = 'black' | 'gray';

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

export type BoardAssetUsageKind = 'board-object' | 'note-attachment' | 'note-marker' | 'sheet-portrait' | 'sheet-ability';

export interface BoardAssetUsage {
  kind: BoardAssetUsageKind;
  count: number;
}

export type NoteAccess = 'gm-only' | 'all-players' | 'selected-players';
export type StickerBackground = 'butter' | 'rose' | 'sky' | 'sage';
export type StickerTextColor = 'black' | 'white';

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
  width: number;
  height: number;
  orderIndex: number;
  type: 'text' | 'image';
  text: string;
  assetId?: string;
  assetWidth?: number;
  assetHeight?: number;
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
  markerType: 'text' | 'image';
  markerText: string;
  markerAssetId?: string;
}

export interface NoteListItem {
  id: string;
  title: string;
  access: NoteAccess;
  updatedAt: string;
  markerId?: string;
}

export type SheetCharacteristicKey = 'might' | 'insight' | 'glory' | 'will';

export interface CharacterSheetCounter {
  id: string;
  name: string;
  value: number;
  orderIndex: number;
}

export interface CharacterSheetAbility {
  id: string;
  name: string;
  description: string;
  assetId: string | null;
  counterEnabled: boolean;
  counterName: string;
  counterValue: number;
  checkboxEnabled: boolean;
  checkboxLabel: string;
  checked: boolean;
  orderIndex: number;
}

export interface CharacterSheet {
  id: string;
  creatorId: string;
  creatorName: string;
  assignedPlayerId: string | null;
  assignedPlayerName: string | null;
  systemId: string;
  systemVersion: string;
  schemaVersion: number;
  characterName: string;
  portraitAssetId: string | null;
  characteristics: Record<SheetCharacteristicKey, number>;
  fate: number;
  counters: CharacterSheetCounter[];
  abilities: CharacterSheetAbility[];
  createdAt: string;
  updatedAt: string;
}

export interface BoardSnapshot {
  background: BoardBackground;
  layers: BoardLayer[];
  objects: BoardImage[];
  stickers: BoardSticker[];
  noteMarkers: NoteMarker[];
  assets?: BoardAsset[];
  availableAssets?: BoardAsset[];
  sheets: CharacterSheet[];
  activeSystem: { id: string; version: string } | null;
  diceRolls: DiceRollEntry[];
}

export type DiceRollEntry = {
  id: string;
  authorId: string;
  authorName: string;
  actorId: string;
  actorName: string;
  createdAt: string;
  kind: 'pbta' | 'free';
  dice: number[];
  keptDice: number[];
  discardedDie: number | null;
  characteristicName: string | null;
  characterId: string | null;
  characterOwnerId: string | null;
  characteristicBonus: number | null;
  situationalModifier: -1 | 0 | 1;
  disadvantage: boolean;
  sides: number | null;
  total: number;
  category: 'failure' | 'success' | 'triumph' | null;
  critical: 'critical-failure' | 'critical-success' | null;
  rerollOf: string | null;
};

export interface BoardStateMessage extends BoardSnapshot {
  type: 'room:state';
  roomName: string;
  identity: { participantId: string; name: string; role: 'gm' | 'player' };
  participants?: RoomParticipant[];
  maxUploadBytes?: number;
  diceRolls: DiceRollEntry[];
  activeSystem: { id: string; version: string } | null;
}
