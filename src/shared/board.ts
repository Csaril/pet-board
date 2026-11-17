export type LayerAudience = 'gm-only' | 'all-players';
export type BoardBackground = 'black' | 'gray';
export type BoardFontFamily = 'default' | 'caveat';
export type BoardScene = 'board' | 'battle';

export interface BoardLayer {
  id: string;
  name: string;
  orderIndex: number;
  visible: boolean;
  locked: boolean;
  audience: LayerAudience;
  scene: BoardScene;
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

export type BoardAssetUsageKind = 'board-object' | 'note-attachment' | 'note-marker' | 'sheet-portrait' | 'sheet-ability' | 'sheet-system' | 'dice-reference';

export interface BoardAssetUsage {
  kind: BoardAssetUsageKind;
  count: number;
}

export type NoteAccess = 'gm-only' | 'all-players' | 'selected-players';
export type NoteType = 'board' | 'personal';
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
  fontFamily: BoardFontFamily;
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
  noteType: NoteType;
  ownerId: string | null;
  ownerName: string | null;
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
  fontFamily: BoardFontFamily;
}

export interface NoteListItem {
  id: string;
  title: string;
  access: NoteAccess;
  updatedAt: string;
  markerId?: string;
}

/** Metadata only: personal note bodies and images are fetched through the owner/GM-protected endpoint. */
export interface PersonalNoteListItem {
  id: string;
  title: string;
  ownerId: string;
  ownerName: string;
  updatedAt: string;
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
  fontFamily: BoardFontFamily;
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
  fontFamily: BoardFontFamily;
  counters: CharacterSheetCounter[];
  abilities: CharacterSheetAbility[];
  /**
   * Opaque, system-owned sheet payload. The core never interprets it; each
   * system validates and normalizes its own shape. PbtA sheets keep it null and
   * continue to use the typed core fields above.
   */
  systemData: unknown | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Fixed system ownership of a room. `fixed = false` means the room has not
 * chosen a system yet and a one-time initialization is still possible.
 * `fixed = true` with `id = null` is the deliberate "no game system" mode.
 */
export interface RoomCapabilities {
  /** True only when the fixed system module declares the battle-map capability. */
  battleMap: boolean;
}

export interface RoomSystemState {
  fixed: boolean;
  id: string | null;
  version: string | null;
  name: string | null;
  config: Record<string, unknown>;
  capabilities: RoomCapabilities;
}

export interface BoardSnapshot {
  activeScene: BoardScene;
  background: BoardBackground;
  layers: BoardLayer[];
  objects: BoardImage[];
  stickers: BoardSticker[];
  noteMarkers: NoteMarker[];
  /** The GM receives the battle scene even while it is not active, for local preview. */
  battle?: BoardSceneSnapshot;
  personalNotes?: PersonalNoteListItem[];
  assets?: BoardAsset[];
  availableAssets?: BoardAsset[];
  sheets: CharacterSheet[];
  system: RoomSystemState;
  diceRolls: DiceRollEntry[];
}

export interface BoardSceneSnapshot {
  background: BoardBackground;
  layers: BoardLayer[];
  objects: BoardImage[];
  stickers: BoardSticker[];
  noteMarkers: NoteMarker[];
}

export type SheetReferenceType = 'ability' | 'body' | 'fetter';

/**
 * Immutable snapshot of a sheet item sent to the shared history. It is stored
 * with the event so later edits to the sheet never rewrite old cards.
 */
export interface SheetReferenceSnapshot {
  type: SheetReferenceType;
  /** Asset frozen into the event snapshot; later sheet edits never rewrite it. */
  imageAssetId: string | null;
  name: string;
  source: string | null;
  timing: string | null;
  cost: string | null;
  range: string | null;
  target: string | null;
  fetter: string | null;
  madness: string | null;
  madnessSpent: number | null;
  description: string;
}

export type DiceRollEntry = {
  id: string;
  authorId: string;
  authorName: string;
  actorId: string;
  actorName: string;
  createdAt: string;
  kind: 'pbta' | 'free' | 'ability-use' | 'sheet-reference' | 'nechronica';
  /** System ownership recorded by the server. Free core rolls keep both values null. */
  systemId: string | null;
  systemVersion: string | null;
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
  /** Snapshot of an ability application; null for dice rolls. */
  abilityId: string | null;
  abilitySheetId: string | null;
  abilityCharacterName: string | null;
  abilityName: string | null;
  abilityAssetId: string | null;
  abilitySummary: string | null;
  abilityDescription: string | null;
  abilityFontFamily: BoardFontFamily | null;
  /** Sheet reference card snapshot; null for dice rolls and PbtA ability applications. */
  reference?: SheetReferenceSnapshot | null;
};

export interface BoardStateMessage extends BoardSnapshot {
  type: 'room:state';
  roomName: string;
  identity: { participantId: string; name: string; role: 'gm' | 'player' };
  participants?: RoomParticipant[];
  maxUploadBytes?: number;
  diceRolls: DiceRollEntry[];
}
