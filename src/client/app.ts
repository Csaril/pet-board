import Konva from 'konva';
import type { BoardAsset, BoardAssetUsage, BoardBackground, BoardImage, BoardLayer, BoardSnapshot, BoardStateMessage, BoardSticker, CharacterSheet, CharacterSheetAbility, CropRect, DiceRollEntry, NoteListItem, NoteRecord, RoomParticipant, SheetCharacteristicKey } from '../shared/board.js';
import { cameraForBounds, isValidCamera, screenToWorld, zoomKeepingScreenPoint } from '../shared/camera.js';
import { clampRect, cropToDisplayRect, displayRectToCrop, lockTransformScales, transformedSize, type Rect } from '../shared/image-geometry.js';
import { buildSheetRollContext, canChangeSheetStructure, clampFloatingPosition, DEFAULT_SHEET_PANEL_MODE, formatSigned, readCollapsedAbilities, readSheetPanelPreference, readSheetRollPanelPreference, setAbilityCollapsed, toggleSheetMode, writeSheetPanelPreference, writeSheetRollPanelPreference, type SheetPanelMode, type SheetPanelPreference } from '../shared/sheet-ui.js';
import { pbtaSheetSchema, pbtaSystemModule } from '../modules/system/pbta-2d6/module.js';
import { shouldHideGmOnlyElement } from '../shared/role-ui.js';

const select = <T extends HTMLElement>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing UI element: ${selector}`);
  return element;
};

const loginShell = select<HTMLElement>('#login-shell');
const workspace = select<HTMLElement>('#workspace');
const form = select<HTMLFormElement>('#join-form');
const roleSelect = select<HTMLSelectElement>('#role');
const gmField = select<HTMLElement>('#gm-field');
const gmPassword = select<HTMLInputElement>('#gmPassword');
const loginMessage = select<HTMLElement>('#login-message');
const connectionStatus = select<HTMLElement>('#connection');
const roomName = select<HTMLElement>('#room-name');
const identityLabel = select<HTMLElement>('#identity');
const canvasContainer = select<HTMLDivElement>('#board-canvas');
const canvasWrap = select<HTMLElement>('.canvas-wrap');
const boardBackgroundSelect = select<HTMLSelectElement>('#board-background');
const canvasMessage = select<HTMLElement>('#canvas-message');
const layersList = select<HTMLUListElement>('#layers-list');
const libraryPanel = select<HTMLElement>('#library-panel');
const assetsList = select<HTMLUListElement>('#assets-list');
const uploadInput = select<HTMLInputElement>('#image-upload');
const uploadDropZone = select<HTMLElement>('#upload-drop-zone');
const uploadMessage = select<HTMLElement>('#upload-message');
const objectTools = select<HTMLElement>('#object-tools');
const stickerTools = select<HTMLElement>('#sticker-tools');
const markerTools = select<HTMLElement>('#marker-tools');
const notesPanel = select<HTMLElement>('#notes-panel');
const notesList = select<HTMLUListElement>('#notes-list');
const noteDialog = select<HTMLDialogElement>('#note-dialog');
const assetPickerDialog = select<HTMLDialogElement>('#asset-picker-dialog');
const assetDeleteDialog = select<HTMLDialogElement>('#asset-delete-dialog');
const stickerCreateDialog = select<HTMLDialogElement>('#sticker-create-dialog');
const noteImageDropZone = select<HTMLElement>('#note-image-drop-zone');
const noteImageUploadStatus = select<HTMLUListElement>('#note-image-upload-status');
const notePlacementHint = select<HTMLElement>('#note-place-hint');
const diceToolsPanel = select<HTMLElement>('#dice-tools-panel');
const diceHistoryPanel = select<HTMLElement>('#dice-history-panel');
const diceHistory = select<HTMLUListElement>('#dice-history');
const diceNewCount = select<HTMLElement>('#dice-new-count');
const layersPanel = select<HTMLElement>('#layers-panel');
const layersExpandButton = select<HTMLButtonElement>('#layers-expand');
const systemSelect = select<HTMLSelectElement>('#room-system');
const systemSave = select<HTMLButtonElement>('#room-system-save');
const pbtaControls = select<HTMLElement>('#pbta-roll-controls');
const pbtaActorRow = select<HTMLElement>('#pbta-actor-row');
const pbtaActor = select<HTMLSelectElement>('#pbta-actor');
const sheetsPanel = select<HTMLElement>('#sheets-panel');
const sheetsList = select<HTMLUListElement>('#sheets-list');
const sheetPanel = select<HTMLElement>('#sheet-panel');
const sheetCollapse = select<HTMLButtonElement>('#sheet-collapse');
const sheetContent = select<HTMLElement>('#sheet-content');
const sheetNameHeading = select<HTMLElement>('#sheet-name-heading');
const sheetOwnerLabel = select<HTMLElement>('#sheet-owner');
const sheetSystemLabel = select<HTMLElement>('#sheet-system');
const sheetPortrait = select<HTMLImageElement>('#sheet-portrait');
const sheetPortraitFallback = select<HTMLElement>('#sheet-portrait-fallback');
const sheetEditToggle = select<HTMLButtonElement>('#sheet-edit-toggle');
const sheetMessage = select<HTMLElement>('#sheet-message');
const sheetRollPanel = select<HTMLElement>('#sheet-roll-panel');
const sheetRollName = select<HTMLElement>('#sheet-roll-name');
const sheetRollControls = select<HTMLElement>('#sheet-roll-controls');
const pbtaControlsHome = select<HTMLElement>('#pbta-controls-home');
const selectedLayer = select<HTMLSelectElement>('#object-layer');
const stretchControl = select<HTMLInputElement>('#free-stretch');
const allowPlayerMoveControl = select<HTMLInputElement>('#allow-player-move');
const MAX_WORLD_COORDINATE = 10_000_000;
const MAX_ZOOM = 4;
const MIN_ZOOM = 0.00001;

type AppIdentity = BoardStateMessage['identity'];
interface RoomMessage extends BoardStateMessage {
  participants: RoomParticipant[];
}
interface PendingCommand {
  resolve: () => void;
  reject: (reason: Error) => void;
  timeout: number;
}
interface RenderedObject {
  group: Konva.Group;
  image: Konva.Image;
  border: Konva.Rect;
  cropShades: Konva.Rect[];
}
interface RenderedSticker { group: Konva.Group; background: Konva.Rect; text: Konva.Text }
interface RenderedMarker { group: Konva.Group }

let identity: AppIdentity | undefined;
let roomState: RoomMessage | undefined;
let socket: WebSocket | undefined;
let reconnectTimer: number | undefined;
let reconnectDelay = 500;
let leaving = false;
let stage: Konva.Stage | undefined;
let boardLayer: Konva.Layer | undefined;
let interactionLayer: Konva.Layer | undefined;
let transformer: Konva.Transformer | undefined;
let cropTransformer: Konva.Transformer | undefined;
let markerTransformer: Konva.Transformer | undefined;
let markerResizeMode = false;
let markerResizeOriginal: { id: string; width: number; height: number } | undefined;
let resizeObserver: ResizeObserver | undefined;
let selectedObjectId: string | undefined;
let selectedStickerId: string | undefined;
let selectedMarkerId: string | undefined;
let activeLayerId: string | undefined;
let notePlacementId: string | undefined;
let openNoteId: string | undefined;
let editingNoteId: string | undefined;
let noteDialogMode: 'view' | 'edit' = 'view';
let noteRequestSequence = 0;
let noteEditorGeneration = 0;
let editingAssetIds: string[] = [];
let selectedMarkerAssetId: string | undefined;
let pendingAssetDeleteId: string | undefined;
type AssetPickerMode = 'attachments' | 'marker' | 'sheet-portrait' | 'ability';
let assetPickerMode: AssetPickerMode = 'attachments';
let selectedSheetPortraitAssetId: string | undefined;
let selectedAbilityAssetId: string | undefined;
let openSheetId: string | undefined;
let sheetDialogMode: SheetPanelMode = DEFAULT_SHEET_PANEL_MODE;
let sheetGeneration = 0;
let editingAbilityId: string | undefined;
let openOwnSheetAfterCreate = false;
let pendingSheetRestoreId: string | undefined;
let pendingRollContext: { characteristicName: string; characteristicBonus: number; characterId: string; characterOwnerId: string } | undefined;
let noteDropDepth = 0;
let knownDiceRollIds: Set<string> | undefined;
let unseenDiceRolls = 0;
let uiPreferencesParticipantId: string | undefined;
let floatingPanelZ = 10;
let pendingNoteUploads = 0;
let cropMode = false;
let camera = { x: 0, y: 0, scale: 1 };
let hasRestoredCamera = false;
let panGesture: { x: number; y: number; cameraX: number; cameraY: number } | undefined;
let messageTimer: number | undefined;
const imageCache = new Map<string, HTMLImageElement>();
const renderedObjects = new Map<string, RenderedObject>();
const renderedStickers = new Map<string, RenderedSticker>();
const renderedMarkers = new Map<string, RenderedMarker>();
const pendingCommands = new Map<string, PendingCommand>();

function showConnection(label: string, state: 'online' | 'reconnecting' | 'offline') {
  connectionStatus.className = `status ${state}`;
  connectionStatus.querySelector('span')!.textContent = label;
}

function showCanvasMessage(message: string, error = false) {
  window.clearTimeout(messageTimer);
  canvasMessage.textContent = message;
  canvasMessage.classList.toggle('error', error);
  canvasMessage.classList.add('visible');
  messageTimer = window.setTimeout(() => canvasMessage.classList.remove('visible'), 3600);
}

function applyGmOnlyVisibility(role: AppIdentity['role']): void {
  for (const element of document.querySelectorAll<HTMLElement>('.gm-only')) {
    element.hidden = shouldHideGmOnlyElement(role, {
      manual: element.dataset.manualVisibility === 'true',
      hidden: element.hidden,
    });
  }
}

function applyBoardBackground(background: BoardBackground | undefined): void {
  const selected: BoardBackground = background === 'black' ? 'black' : 'gray';
  canvasWrap.dataset.boardBackground = selected;
  if (boardBackgroundSelect.value !== selected) boardBackgroundSelect.value = selected;
}

function login(role: AppIdentity['role'], name: string) {
  identity = { participantId: '', role, name };
  loginShell.hidden = true;
  workspace.hidden = false;
  applyGmOnlyVisibility(role);
  if (!stage) setupStage();
  connect();
}

function connect() {
  window.clearTimeout(reconnectTimer);
  showConnection('Подключение…', 'reconnecting');
  const connection = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
  socket = connection;
  connection.addEventListener('open', () => {
    reconnectDelay = 500;
    showConnection('В сети', 'online');
  });
  connection.addEventListener('message', (event) => {
    let message: { type?: string; requestId?: string; ok?: boolean; error?: string; identity?: AppIdentity } & Record<string, unknown>;
    try { message = JSON.parse(event.data) as typeof message; }
    catch { showCanvasMessage('Сервер прислал некорректное сообщение.', true); return; }
    if (message.type === 'command:result') {
      const pending = message.requestId ? pendingCommands.get(message.requestId) : undefined;
      if (pending && message.requestId) {
        window.clearTimeout(pending.timeout);
        pendingCommands.delete(message.requestId);
        if (message.ok) pending.resolve();
        else {
          pending.reject(new Error(message.error || 'Не удалось применить изменение.'));
          void refreshBoard();
        }
      }
      if (!message.ok && !pending) showCanvasMessage(message.error || 'Не удалось применить изменение.', true);
      return;
    }
    if (message.type === 'session:ended') {
      leaving = true;
      window.clearTimeout(reconnectTimer);
      closeWorkspace('Сессия завершена. Подключитесь снова.');
      return;
    }
    if (message.type !== 'room:state' || !message.identity) return;
    roomState = message as unknown as RoomMessage;
    identity = message.identity;
    roomName.textContent = typeof message.roomName === 'string' ? message.roomName : 'Игровая комната';
    identityLabel.textContent = `${identity.name} · ${identity.role === 'gm' ? 'Ведущий' : 'Игрок'}`;
    applyGmOnlyVisibility(identity.role);
    updateBoard(message as unknown as RoomMessage);
  });
  connection.addEventListener('close', (event) => {
    if (leaving) return;
    if (event.code === 1008) {
      showConnection('Сессия недействительна', 'offline');
      return;
    }
    showConnection('Переподключение…', 'reconnecting');
    reconnectTimer = window.setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 8000);
  });
  connection.addEventListener('error', () => connection.close());
}

function sendCommand(type: string, data: Record<string, unknown> = {}): Promise<void> {
  if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Нет соединения с сервером.'));
  const requestId = crypto.randomUUID();
  return new Promise<void>((resolve, reject) => {
  const timeout = window.setTimeout(() => {
      pendingCommands.delete(requestId);
      reject(new Error('Сервер не ответил на команду.'));
    }, 8000);
    pendingCommands.set(requestId, { resolve, reject, timeout });
    socket!.send(JSON.stringify({ type, requestId, ...data }));
  });
}

async function runCommand(type: string, data: Record<string, unknown> = {}) {
  try { await sendCommand(type, data); }
  catch (error) { showCanvasMessage(error instanceof Error ? error.message : 'Ошибка сервера.', true); }
}

async function refreshBoard() {
  try {
    const response = await fetch('/api/board', { cache: 'no-store' });
    if (!response.ok) return;
    const snapshot = await response.json() as BoardSnapshot;
    if (!roomState || !identity) return;
    updateBoard({ ...roomState, ...snapshot });
  } catch { /* Reconnect status covers temporary network failure. */ }
}

function cameraStorageKey() { return `tabletop-camera:${location.host}`; }
function saveCamera() {
  if (!stage) return;
  camera = { x: stage.x(), y: stage.y(), scale: stage.scaleX() };
  try { localStorage.setItem(cameraStorageKey(), JSON.stringify({ version: 2, camera })); } catch { /* Storage can be disabled or full. */ }
}
function restoreCamera() {
  camera = { x: 0, y: 0, scale: 1 };
  hasRestoredCamera = false;
  try {
    const stored = JSON.parse(localStorage.getItem(cameraStorageKey()) || 'null') as { version?: number; camera?: unknown } | null;
    if (stored?.version === 2 && isValidCamera(stored.camera, MAX_WORLD_COORDINATE * MAX_ZOOM, MIN_ZOOM, MAX_ZOOM)) {
      camera = stored.camera;
      hasRestoredCamera = true;
    }
  } catch { /* Use a centered initial camera when storage is invalid or unavailable. */ }
}

function setupStage() {
  restoreCamera();
  const width = Math.max(1, canvasWrap.clientWidth);
  const height = Math.max(1, canvasWrap.clientHeight);
  if (!hasRestoredCamera) camera = { x: width / 2, y: height / 2, scale: 1 };
  stage = new Konva.Stage({ container: canvasContainer, width, height, x: camera.x, y: camera.y, scaleX: camera.scale, scaleY: camera.scale });
  boardLayer = new Konva.Layer({ listening: true });
  interactionLayer = new Konva.Layer({ listening: true });
  transformer = new Konva.Transformer({
    rotateEnabled: false,
    flipEnabled: false,
    keepRatio: true,
    ignoreStroke: true,
    borderStroke: '#426c59',
    anchorStroke: '#426c59',
    anchorFill: '#fff',
    anchorSize: 8,
    padding: 1,
    enabledAnchors: ['top-left', 'top-right', 'bottom-left', 'bottom-right'],
  });
  cropTransformer = new Konva.Transformer({
    rotateEnabled: false, flipEnabled: false, keepRatio: false, enabledAnchors: ['top-left', 'top-center', 'top-right', 'middle-left', 'middle-right', 'bottom-left', 'bottom-center', 'bottom-right'],
    ignoreStroke: true, borderStroke: '#426c59', anchorStroke: '#426c59', anchorFill: '#fff', anchorSize: 8, padding: 1,
    boundBoxFunc: (_oldBox, newBox) => {
      const item = roomState?.objects.find((object) => object.id === selectedObjectId);
      const rendered = selectedObjectId ? renderedObjects.get(selectedObjectId) : undefined;
      if (!cropMode || !item || !rendered) return newBox;
      const inverse = rendered.group.getAbsoluteTransform().copy().invert();
      const first = inverse.point({ x: newBox.x, y: newBox.y });
      const second = inverse.point({ x: newBox.x + newBox.width, y: newBox.y + newBox.height });
      const minSize = Math.min(8, item.width, item.height);
      const bounded = clampRect({ x: Math.min(first.x, second.x), y: Math.min(first.y, second.y), width: Math.abs(second.x - first.x), height: Math.abs(second.y - first.y) }, item.width, item.height, minSize);
      const topLeft = rendered.group.getAbsoluteTransform().point({ x: bounded.x, y: bounded.y });
      const bottomRight = rendered.group.getAbsoluteTransform().point({ x: bounded.x + bounded.width, y: bounded.y + bounded.height });
      return { ...newBox, x: topLeft.x, y: topLeft.y, width: bottomRight.x - topLeft.x, height: bottomRight.y - topLeft.y };
    },
  });
  markerTransformer = new Konva.Transformer({
    rotateEnabled: false,
    flipEnabled: false,
    keepRatio: false,
    ignoreStroke: true,
    borderStroke: '#426c59',
    anchorStroke: '#426c59',
    anchorFill: '#fff',
    anchorSize: 8,
    padding: 2,
    enabledAnchors: ['top-left', 'top-center', 'top-right', 'middle-left', 'middle-right', 'bottom-left', 'bottom-center', 'bottom-right'],
    boundBoxFunc: (oldBox, newBox) => {
      const marker = roomState?.noteMarkers.find((entry) => entry.id === selectedMarkerId);
      if (!markerResizeMode || !marker) return oldBox;
      const scale = stage?.scaleX() || 1;
      const minimumWidth = (marker.type === 'image' ? 24 : 64) * scale;
      const minimumHeight = (marker.type === 'image' ? 24 : 34) * scale;
      const maximum = 4000 * scale;
      if (newBox.width < minimumWidth || newBox.height < minimumHeight || newBox.width > maximum || newBox.height > maximum) return oldBox;
      return newBox;
    },
  });
  interactionLayer.add(transformer);
  interactionLayer.add(cropTransformer);
  interactionLayer.add(markerTransformer);
  stage.add(boardLayer, interactionLayer);
  stage.on('mousedown touchstart', (event) => {
    if (event.target !== stage || cropMode) return;
    const pointer = stage!.getPointerPosition();
    if (!pointer) return;
    panGesture = { x: pointer.x, y: pointer.y, cameraX: stage!.x(), cameraY: stage!.y() };
  });
  stage.on('mousemove touchmove', () => {
    if (!panGesture) return;
    const pointer = stage!.getPointerPosition();
    if (!pointer) return;
    stage!.position({ x: panGesture.cameraX + pointer.x - panGesture.x, y: panGesture.cameraY + pointer.y - panGesture.y });
    boardLayer!.batchDraw();
  });
  stage.on('mouseup touchend', () => {
    panGesture = undefined;
    saveCamera();
  });
  stage.on('click tap', (event) => {
    if (event.target !== stage) return;
    if (notePlacementId) {
      const pointer = stage!.getPointerPosition();
      const layer = activeLayerId && roomState?.layers.find((entry) => entry.id === activeLayerId);
      if (!pointer || !layer || layer.locked || identity?.role !== 'gm') { showCanvasMessage('Выберите открытый слой для метки.', true); return; }
      const world = screenToWorld(pointer, { x: stage!.x(), y: stage!.y(), scale: stage!.scaleX() });
      const noteId = notePlacementId;
      notePlacementId = undefined;
      notePlacementHint.hidden = true;
      const existingMarker = roomState?.noteMarkers.find((marker) => marker.noteId === noteId);
      if (existingMarker) void runCommand('note-marker:update', { id: existingMarker.id, changes: { layerId: layer.id, x: Math.round(world.x), y: Math.round(world.y) } }).then(refreshNotesListIfVisible);
      else void runCommand('note-marker:create', { noteId, layerId: layer.id, x: Math.round(world.x), y: Math.round(world.y) }).then(refreshNotesListIfVisible);
      canvasContainer.style.cursor = '';
      return;
    }
    if (selectedObjectId || selectedStickerId || selectedMarkerId) setSelectedObject(undefined);
  });
  stage.on('wheel', (event) => {
    event.evt.preventDefault();
    const oldScale = stage!.scaleX();
    const pointer = stage!.getPointerPosition();
    if (!pointer) return;
    const factor = 1.06;
    const nextScale = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, oldScale * (event.evt.deltaY > 0 ? 1 / factor : factor)));
    const next = zoomKeepingScreenPoint({ x: stage!.x(), y: stage!.y(), scale: oldScale }, pointer, nextScale);
    stage!.scale({ x: next.scale, y: next.scale });
    stage!.position({ x: next.x, y: next.y });
    saveCamera();
    boardLayer!.batchDraw();
    interactionLayer!.batchDraw();
  });
  resizeObserver = new ResizeObserver(() => {
    if (!stage) return;
    const oldWidth = stage.width(); const oldHeight = stage.height();
    stage.size({ width: Math.max(1, canvasWrap.clientWidth), height: Math.max(1, canvasWrap.clientHeight) });
    stage.position({ x: stage.x() + (stage.width() - oldWidth) / 2, y: stage.y() + (stage.height() - oldHeight) / 2 });
    saveCamera();
    interactionLayer?.batchDraw();
  });
  resizeObserver.observe(canvasWrap);
  select<HTMLButtonElement>('#zoom-reset').addEventListener('click', () => {
    const center = { x: stage!.width() / 2, y: stage!.height() / 2 };
    const next = zoomKeepingScreenPoint({ x: stage!.x(), y: stage!.y(), scale: stage!.scaleX() }, center, 1);
    stage!.scale({ x: next.scale, y: next.scale });
    stage!.position({ x: next.x, y: next.y });
    saveCamera();
    boardLayer!.batchDraw();
    interactionLayer!.batchDraw();
  });
  select<HTMLButtonElement>('#fit-board').addEventListener('click', fitAllObjects);
}

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && notePlacementId) {
    notePlacementId = undefined; notePlacementHint.hidden = true; canvasContainer.style.cursor = '';
  }
  if (event.key === 'Escape' && markerResizeMode) cancelMarkerResize();
});

function fitAllObjects() {
  if (!stage || !roomState) return;
  const visibleIds = new Set(roomState.layers.filter((layer) => layer.visible).map((layer) => layer.id));
  const objects = roomState.objects.filter((item) => visibleIds.has(item.layerId));
  const boundsRects: Rect[] = objects.map((item) => {
    const rect = cropToDisplayRect(item.crop, item.width, item.height, item.flipX, item.flipY);
    return { x: item.x + rect.x, y: item.y + rect.y, width: rect.width, height: rect.height };
  });
  for (const sticker of roomState.stickers.filter((item) => visibleIds.has(item.layerId))) boundsRects.push({ x: sticker.x, y: sticker.y, width: sticker.width, height: sticker.height });
  for (const marker of roomState.noteMarkers.filter((item) => visibleIds.has(item.layerId))) boundsRects.push({ x: marker.x, y: marker.y, width: marker.width, height: marker.height });
  const bounds = boundsRects.length ? {
    minX: Math.min(...boundsRects.map((rect) => rect.x)), minY: Math.min(...boundsRects.map((rect) => rect.y)),
    maxX: Math.max(...boundsRects.map((rect) => rect.x + rect.width)), maxY: Math.max(...boundsRects.map((rect) => rect.y + rect.height)),
  } : undefined;
  const next = cameraForBounds(bounds, stage.width(), stage.height(), 64, MAX_ZOOM);
  stage.position({ x: next.x, y: next.y });
  stage.scale({ x: next.scale, y: next.scale });
  saveCamera();
  boardLayer!.batchDraw();
  interactionLayer!.batchDraw();
}

function cachedImage(assetId: string): HTMLImageElement {
  const cached = imageCache.get(assetId);
  if (cached) return cached;
  const image = new Image();
  image.crossOrigin = 'use-credentials';
  image.src = `/api/assets/${encodeURIComponent(assetId)}`;
  image.onload = () => { if (roomState) drawObjects(); };
  image.onerror = () => showCanvasMessage('Не удалось загрузить изображение. Проверьте доступ к ресурсу.', true);
  imageCache.set(assetId, image);
  return image;
}

function canMove(item: BoardImage, layer: BoardLayer): boolean {
  if (layer.locked) return false;
  return identity?.role === 'gm' || (identity?.role === 'player' && item.allowPlayerMove && layer.audience === 'all-players' && layer.visible);
}

function updateImageNode(node: Konva.Image, item: BoardImage, image: HTMLImageElement) {
  node.setAttrs({
    x: item.flipX ? item.width : 0,
    y: item.flipY ? item.height : 0,
    width: item.width,
    height: item.height,
    scaleX: item.flipX ? -1 : 1,
    scaleY: item.flipY ? -1 : 1,
    image,
  });
}

function cropBox(node: Konva.Rect, width: number, height: number): Rect {
  return clampRect({ x: node.x(), y: node.y(), width: node.width() * Math.abs(node.scaleX()), height: node.height() * Math.abs(node.scaleY()) }, width, height);
}

function updateCropShades(rendered: RenderedObject, width: number, height: number) {
  const box = cropBox(rendered.border, width, height);
  const [top, bottom, left, right] = rendered.cropShades;
  top!.setAttrs({ x: 0, y: 0, width, height: box.y });
  bottom!.setAttrs({ x: 0, y: box.y + box.height, width, height: Math.max(0, height - box.y - box.height) });
  left!.setAttrs({ x: 0, y: box.y, width: box.x, height: box.height });
  right!.setAttrs({ x: box.x + box.width, y: box.y, width: Math.max(0, width - box.x - box.width), height: box.height });
}

function drawObjects() {
  if (!boardLayer || !roomState) return;
  boardLayer.destroyChildren();
  transformer?.nodes([]);
  cropTransformer?.nodes([]);
  markerTransformer?.nodes([]);
  renderedObjects.clear();
  renderedStickers.clear(); renderedMarkers.clear();
  const visibleLayers = roomState.layers.filter((layer) => layer.visible).sort((a, b) => a.orderIndex - b.orderIndex);
  for (const layer of visibleLayers) {
    const objects = roomState.objects.filter((object) => object.layerId === layer.id).sort((a, b) => a.orderIndex - b.orderIndex);
    for (const item of objects) {
      const editingCrop = cropMode && selectedObjectId === item.id;
      const htmlImage = cachedImage(item.assetId);
      const group = new Konva.Group({
        x: item.x, y: item.y, width: item.width, height: item.height,
        draggable: canMove(item, layer) && !(cropMode && selectedObjectId === item.id),
        name: `board-object ${item.id}`,
        ...(!editingCrop ? { clipFunc: (context: Konva.Context) => {
          const rect = cropToDisplayRect(item.crop, item.width, item.height, item.flipX, item.flipY);
          context.rect(rect.x, rect.y, rect.width, rect.height);
        } } : {}),
      });
      const imageNode = new Konva.Image({ image: htmlImage, listening: true });
      updateImageNode(imageNode, item, htmlImage);
      const cropRect = cropToDisplayRect(item.crop, item.width, item.height, item.flipX, item.flipY);
      const cropShades = [0, 1, 2, 3].map(() => new Konva.Rect({ fill: '#1119', listening: false, perfectDrawEnabled: false }));
      const border = new Konva.Rect({ ...cropRect, stroke: editingCrop ? '#426c59' : layer.locked ? '#bd7b20' : '#1684d4', strokeWidth: 2, dash: [5, 3], listening: editingCrop, strokeEnabled: false, fill: editingCrop ? '#ffffff01' : undefined, draggable: editingCrop && identity?.role === 'gm' && !layer.locked });
      group.add(imageNode, ...cropShades, border);
      const rendered: RenderedObject = { group, image: imageNode, border, cropShades };
      if (editingCrop) {
        border.on('click tap', (event) => { event.cancelBubble = true; });
        updateCropShades(rendered, item.width, item.height);
        border.dragBoundFunc((position) => {
          const transform = group.getAbsoluteTransform().copy().invert();
          const local = transform.point(position);
          const bounded = clampRect({ x: local.x, y: local.y, width: border.width(), height: border.height() }, item.width, item.height);
          return group.getAbsoluteTransform().point({ x: bounded.x, y: bounded.y });
        });
        border.on('dragmove transform', () => { updateCropShades(rendered, item.width, item.height); boardLayer?.batchDraw(); });
        border.on('dragend', () => { updateCropShades(rendered, item.width, item.height); });
        border.on('transformend', () => {
          const bounded = cropBox(border, item.width, item.height);
          border.setAttrs({ ...bounded, scaleX: 1, scaleY: 1 });
          updateCropShades(rendered, item.width, item.height);
          cropTransformer?.forceUpdate();
          boardLayer?.batchDraw();
        });
      }
      group.on('click tap', (event) => { event.cancelBubble = true; setSelectedObject(item.id); });
      group.on('dragend', () => { void runCommand('object:update', { id: item.id, changes: { x: clampWorld(group.x()), y: clampWorld(group.y()) } }); });
      group.on('transform', () => {
        if (identity?.role !== 'gm' || layer.locked || item.freeStretch) return;
        const asset = roomState?.assets?.find((entry) => entry.id === item.assetId);
        const aspect = asset ? asset.width / asset.height : item.width / item.height;
        const scales = lockTransformScales(item.width, item.height, group.scaleX(), group.scaleY(), aspect);
        group.scale({ x: scales.scaleX, y: scales.scaleY });
      });
      group.on('transformend', () => {
        if (identity?.role !== 'gm' || layer.locked) return;
        const asset = roomState?.assets?.find((entry) => entry.id === item.assetId);
        const aspect = asset ? asset.width / asset.height : item.width / item.height;
        const size = transformedSize(group.width(), group.height(), group.scaleX(), group.scaleY(), item.freeStretch, aspect);
        const width = Math.max(1, Math.round(size.width));
        const height = Math.max(1, Math.round(size.height));
        const x = clampWorld(group.x()); const y = clampWorld(group.y());
        group.scale({ x: 1, y: 1 });
        item.width = width; item.height = height; item.x = x; item.y = y;
        drawObjects();
        void runCommand('object:update', { id: item.id, changes: { x, y, width, height } });
      });
      boardLayer.add(group);
      renderedObjects.set(item.id, rendered);
    }
    for (const sticker of (roomState.stickers || []).filter((entry) => entry.layerId === layer.id).sort((a, b) => a.orderIndex - b.orderIndex)) {
      const colors: Record<BoardSticker['bgColor'], string> = { butter: '#fff1b8', rose: '#ffd6df', sky: '#d7efff', sage: '#d9efdc' };
      const textColors: Record<BoardSticker['textColor'], string> = { black: '#000000', white: '#FFFFFF' };
      const group = new Konva.Group({ x: sticker.x, y: sticker.y, width: sticker.width, height: sticker.height, draggable: !layer.locked && (identity?.role === 'gm' || sticker.creatorId === identity?.participantId), name: `board-sticker ${sticker.id}` });
      const background = new Konva.Rect({ width: sticker.width, height: sticker.height, fill: colors[sticker.bgColor], cornerRadius: 8, stroke: '#0002', strokeWidth: 1 });
      const text = new Konva.Text({ x: 10, y: 8, width: sticker.width - 20, height: sticker.height - 16, text: sticker.text, fontFamily: 'system-ui, sans-serif', fontSize: sticker.fontSize, fill: textColors[sticker.textColor], wrap: 'word', ellipsis: true, verticalAlign: 'middle', align: 'center', listening: false });
      group.add(background, text);
      group.on('click tap', (event) => { event.cancelBubble = true; setSelectedSticker(sticker.id); });
      group.on('dragend', () => void runCommand('sticker:update', { id: sticker.id, changes: { x: clampWorld(group.x()), y: clampWorld(group.y()) } }));
      group.on('transformend', () => { const changes = { x: clampWorld(group.x()), y: clampWorld(group.y()), width: Math.max(100, Math.round(group.width() * group.scaleX())), height: Math.max(64, Math.round(group.height() * group.scaleY())) }; group.scale({ x: 1, y: 1 }); void runCommand('sticker:update', { id: sticker.id, changes }); });
      boardLayer.add(group); renderedStickers.set(sticker.id, { group, background, text });
    }
    for (const marker of (roomState.noteMarkers || []).filter((entry) => entry.layerId === layer.id).sort((a, b) => a.orderIndex - b.orderIndex)) {
      const markerWidth = marker.width;
      const markerHeight = marker.height;
      const group = new Konva.Group({ x: marker.x, y: marker.y, width: markerWidth, height: markerHeight, draggable: identity?.role === 'gm' && !layer.locked && !markerResizeMode, name: `note-marker ${marker.id}` });
      if (marker.type === 'image' && marker.assetId) {
        const image = cachedImage(marker.assetId);
        group.add(new Konva.Rect({ width: markerWidth, height: markerHeight, fill: '#fff', cornerRadius: 5, stroke: '#426c59', strokeWidth: 2 }));
        group.add(new Konva.Image({ x: 2, y: 2, width: Math.max(1, markerWidth - 4), height: Math.max(1, markerHeight - 4), image, listening: false }));
      } else {
        group.add(new Konva.Rect({ width: markerWidth, height: markerHeight, fill: '#fffdf4', stroke: '#52645a', strokeWidth: 1.5, cornerRadius: 5, shadowColor: '#17231a', shadowBlur: 4, shadowOpacity: .15, shadowOffsetY: 2 }));
        group.add(new Konva.Text({ x: 8, y: 0, width: Math.max(1, markerWidth - 16), height: markerHeight, text: marker.text.slice(0, 60), fontSize: 13, fontFamily: 'system-ui, sans-serif', fill: '#202722', wrap: 'word', ellipsis: true, verticalAlign: 'middle', align: 'center', listening: false }));
      }
      group.on('click tap', (event) => {
        event.cancelBubble = true;
        setSelectedMarker(marker.id);
        if (!markerResizeMode) void openNote(marker.noteId);
      });
      group.on('dragend', () => void runCommand('note-marker:update', { id: marker.id, changes: { x: clampWorld(group.x()), y: clampWorld(group.y()) } }));
      group.on('transform', () => {
        if (!markerResizeMode || marker.type !== 'image') return;
        const ratio = (marker.assetWidth || markerWidth) / (marker.assetHeight || markerHeight);
        const scales = lockTransformScales(group.width(), group.height(), group.scaleX(), group.scaleY(), ratio);
        group.scale({ x: scales.scaleX, y: scales.scaleY });
      });
      group.on('transformend', () => {
        if (!markerResizeMode || identity?.role !== 'gm' || layer.locked) { drawObjects(); return; }
        let width = Math.round(group.width() * Math.abs(group.scaleX()));
        let height = Math.round(group.height() * Math.abs(group.scaleY()));
        if (marker.type === 'image') {
          const ratio = (marker.assetWidth || width) / (marker.assetHeight || height);
          width = Math.max(24, width);
          height = Math.max(24, Math.round(width / ratio));
        } else {
          width = Math.max(64, width);
          height = Math.max(34, height);
        }
        group.scale({ x: 1, y: 1 });
        marker.width = width; marker.height = height;
        markerResizeOriginal = undefined;
        drawObjects();
        void runCommand('note-marker:update', { id: marker.id, changes: { width, height } });
      });
      boardLayer.add(group); renderedMarkers.set(marker.id, { group });
    }
  }
  updateSelectionControls();
  boardLayer.batchDraw();
}

function clampWorld(value: number) { return Math.max(-MAX_WORLD_COORDINATE, Math.min(MAX_WORLD_COORDINATE, value)); }

function setSelectedObject(id: string | undefined) {
  const changed = id !== selectedObjectId;
  selectedObjectId = id; selectedStickerId = undefined; selectedMarkerId = undefined;
  markerResizeMode = false; markerResizeOriginal = undefined;
  updateSelectionControls();
  if (cropMode && changed) cropMode = false;
  drawObjects();
}

function setSelectedSticker(id: string | undefined) { selectedObjectId = undefined; selectedMarkerId = undefined; selectedStickerId = id; cropMode = false; markerResizeMode = false; markerResizeOriginal = undefined; updateSelectionControls(); drawObjects(); }
function setSelectedMarker(id: string | undefined) {
  const changed = id !== selectedMarkerId;
  selectedObjectId = undefined; selectedStickerId = undefined; selectedMarkerId = id; cropMode = false;
  if (changed) { markerResizeMode = false; markerResizeOriginal = undefined; }
  updateSelectionControls(); drawObjects();
}

function setMarkerResizeMode(active: boolean): void {
  const marker = roomState?.noteMarkers.find((entry) => entry.id === selectedMarkerId);
  const layer = marker && roomState?.layers.find((entry) => entry.id === marker.layerId);
  if (active && (!marker || !layer || layer.locked || identity?.role !== 'gm')) return;
  markerResizeMode = active;
  markerResizeOriginal = active && marker ? { id: marker.id, width: marker.width, height: marker.height } : undefined;
  updateSelectionControls();
  boardLayer?.batchDraw();
}

function cancelMarkerResize(): void {
  const marker = roomState?.noteMarkers.find((entry) => entry.id === selectedMarkerId);
  if (marker && markerResizeOriginal?.id === marker.id) {
    marker.width = markerResizeOriginal.width;
    marker.height = markerResizeOriginal.height;
  }
  markerResizeMode = false;
  markerResizeOriginal = undefined;
  drawObjects();
}

function updateSelectionControls() {
  const sticker = roomState?.stickers?.find((entry) => entry.id === selectedStickerId);
  const stickerLayer = sticker && roomState?.layers.find((entry) => entry.id === sticker.layerId);
  const stickerRendered = sticker && renderedStickers.get(sticker.id);
  const marker = roomState?.noteMarkers?.find((entry) => entry.id === selectedMarkerId);
  const markerLayer = marker && roomState?.layers.find((entry) => entry.id === marker.layerId);
  const markerRendered = marker && renderedMarkers.get(marker.id);
  const canEditSticker = !!sticker && !!stickerLayer && !stickerLayer.locked && (identity?.role === 'gm' || sticker.creatorId === identity?.participantId);
  objectTools.hidden = true;
  stickerTools.hidden = !sticker || !stickerRendered || !canEditSticker;
  const canResizeMarker = !!marker && !!markerRendered && !!markerLayer && !markerLayer.locked && identity?.role === 'gm';
  markerTools.hidden = !canResizeMarker;
  if (markerResizeMode && !canResizeMarker) { markerResizeMode = false; markerResizeOriginal = undefined; }
  select<HTMLElement>('#lock-indicator').hidden = !(sticker && stickerLayer?.locked || marker && markerLayer?.locked);
  const markerResizeButton = select<HTMLButtonElement>('#marker-resize');
  markerResizeButton.disabled = !canResizeMarker;
  markerResizeButton.classList.toggle('active', markerResizeMode);
  markerResizeButton.setAttribute('aria-pressed', String(markerResizeMode));
  if (sticker && stickerRendered) {
    markerTransformer?.nodes([]);
    transformer?.nodes(canEditSticker ? [stickerRendered.group] : []); cropTransformer?.nodes([]);
    select<HTMLSelectElement>('#sticker-bg').value = sticker.bgColor; select<HTMLSelectElement>('#sticker-text-color').value = sticker.textColor; select<HTMLSelectElement>('#sticker-font-size').value = String(sticker.fontSize);
    return;
  }
  if (marker && markerRendered) {
    transformer?.nodes([]); cropTransformer?.nodes([]);
    if (markerTransformer) {
      markerTransformer.keepRatio(marker.type === 'image');
      markerTransformer.enabledAnchors(marker.type === 'image'
        ? ['top-left', 'top-right', 'bottom-left', 'bottom-right']
        : ['top-left', 'top-center', 'top-right', 'middle-left', 'middle-right', 'bottom-left', 'bottom-center', 'bottom-right']);
      markerTransformer.nodes(markerResizeMode && canResizeMarker ? [markerRendered.group] : []);
    }
    return;
  }
  markerTransformer?.nodes([]);
  const item = roomState?.objects.find((object) => object.id === selectedObjectId);
  const layer = item && roomState?.layers.find((entry) => entry.id === item.layerId);
  const rendered = item && renderedObjects.get(item.id);
  objectTools.hidden = !item || !layer || !rendered || identity?.role !== 'gm';
  if (!item || !layer || !rendered) {
    select<HTMLElement>('#lock-indicator').hidden = true;
    transformer?.nodes([]);
    cropTransformer?.nodes([]);
    return;
  }
  select<HTMLElement>('#selection-name').textContent = roomState?.assets?.find((asset) => asset.id === item.assetId)?.originalName || 'Изображение';
  rendered.border.strokeEnabled(true);
  select<HTMLElement>('#lock-indicator').hidden = !layer.locked;
  if (identity?.role === 'gm' && !layer.locked && !item.freeStretch && !cropMode) {
    const asset = roomState?.assets?.find((entry) => entry.id === item.assetId);
    if (asset) {
      const naturalHeight = Math.max(1, Math.round(item.width / (asset.width / asset.height)));
      if (Math.abs(naturalHeight - item.height) > 1) {
        item.height = naturalHeight;
        drawObjects();
        void runCommand('object:update', { id: item.id, changes: { height: naturalHeight } });
        return;
      }
    }
  }
  selectedLayer.replaceChildren(...(roomState?.layers || []).map((entry) => {
    const option = document.createElement('option'); option.value = entry.id; option.textContent = entry.name; option.disabled = entry.locked && entry.id !== item.layerId; return option;
  }));
  selectedLayer.value = item.layerId;
  allowPlayerMoveControl.checked = item.allowPlayerMove;
  stretchControl.checked = item.freeStretch;
  const isGm = identity?.role === 'gm';
  const editable = isGm && !layer.locked;
  transformer?.nodes(editable && !cropMode ? [rendered.group] : []);
  cropTransformer?.nodes(editable && cropMode ? [rendered.border] : []);
  if (transformer) {
    transformer.keepRatio(!item.freeStretch);
    transformer.enabledAnchors(item.freeStretch
      ? ['top-left', 'top-center', 'top-right', 'middle-left', 'middle-right', 'bottom-left', 'bottom-center', 'bottom-right']
      : ['top-left', 'top-right', 'bottom-left', 'bottom-right']);
  }
  select<HTMLButtonElement>('#crop-toggle').classList.toggle('active', cropMode);
  select<HTMLButtonElement>('#crop-toggle').textContent = cropMode ? 'Редактирование обрезки' : 'Обрезать';
  select<HTMLButtonElement>('#crop-reset').hidden = !item.crop || cropMode;
  select<HTMLButtonElement>('#crop-cancel').hidden = !cropMode;
  select<HTMLButtonElement>('#crop-confirm').hidden = !cropMode;
  for (const element of objectTools.querySelectorAll<HTMLElement>('.gm-only')) element.hidden = !isGm;
  for (const button of objectTools.querySelectorAll<HTMLButtonElement>('button')) {
    if (cropMode) { button.disabled = button.id !== 'crop-confirm' && button.id !== 'crop-cancel'; continue; }
    if (button.id === 'crop-toggle') { button.disabled = !editable; continue; }
    if (button.id === 'crop-cancel') continue;
    if (button.id === 'crop-reset') button.disabled = !editable || !item.crop;
    else button.disabled = identity?.role === 'gm' ? !editable : button.id !== 'crop-toggle';
  }
  allowPlayerMoveControl.disabled = !editable || cropMode;
  stretchControl.disabled = !editable || cropMode;
  selectedLayer.disabled = !editable || cropMode;
}

function confirmCrop() {
  if (!roomState || !selectedObjectId || identity?.role !== 'gm') return;
  const item = roomState.objects.find((object) => object.id === selectedObjectId);
  const layer = item && roomState.layers.find((entry) => entry.id === item.layerId);
  const rendered = renderedObjects.get(selectedObjectId);
  if (!item || !layer || layer.locked || !rendered) return;
  const box = cropBox(rendered.border, item.width, item.height);
  if (box.width < 8 || box.height < 8) { showCanvasMessage('Область обрезки слишком мала.', true); return; }
  const next: CropRect = displayRectToCrop(box, item.width, item.height, item.flipX, item.flipY);
  cropMode = false;
  item.crop = next;
  cropTransformer?.nodes([]);
  drawObjects();
  void runCommand('object:update', { id: item.id, changes: { crop: next } });
}

interface PanelPreference { version: 1; open: boolean; x: number | null; y: number | null }

function uiStorageKey(participantId: string, panel: 'dice-tools' | 'dice-history' | 'layers'): string {
  return `tabletop:ui:v1:${participantId}:${panel}`;
}

function readPanelPreference(participantId: string, panel: 'dice-tools' | 'dice-history'): PanelPreference | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(uiStorageKey(participantId, panel)) || 'null') as Partial<PanelPreference> | null;
    if (!value || value.version !== 1 || typeof value.open !== 'boolean') return undefined;
    if ((value.x !== null && (typeof value.x !== 'number' || !Number.isFinite(value.x))) ||
        (value.y !== null && (typeof value.y !== 'number' || !Number.isFinite(value.y)))) return undefined;
    return { version: 1, open: value.open, x: value.x ?? null, y: value.y ?? null };
  } catch { return undefined; }
}

function measureFloatingPanel(panel: HTMLElement): DOMRect {
  const wasHidden = panel.hidden;
  const oldVisibility = panel.style.visibility;
  panel.hidden = false;
  panel.style.visibility = 'hidden';
  const rect = panel.getBoundingClientRect();
  panel.hidden = wasHidden;
  panel.style.visibility = oldVisibility;
  return rect;
}

function clampFloatingPanel(panel: HTMLElement): void {
  const rect = measureFloatingPanel(panel);
  const width = rect.width || Math.min(350, Math.max(0, window.innerWidth - 24));
  const height = rect.height || Math.min(420, Math.max(0, window.innerHeight - 24));
  const currentX = Number.parseFloat(panel.style.left);
  const currentY = Number.parseFloat(panel.style.top);
  const x = Number.isFinite(currentX) ? currentX : 16;
  const y = Number.isFinite(currentY) ? currentY : Math.max(16, window.innerHeight - height - 16);
  const position = clampFloatingPosition(x, y, width, height, window.innerWidth, window.innerHeight);
  panel.style.left = `${position.x}px`;
  panel.style.top = `${position.y}px`;
  panel.style.right = 'auto';
  panel.style.bottom = 'auto';
}

function saveFloatingPanel(panel: HTMLElement, participantId: string, key: 'dice-tools' | 'dice-history'): void {
  const rect = panel.getBoundingClientRect();
  const storedX = Number.parseFloat(panel.style.left);
  const storedY = Number.parseFloat(panel.style.top);
  const preference: PanelPreference = {
    version: 1, open: !panel.hidden,
    x: panel.hidden && Number.isFinite(storedX) ? storedX : rect.left,
    y: panel.hidden && Number.isFinite(storedY) ? storedY : rect.top,
  };
  try { localStorage.setItem(uiStorageKey(participantId, key), JSON.stringify(preference)); } catch { /* Local UI preferences are optional. */ }
}

function setFloatingPanelOpen(panel: HTMLElement, key: 'dice-tools' | 'dice-history', open: boolean, persist = true): void {
  panel.hidden = !open;
  select<HTMLButtonElement>(key === 'dice-tools' ? '#dice-tools-toggle' : '#dice-history-toggle').setAttribute('aria-expanded', String(open));
  if (open) {
    panel.style.zIndex = String(++floatingPanelZ);
    clampFloatingPanel(panel);
  }
  if (persist && identity?.participantId) saveFloatingPanel(panel, identity.participantId, key);
  if (key === 'dice-history' && open) { unseenDiceRolls = 0; updateDiceBadge(); }
}

function resetFloatingPanelPosition(panel: HTMLElement, key: 'dice-tools' | 'dice-history', side: 'left' | 'right'): void {
  const rect = measureFloatingPanel(panel);
  const width = rect.width || Math.min(350, Math.max(0, window.innerWidth - 24));
  const height = rect.height || Math.min(420, Math.max(0, window.innerHeight - 24));
  panel.style.left = `${side === 'left' ? 16 : window.innerWidth - width - 16}px`;
  panel.style.top = `${window.innerHeight - height - 16}px`;
  panel.style.right = 'auto'; panel.style.bottom = 'auto';
  clampFloatingPanel(panel);
  if (identity?.participantId) saveFloatingPanel(panel, identity.participantId, key);
}

function restoreFloatingPanel(panel: HTMLElement, key: 'dice-tools' | 'dice-history', side: 'left' | 'right', participantId: string): void {
  const preference = readPanelPreference(participantId, key);
  const oldVisibility = panel.style.visibility;
  panel.hidden = false;
  panel.style.visibility = 'hidden';
  const rect = panel.getBoundingClientRect();
  const width = rect.width || Math.min(350, Math.max(0, window.innerWidth - 24));
  const height = rect.height || Math.min(420, Math.max(0, window.innerHeight - 24));
  const x = preference?.x ?? (side === 'left' ? 16 : window.innerWidth - width - 16);
  const y = preference?.y ?? window.innerHeight - height - 16;
  panel.style.left = `${x}px`;
  panel.style.top = `${y}px`;
  panel.style.right = 'auto';
  panel.style.bottom = 'auto';
  panel.style.visibility = oldVisibility;
  panel.hidden = !preference?.open;
  select<HTMLButtonElement>(key === 'dice-tools' ? '#dice-tools-toggle' : '#dice-history-toggle').setAttribute('aria-expanded', String(!panel.hidden));
  clampFloatingPanel(panel);
}

function saveSheetPanelPreference(): void {
  if (!identity) return;
  const rect = sheetPanel.getBoundingClientRect();
  const storedX = Number.parseFloat(sheetPanel.style.left);
  const storedY = Number.parseFloat(sheetPanel.style.top);
  const preference: SheetPanelPreference = {
    version: 1,
    open: !sheetPanel.hidden,
    collapsed: sheetPanel.classList.contains('is-collapsed'),
    x: Number.isFinite(storedX) ? storedX : rect.left,
    y: Number.isFinite(storedY) ? storedY : rect.top,
    sheetId: openSheetId ?? null,
  };
  writeSheetPanelPreference(localStorage, identity.participantId, preference);
}

function setSheetCollapsed(collapsed: boolean, persist = true): void {
  sheetPanel.classList.toggle('is-collapsed', collapsed);
  sheetCollapse.textContent = collapsed ? '▸' : '–';
  sheetCollapse.title = collapsed ? 'Развернуть лист' : 'Свернуть лист';
  sheetCollapse.setAttribute('aria-label', sheetCollapse.title);
  sheetCollapse.setAttribute('aria-expanded', String(!collapsed));
  if (collapsed) closeSheetRollPanel();
  clampFloatingPanel(sheetPanel);
  if (persist) saveSheetPanelPreference();
}

function restoreSheetPanelPreference(participantId: string): void {
  const preference = readSheetPanelPreference(localStorage, participantId);
  const oldVisibility = sheetPanel.style.visibility;
  sheetPanel.hidden = false;
  sheetPanel.style.visibility = 'hidden';
  const rect = sheetPanel.getBoundingClientRect();
  const width = rect.width || Math.min(470, Math.max(0, window.innerWidth - 24));
  const height = rect.height || Math.min(700, Math.max(0, window.innerHeight - 24));
  const x = preference?.x ?? Math.max(16, window.innerWidth - width - 20);
  const y = preference?.y ?? Math.min(84, Math.max(16, window.innerHeight - height - 16));
  sheetPanel.style.left = `${x}px`;
  sheetPanel.style.top = `${y}px`;
  sheetPanel.style.right = 'auto';
  sheetPanel.style.bottom = 'auto';
  sheetPanel.style.visibility = oldVisibility;
  sheetPanel.hidden = true;
  setSheetCollapsed(preference?.collapsed ?? false, false);
  pendingSheetRestoreId = preference?.open && preference.sheetId ? preference.sheetId : undefined;
}

function defaultSheetRollPosition(): { x: number; y: number; width: number; height: number } {
  const anchor = sheetPanel.hidden ? undefined : sheetPanel.getBoundingClientRect();
  const rect = measureFloatingPanel(sheetRollPanel);
  const width = rect.width || Math.min(330, Math.max(0, window.innerWidth - 24));
  const height = rect.height || Math.min(420, Math.max(0, window.innerHeight - 24));
  let x = anchor ? anchor.right + 10 : window.innerWidth - width - 20;
  if (anchor && x + width > window.innerWidth - 8) x = anchor.left - width - 10;
  const y = anchor ? anchor.top + 12 : Math.max(16, (window.innerHeight - height) / 2);
  return { ...clampFloatingPosition(x, y, width, height, window.innerWidth, window.innerHeight), width, height };
}

function saveSheetRollPanelPreference(): void {
  if (!identity) return;
  const rect = sheetRollPanel.getBoundingClientRect();
  const storedX = Number.parseFloat(sheetRollPanel.style.left);
  const storedY = Number.parseFloat(sheetRollPanel.style.top);
  writeSheetRollPanelPreference(localStorage, identity.participantId,
    Number.isFinite(storedX) ? storedX : rect.left,
    Number.isFinite(storedY) ? storedY : rect.top);
}

function positionSheetRollPanel(useStoredPosition = true): void {
  const stored = useStoredPosition && identity
    ? readSheetRollPanelPreference(localStorage, identity.participantId)
    : undefined;
  const fallback = defaultSheetRollPosition();
  const position = stored
    ? clampFloatingPosition(stored.x, stored.y, fallback.width, fallback.height, window.innerWidth, window.innerHeight)
    : fallback;
  sheetRollPanel.style.left = `${position.x}px`;
  sheetRollPanel.style.top = `${position.y}px`;
  sheetRollPanel.style.right = 'auto';
  sheetRollPanel.style.bottom = 'auto';
}

function resetSheetRollPanelPosition(): void {
  if (identity) writeSheetRollPanelPreference(localStorage, identity.participantId, null, null);
  positionSheetRollPanel(false);
  raiseSheetRollPanel();
}

function raiseSheetRollPanel(): void {
  if (sheetRollPanel.hidden) return;
  const panelZ = Number.parseInt(sheetPanel.hidden ? '0' : sheetPanel.style.zIndex || '0', 10);
  floatingPanelZ = Math.max(floatingPanelZ, Number.isFinite(panelZ) ? panelZ : 0) + 1;
  sheetRollPanel.style.zIndex = String(floatingPanelZ);
  if (!sheetPanel.hidden) sheetPanel.style.zIndex = String(Math.max(1, floatingPanelZ - 1));
}

function openSheetRollPanel(characteristicName: string): void {
  sheetRollName.textContent = characteristicName;
  if (pbtaControls.parentElement !== sheetRollControls) sheetRollControls.append(pbtaControls);
  sheetRollPanel.hidden = false;
  positionSheetRollPanel();
  raiseSheetRollPanel();
}

function closeSheetRollPanel(): void {
  if (!sheetRollPanel.hidden) sheetRollPanel.hidden = true;
  if (pbtaControls.parentElement !== pbtaControlsHome) pbtaControlsHome.append(pbtaControls);
  pendingRollContext = undefined;
}

function saveLayerPanelPreference(collapsed: boolean): void {
  if (!identity || identity.role !== 'gm') return;
  try { localStorage.setItem(uiStorageKey(identity.participantId, 'layers'), JSON.stringify({ version: 1, collapsed })); } catch { /* Local UI preferences are optional. */ }
}

function setLayersCollapsed(collapsed: boolean, persist = true): void {
  layersPanel.classList.toggle('is-collapsed', collapsed);
  layersPanel.inert = collapsed;
  layersExpandButton.hidden = !collapsed;
  select<HTMLButtonElement>('#layers-collapse').setAttribute('aria-expanded', String(!collapsed));
  if (persist) saveLayerPanelPreference(collapsed);
}

function setupParticipantUi(participantId: string): void {
  if (!participantId || uiPreferencesParticipantId === participantId) return;
  uiPreferencesParticipantId = participantId;
  knownDiceRollIds = undefined;
  unseenDiceRolls = 0;
  restoreFloatingPanel(diceToolsPanel, 'dice-tools', 'left', participantId);
  restoreFloatingPanel(diceHistoryPanel, 'dice-history', 'right', participantId);
  restoreSheetPanelPreference(participantId);
  updateDiceBadge();
  if (identity?.role === 'gm') {
    let collapsed = false;
    try {
      const stored = JSON.parse(localStorage.getItem(uiStorageKey(participantId, 'layers')) || 'null') as { version?: unknown; collapsed?: unknown } | null;
      if (stored?.version === 1 && typeof stored.collapsed === 'boolean') collapsed = stored.collapsed;
    } catch { /* Invalid preferences fall back to the expanded panel. */ }
    setLayersCollapsed(collapsed, false);
  }
}

function makeFloatingPanelDraggable(panel: HTMLElement, key: 'dice-tools' | 'dice-history' | 'sheet' | 'sheet-roll'): void {
  const bringToFront = () => {
    panel.style.zIndex = String(++floatingPanelZ);
    if (key === 'sheet' || key === 'sheet-roll') raiseSheetRollPanel();
  };
  panel.addEventListener('pointerdown', bringToFront);
  const handle = panel.querySelector<HTMLElement>('[data-panel-drag-handle]');
  if (!handle) return;
  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || (event.target instanceof Element && event.target.closest('button, input, select, textarea, a, [role="button"]'))) return;
    event.preventDefault();
    event.stopPropagation();
    bringToFront();
    clampFloatingPanel(panel);
    const initial = panel.getBoundingClientRect();
    const pointerX = event.clientX;
    const pointerY = event.clientY;
    handle.setPointerCapture(event.pointerId);
    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== event.pointerId) return;
      panel.style.left = `${initial.left + moveEvent.clientX - pointerX}px`;
      panel.style.top = `${initial.top + moveEvent.clientY - pointerY}px`;
      clampFloatingPanel(panel);
    };
    const finish = (finishEvent: PointerEvent) => {
      if (finishEvent.pointerId !== event.pointerId) return;
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', finish);
      handle.removeEventListener('pointercancel', finish);
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
      if (key === 'sheet') saveSheetPanelPreference();
      else if (key === 'sheet-roll') saveSheetRollPanelPreference();
      else if (identity?.participantId) saveFloatingPanel(panel, identity.participantId, key);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
  });
}

function updateBoard(state: RoomMessage) {
  if (identity) setupParticipantUi(identity.participantId);
  const previousIds = knownDiceRollIds;
  const nextIds = new Set((state.diceRolls || []).map((roll) => roll.id));
  if (previousIds) {
    const added = [...nextIds].filter((id) => !previousIds.has(id)).length;
    if (added && diceHistoryPanel.hidden) { unseenDiceRolls += added; updateDiceBadge(); }
  }
  knownDiceRollIds = nextIds;
  roomState = state;
  applyBoardBackground(state.background);
  if (pendingSheetRestoreId) {
    const restoreId = pendingSheetRestoreId;
    pendingSheetRestoreId = undefined;
    const sheet = state.sheets.find((entry) => entry.id === restoreId);
    if (sheet) openSheet(sheet);
  }
  if (identity) {
    const key = `tabletop-active-layer:${location.host}`;
    if (!state.layers.some((layer) => layer.id === activeLayerId)) {
      const preferred = localStorage.getItem(key);
      activeLayerId = state.layers.some((layer) => layer.id === preferred) ? preferred! : state.layers.at(-1)?.id;
    }
  }
  if (!state.objects.some((item) => item.id === selectedObjectId)) selectedObjectId = undefined;
  if (!state.stickers?.some((item) => item.id === selectedStickerId)) selectedStickerId = undefined;
  if (!state.noteMarkers?.some((item) => item.id === selectedMarkerId)) selectedMarkerId = undefined;
  select<HTMLButtonElement>('#sticker-create').hidden = false;
  renderLayers();
  renderAssets();
  renderDicePanel();
  renderSheetsCatalog();
  if (openSheetId) renderSheetPanel();
  if (openOwnSheetAfterCreate && identity) {
    const ownSheet = state.sheets
      .filter((sheet) => identity!.role === 'gm' ? !sheet.assignedPlayerId : sheet.assignedPlayerId === identity!.participantId)
      .filter((sheet) => sheet.systemId === pbtaSystemModule.id)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    if (ownSheet) {
      openOwnSheetAfterCreate = false;
      openSheet(ownSheet);
    }
  }
  drawObjects();
}

function updateDiceBadge() {
  diceNewCount.hidden = unseenDiceRolls === 0;
  diceNewCount.textContent = unseenDiceRolls > 9 ? '9+' : String(unseenDiceRolls);
}

function renderDicePanel() {
  if (!roomState || !identity) return;
  const active = roomState.activeSystem;
  const nextSystem = active?.id ?? 'none';
  if (document.activeElement !== systemSelect) systemSelect.value = nextSystem;
  systemSelect.disabled = identity.role !== 'gm';
  systemSave.hidden = identity.role !== 'gm' || systemSelect.value === nextSystem;
  pbtaControls.hidden = nextSystem !== 'pbta-2d6';
  if (nextSystem !== 'pbta-2d6' && !sheetRollPanel.hidden) closeSheetRollPanel();
  pbtaActorRow.hidden = identity.role !== 'gm';
  pbtaActor.hidden = identity.role !== 'gm';
  const actorValue = pbtaActor.value;
  pbtaActor.replaceChildren(...roomState.participants.filter((participant) => participant.role === 'player').map((participant) => {
    const option = document.createElement('option'); option.value = participant.participantId; option.textContent = participant.name; return option;
  }));
  if (roomState.participants.some((participant) => participant.participantId === actorValue && participant.role === 'player')) pbtaActor.value = actorValue;
  diceHistory.replaceChildren();
  if (!roomState.diceRolls.length) {
    const empty = document.createElement('li'); empty.className = 'dice-history-empty'; empty.textContent = 'Пока нет бросков.'; diceHistory.append(empty); return;
  }
  for (const roll of roomState.diceRolls) diceHistory.append(renderDiceEntry(roll));
}

function renderDiceEntry(roll: DiceRollEntry): HTMLLIElement {
  const item = document.createElement('li'); item.className = 'dice-entry';
  const title = document.createElement('div'); title.className = 'dice-entry-top';
  const label = roll.kind === 'free' ? `${roll.actorName} · свободный бросок` : roll.authorId === roll.actorId ? `${roll.actorName} · PbtA` : `${roll.authorName} за ${roll.actorName} · PbtA`;
  const heading = document.createElement('span'); heading.textContent = label;
  const time = document.createElement('time'); time.className = 'dice-entry-time'; time.dateTime = roll.createdAt; time.textContent = new Date(roll.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  title.append(heading, time);
  const detail = document.createElement('div'); detail.className = 'dice-entry-detail';
  if (roll.kind === 'free') detail.textContent = `${roll.dice.length}d${roll.sides}: ${roll.dice.join(' + ')} = ${roll.total}`;
  else {
    const modifier = roll.situationalModifier > 0 ? ' + Превосходство 1' : roll.situationalModifier < 0 ? ' − Угнетение 1' : '';
    const discarded = roll.discardedDie === null ? '' : ` · отброшен ${roll.discardedDie}`;
    const category = roll.category === 'failure' ? 'Неудача' : roll.category === 'success' ? 'Обычный успех' : 'Триумфальный успех';
    const critical = roll.critical === 'critical-failure' ? ' · Критический провал' : roll.critical === 'critical-success' ? ' · Критический успех' : '';
    const reroll = roll.rerollOf ? ' · Сила Судьбы' : '';
    const characteristic = roll.characteristicName ? `${roll.characteristicName}: ` : '';
    detail.textContent = `${roll.disadvantage ? '3d6' : '2d6'} [${roll.dice.join(', ')}]${discarded} + ${characteristic}бонус ${roll.characteristicBonus}${modifier} = ${roll.total} · ${category}${critical}${reroll}`;
    if (roll.critical) detail.classList.add('dice-entry-critical');
  }
  item.append(title, detail);
  if (roll.kind === 'pbta' && (roll.authorId === identity?.participantId || identity?.role === 'gm')) {
    const reroll = document.createElement('button'); reroll.type = 'button'; reroll.className = 'secondary'; reroll.textContent = 'Повторить · Сила Судьбы';
    reroll.addEventListener('click', () => void runCommand('dice:reroll', { rollId: roll.id })); item.append(reroll);
  }
  return item;
}

function accessibleAssets() {
  return roomState?.assets ?? roomState?.availableAssets ?? [];
}

function canEditSheet(sheet: CharacterSheet): boolean {
  return identity?.role === 'gm' || sheet.assignedPlayerId === identity?.participantId;
}

function canPrepareSheetRoll(sheet: CharacterSheet): boolean {
  if (!identity) return false;
  if (!sheet.assignedPlayerId) return false;
  return identity.role === 'gm' ? true : sheet.assignedPlayerId === identity.participantId;
}

function sheetInitial(name: string): string {
  return (name.trim()[0] || '?').toUpperCase();
}

function makeSheetPortrait(assetId: string | null, name: string, className: string): HTMLElement {
  if (assetId) {
    const image = document.createElement('img');
    image.className = className;
    image.src = `/api/assets/${encodeURIComponent(assetId)}`;
    image.alt = `Портрет ${name}`;
    image.loading = 'lazy';
    return image;
  }
  const fallback = document.createElement('span');
  fallback.className = `${className} sheet-portrait-fallback`;
  fallback.textContent = sheetInitial(name);
  fallback.setAttribute('aria-hidden', 'true');
  return fallback;
}

function sheetAssignedLabel(sheet: CharacterSheet): string {
  return sheet.assignedPlayerId ? `Игрок: ${sheet.assignedPlayerName || 'неизвестен'}` : 'Не назначен';
}

function appendSheetSection(title: string, sheets: CharacterSheet[], emptyText: string, options: { create?: boolean; assign?: boolean } = {}) {
  const heading = document.createElement('li');
  heading.className = 'sheet-catalog-heading-row';
  const label = document.createElement('h3');
  label.textContent = `${title} · ${sheets.length}`;
  heading.append(label);
  if (options.create) heading.append(makeCreateSheetButton());
  sheetsList.append(heading);
  if (!sheets.length) {
    const empty = document.createElement('li');
    empty.className = 'sheet-catalog-empty-row';
    empty.textContent = emptyText;
    sheetsList.append(empty);
    return;
  }
  for (const sheet of sheets) sheetsList.append(renderSheetCatalogCard(sheet, options.assign === true));
}

function makeCreateSheetButton(): HTMLButtonElement {
  const create = document.createElement('button');
  create.type = 'button';
  create.className = 'sheet-catalog-action';
  create.textContent = '＋ Создать';
  create.disabled = roomState?.activeSystem?.id !== pbtaSystemModule.id;
  create.title = create.disabled ? 'Сначала включите систему PbtA.' : 'Создать лист персонажа';
  create.addEventListener('click', createOwnSheet);
  return create;
}

function renderSheetCatalogCard(sheet: CharacterSheet, assign: boolean): HTMLLIElement {
  const item = document.createElement('li');
  item.className = 'sheet-catalog-item';
  const portrait = makeSheetPortrait(sheet.portraitAssetId, sheet.characterName || 'Без имени', 'sheet-catalog-portrait');
  const copy = document.createElement('div');
  copy.className = 'sheet-catalog-copy';
  const owner = document.createElement('span');
  owner.className = `sheet-catalog-owner${sheet.assignedPlayerId ? '' : ' unassigned'}`;
  owner.textContent = sheetAssignedLabel(sheet);
  const character = document.createElement('strong');
  character.className = 'sheet-catalog-character';
  character.textContent = sheet.characterName || 'Без имени';
  copy.append(owner, character);
  item.append(portrait, copy);
  const actions = document.createElement('div');
  actions.className = 'sheet-catalog-actions';
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'sheet-catalog-action';
  open.textContent = 'Открыть';
  open.addEventListener('click', () => openSheet(sheet));
  actions.append(open);
  if (!sheet.assignedPlayerId && identity?.role === 'gm') {
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'sheet-catalog-action danger-text';
    remove.textContent = 'Удалить';
    remove.title = 'Удалить подготовленный лист персонажа';
    remove.addEventListener('click', () => {
      const name = sheet.characterName || 'Без имени';
      if (!window.confirm(`Удалить лист персонажа «${name}»? Содержимое листа будет удалено без возможности восстановления из приложения.`)) return;
      void runCommand('sheet:delete', { id: sheet.id });
    });
    actions.append(remove);
  }
  item.append(actions);
  if (assign && identity?.role === 'gm') {
    const players = (roomState?.participants || []).filter((participant) => participant.role === 'player');
    const row = document.createElement('div');
    row.className = 'sheet-catalog-assign';
    const select = document.createElement('select');
    select.setAttribute('aria-label', `Назначить игрока для ${sheet.characterName || 'персонажа'}`);
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Назначить игроку…';
    select.append(placeholder);
    for (const player of players) {
      const option = document.createElement('option');
      option.value = player.participantId;
      option.textContent = player.name;
      select.append(option);
    }
    if (sheet.assignedPlayerId && !players.some((player) => player.participantId === sheet.assignedPlayerId)) {
      const option = document.createElement('option');
      option.value = sheet.assignedPlayerId;
      option.textContent = `${sheet.assignedPlayerName || 'Игрок'} (не в сети)`;
      select.append(option);
    }
    if (sheet.assignedPlayerId) select.value = sheet.assignedPlayerId;
    const assignButton = document.createElement('button');
    assignButton.type = 'button';
    assignButton.className = 'sheet-catalog-action';
    assignButton.textContent = sheet.assignedPlayerId ? 'Переназначить' : 'Назначить';
    assignButton.addEventListener('click', () => {
      const playerId = select.value;
      if (!playerId) { showCanvasMessage('Выберите игрока для назначения.', true); return; }
      const playerName = select.selectedOptions[0]?.textContent || 'выбранного игрока';
      if (!window.confirm(`Назначить лист «${sheet.characterName || 'Без имени'}» игроку ${playerName}?`)) return;
      void runCommand('sheet:assign', { id: sheet.id, playerId });
    });
    row.append(select, assignButton);
    if (sheet.assignedPlayerId) {
      const clear = document.createElement('button');
      clear.type = 'button';
      clear.className = 'sheet-catalog-action danger-text';
      clear.textContent = 'Снять';
      clear.addEventListener('click', () => {
        if (!window.confirm(`Снять назначение с листа «${sheet.characterName || 'Без имени'}»?`)) return;
        void runCommand('sheet:assign', { id: sheet.id, playerId: null });
      });
      row.append(clear);
    }
    item.append(row);
  }
  return item;
}

function renderSheetsCatalog() {
  sheetsList.replaceChildren();
  if (!roomState || !identity) return;
  const currentIdentity = identity;
  const sheets = [...(roomState.sheets || [])];
  if (currentIdentity.role === 'gm') {
    const assigned = sheets.filter((sheet) => sheet.assignedPlayerId).sort((left, right) => (left.assignedPlayerName || '').localeCompare(right.assignedPlayerName || '', 'ru'));
    const unassigned = sheets.filter((sheet) => !sheet.assignedPlayerId).sort((left, right) => left.characterName.localeCompare(right.characterName, 'ru'));
    appendSheetSection('Назначенные персонажи', assigned, 'Пока нет назначенных персонажей.', { assign: true });
    appendSheetSection('Подготовленные персонажи', unassigned, 'Неназначенных персонажей нет.', { assign: true, create: true });
    return;
  }
  const own = sheets.filter((sheet) => sheet.assignedPlayerId === currentIdentity.participantId);
  const others = sheets.filter((sheet) => sheet.assignedPlayerId && sheet.assignedPlayerId !== currentIdentity.participantId);
  appendSheetSection('Мои персонажи', own, 'У вас пока нет персонажей. Создайте первого.', { create: true });
  appendSheetSection('Другие персонажи', others, 'Других назначенных персонажей пока нет.');
}

function createOwnSheet() {
  if (!identity || !roomState || roomState.activeSystem?.id !== pbtaSystemModule.id) return;
  const name = window.prompt('Имя персонажа', identity.name);
  if (name === null) return;
  openOwnSheetAfterCreate = true;
  void runCommand('sheet:create', { characterName: name.trim() });
}

function openSheet(sheet: CharacterSheet) {
  closeSheetRollPanel();
  openSheetId = sheet.id;
  sheetDialogMode = DEFAULT_SHEET_PANEL_MODE;
  sheetGeneration += 1;
  editingAbilityId = undefined;
  sheetMessage.textContent = '';
  sheetPanel.hidden = false;
  sheetPanel.style.zIndex = String(++floatingPanelZ);
  renderSheetPanel();
  clampFloatingPanel(sheetPanel);
  saveSheetPanelPreference();
}

function closeSheetPanel() {
  closeSheetRollPanel();
  sheetGeneration += 1;
  openSheetId = undefined;
  editingAbilityId = undefined;
  sheetPanel.hidden = true;
  saveSheetPanelPreference();
}

function sheetSection(title: string, className: string): HTMLElement {
  const section = document.createElement('section');
  section.className = `sheet-section ${className}`;
  const heading = document.createElement('h3');
  heading.textContent = title;
  section.append(heading);
  return section;
}

function numberFromInput(input: HTMLInputElement, fallback: number): number {
  const value = Number(input.value);
  return Number.isSafeInteger(value) ? value : fallback;
}

function makeStepper(
  value: number, min: number, max: number, label: string,
  onChange: (value: number) => void,
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'sheet-stepper';
  const minus = document.createElement('button'); minus.type = 'button'; minus.textContent = '−'; minus.setAttribute('aria-label', `Уменьшить ${label}`);
  const input = document.createElement('input'); input.type = 'number'; input.min = String(min); input.max = String(max); input.value = String(value); input.setAttribute('aria-label', label);
  const plus = document.createElement('button'); plus.type = 'button'; plus.textContent = '+'; plus.setAttribute('aria-label', `Увеличить ${label}`);
  const emit = (next: number) => {
    const bounded = Math.max(min, Math.min(max, Math.round(next)));
    input.value = String(bounded);
    onChange(bounded);
  };
  minus.addEventListener('click', () => emit(numberFromInput(input, value) - 1));
  plus.addEventListener('click', () => emit(numberFromInput(input, value) + 1));
  input.addEventListener('change', () => emit(numberFromInput(input, value)));
  wrap.append(minus, input, plus);
  return wrap;
}

function moveIds<T extends { id: string; orderIndex: number }>(items: T[], id: string, direction: -1 | 1): string[] | undefined {
  const sorted = [...items].sort((left, right) => left.orderIndex - right.orderIndex);
  const index = sorted.findIndex((item) => item.id === id);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= sorted.length) return undefined;
  const [moving] = sorted.splice(index, 1);
  sorted.splice(target, 0, moving!);
  return sorted.map((item) => item.id);
}

function prepareSheetRoll(sheet: CharacterSheet, key: SheetCharacteristicKey, characteristicName: string) {
  if (!identity || !roomState || !canPrepareSheetRoll(sheet)) return;
  const active = roomState.activeSystem;
  if (!active || active.id !== pbtaSystemModule.id || active.version !== pbtaSystemModule.version) {
    showCanvasMessage('В комнате не выбрана система PbtA.', true);
    return;
  }
  const assignedPlayerId = sheet.assignedPlayerId;
  if (!assignedPlayerId) {
    showCanvasMessage('Лист не назначен игроку — бросок недоступен.', true);
    return;
  }
  if (identity.role === 'gm') {
    if (![...pbtaActor.options].some((option) => option.value === assignedPlayerId)) {
      showCanvasMessage('Назначенный игрок не подключён, бросок от его имени недоступен.', true);
      return;
    }
    pbtaActor.value = assignedPlayerId;
  }
  pendingRollContext = buildSheetRollContext(sheet, key, characteristicName);
  select<HTMLInputElement>('#pbta-bonus').value = String(pendingRollContext.characteristicBonus);
  openSheetRollPanel(characteristicName);
}

function renderSheetPanel() {
  const sheet = openSheetId ? (roomState?.sheets || []).find((entry) => entry.id === openSheetId) : undefined;
  if (!sheet || !identity) {
    openSheetId = undefined;
    sheetPanel.hidden = true;
    closeSheetRollPanel();
    saveSheetPanelPreference();
    return;
  }
  const canEdit = canEditSheet(sheet);
  if (!canEdit) sheetDialogMode = DEFAULT_SHEET_PANEL_MODE;
  sheetNameHeading.textContent = sheet.characterName || 'Без имени';
  sheetOwnerLabel.textContent = sheet.assignedPlayerName ? `Игрок: ${sheet.assignedPlayerName}` : 'Не назначен';
  sheetSystemLabel.textContent = `${pbtaSystemModule.name} · версия ${sheet.systemVersion} · схема ${sheet.schemaVersion}${sheet.creatorName !== sheet.assignedPlayerName ? ` · создатель: ${sheet.creatorName}` : ''}`;
  if (sheet.portraitAssetId) {
    sheetPortrait.src = `/api/assets/${encodeURIComponent(sheet.portraitAssetId)}`;
    sheetPortrait.alt = `Портрет ${sheet.characterName || sheet.assignedPlayerName || sheet.creatorName}`;
    sheetPortrait.hidden = false;
    sheetPortraitFallback.hidden = true;
  } else {
    sheetPortrait.hidden = true;
    sheetPortrait.removeAttribute('src');
    sheetPortraitFallback.hidden = false;
    sheetPortraitFallback.textContent = sheetInitial(sheet.characterName || sheet.assignedPlayerName || sheet.creatorName);
  }
  sheetEditToggle.hidden = !canEdit;
  sheetEditToggle.textContent = sheetDialogMode === 'edit' ? 'Просмотр' : 'Редактировать';
  sheetEditToggle.setAttribute('aria-pressed', String(sheetDialogMode === 'edit'));
  const editing = canChangeSheetStructure(sheetDialogMode, canEdit);
  sheetContent.replaceChildren();

  if (editing) {
    const identitySection = sheetSection('Персонаж', 'sheet-identity-section');
    const fields = document.createElement('div'); fields.className = 'sheet-fields';
    const nameLabel = document.createElement('label'); nameLabel.textContent = 'Имя персонажа';
    const nameInput = document.createElement('input'); nameInput.maxLength = 80; nameInput.value = sheet.characterName; nameInput.placeholder = 'Без имени';
    nameInput.addEventListener('change', () => void runCommand('sheet:update', { id: sheet.id, changes: { characterName: nameInput.value } }));
    nameLabel.append(nameInput);
    const portraitRow = document.createElement('div'); portraitRow.className = 'sheet-portrait-actions';
    const pickPortrait = document.createElement('button'); pickPortrait.type = 'button'; pickPortrait.className = 'secondary'; pickPortrait.textContent = 'Выбрать портрет';
    pickPortrait.addEventListener('click', () => openAssetPicker('sheet-portrait'));
    portraitRow.append(pickPortrait);
    if (sheet.portraitAssetId) {
      const clearPortrait = document.createElement('button'); clearPortrait.type = 'button'; clearPortrait.className = 'secondary danger-text'; clearPortrait.textContent = 'Убрать портрет';
      clearPortrait.addEventListener('click', () => void runCommand('sheet:update', { id: sheet.id, changes: { portraitAssetId: null } }));
      portraitRow.append(clearPortrait);
    }
    fields.append(nameLabel, portraitRow);
    identitySection.append(fields);
    sheetContent.append(identitySection);
  }

  const characteristics = sheetSection('Характеристики', 'sheet-characteristics-section');
  if (canPrepareSheetRoll(sheet)) {
    const hint = document.createElement('p'); hint.className = 'panel-note'; hint.textContent = 'Нажмите на название характеристики, чтобы открыть окно броска PbtA.';
    characteristics.append(hint);
  }
  const characteristicGrid = document.createElement('div'); characteristicGrid.className = 'sheet-characteristics';
  for (const definition of pbtaSheetSchema.characteristics) {
    const card = document.createElement('div'); card.className = 'sheet-characteristic';
    const name = document.createElement('button'); name.type = 'button'; name.className = 'sheet-characteristic-name'; name.textContent = definition.name;
    if (canPrepareSheetRoll(sheet)) {
      name.title = 'Подготовить бросок по этой характеристике';
      name.addEventListener('click', () => prepareSheetRoll(sheet, definition.key, definition.name));
    } else {
      name.disabled = true;
      name.title = 'Только просмотр';
    }
    card.append(name);
    if (editing) {
      card.append(makeStepper(sheet.characteristics[definition.key], -1000, 1000, definition.name, (value) => {
        void runCommand('sheet:update', { id: sheet.id, changes: { characteristics: { [definition.key]: value } } });
      }));
    } else {
      const value = document.createElement('span'); value.className = 'sheet-characteristic-value'; value.textContent = formatSigned(sheet.characteristics[definition.key]);
      card.append(value);
    }
    characteristicGrid.append(card);
  }
  characteristics.append(characteristicGrid);
  sheetContent.append(characteristics);

  const fate = sheetSection('Сила Судьбы', 'sheet-fate-section');
  const fateRow = document.createElement('div'); fateRow.className = 'sheet-resource';
  const fateLabel = document.createElement('strong'); fateLabel.textContent = 'Сила Судьбы';
  fateRow.append(fateLabel);
  if (canEdit) {
    fateRow.append(makeStepper(sheet.fate, -1_000_000_000, 1_000_000_000, 'Сила Судьбы', (value) => {
      void runCommand('sheet:fate:update', { sheetId: sheet.id, value });
    }));
  } else {
    const value = document.createElement('span'); value.className = 'sheet-resource-value'; value.textContent = String(sheet.fate);
    fateRow.append(value);
  }
  const fateNote = document.createElement('p'); fateNote.className = 'panel-note'; fateNote.textContent = 'Не списывается автоматически при повторном броске — учитывайте расход вручную.';
  fate.append(fateRow, fateNote);
  sheetContent.append(fate);

  const counters = sheetSection('Дополнительные счётчики', 'sheet-counters-section');
  const sortedCounters = [...sheet.counters].sort((left, right) => left.orderIndex - right.orderIndex);
  if (!sortedCounters.length) {
    const empty = document.createElement('p'); empty.className = 'panel-note'; empty.textContent = 'Дополнительных счётчиков нет.';
    counters.append(empty);
  }
  for (const counter of sortedCounters) {
    const row = document.createElement('div'); row.className = 'sheet-counter-row';
    if (editing) {
      const name = document.createElement('input'); name.value = counter.name; name.maxLength = 80; name.setAttribute('aria-label', 'Название счётчика');
      name.addEventListener('change', () => void runCommand('sheet:counter:update', { sheetId: sheet.id, id: counter.id, changes: { name: name.value } }));
      row.append(name, makeStepper(counter.value, -1_000_000_000, 1_000_000_000, counter.name, (value) => {
        void runCommand('sheet:counter:update', { sheetId: sheet.id, id: counter.id, changes: { value } });
      }));
      const tools = document.createElement('div'); tools.className = 'sheet-row-tools';
      tools.append(
        makeRowButton('↑', 'Переместить выше', () => {
          const ids = moveIds(sheet.counters, counter.id, -1); if (ids) void runCommand('sheet:counter:reorder', { sheetId: sheet.id, ids });
        }),
        makeRowButton('↓', 'Переместить ниже', () => {
          const ids = moveIds(sheet.counters, counter.id, 1); if (ids) void runCommand('sheet:counter:reorder', { sheetId: sheet.id, ids });
        }),
        makeRowButton('×', 'Удалить счётчик', () => void runCommand('sheet:counter:delete', { sheetId: sheet.id, id: counter.id }), true),
      );
      row.append(tools);
    } else {
      const name = document.createElement('span'); name.textContent = counter.name;
      if (canEdit) {
        row.append(name, makeStepper(counter.value, -1_000_000_000, 1_000_000_000, counter.name, (value) => {
          void runCommand('sheet:counter:value', { sheetId: sheet.id, id: counter.id, value });
        }));
      } else {
        const value = document.createElement('strong'); value.textContent = String(counter.value);
        row.append(name, value);
      }
    }
    counters.append(row);
  }
  if (editing) {
    const add = document.createElement('button'); add.type = 'button'; add.className = 'secondary sheet-add-button'; add.textContent = '＋ Счётчик';
    add.addEventListener('click', () => {
      const name = window.prompt('Название счётчика', 'Ресурс');
      if (name?.trim()) void runCommand('sheet:counter:create', { sheetId: sheet.id, name: name.trim(), value: 0 });
    });
    counters.append(add);
  }
  sheetContent.append(counters);

  const abilities = sheetSection('Особые способности', 'sheet-abilities-section');
  const collapsed = readCollapsedAbilities(localStorage, identity.participantId, sheet.id);
  const sortedAbilities = [...sheet.abilities].sort((left, right) => left.orderIndex - right.orderIndex);
  if (!sortedAbilities.length) {
    const empty = document.createElement('p'); empty.className = 'panel-note'; empty.textContent = 'Особых способностей нет.';
    abilities.append(empty);
  }
  for (const ability of sortedAbilities) {
    abilities.append(renderSheetAbility(sheet, ability, editing, collapsed.has(ability.id)));
  }
  if (editing) {
    const add = document.createElement('button'); add.type = 'button'; add.className = 'secondary sheet-add-button'; add.textContent = '＋ Способность';
    add.addEventListener('click', () => {
      const name = window.prompt('Название способности', 'Новая способность');
      if (name?.trim()) void runCommand('sheet:ability:create', { sheetId: sheet.id, name: name.trim() });
    });
    abilities.append(add);
  }
  sheetContent.append(abilities);
}

function makeRowButton(label: string, title: string, action: () => void, danger = false): HTMLButtonElement {
  const button = document.createElement('button'); button.type = 'button'; button.className = danger ? 'sheet-row-button danger-text' : 'sheet-row-button'; button.textContent = label; button.title = title; button.setAttribute('aria-label', title);
  button.addEventListener('click', action);
  return button;
}

function renderSheetAbility(sheet: CharacterSheet, ability: CharacterSheetAbility, editing: boolean, collapsed: boolean): HTMLElement {
  const card = document.createElement('article'); card.className = 'sheet-ability';
  const header = document.createElement('div'); header.className = 'sheet-ability-header';
  const expand = document.createElement('button'); expand.type = 'button'; expand.className = 'sheet-ability-expand'; expand.textContent = collapsed ? '▸' : '▾'; expand.setAttribute('aria-expanded', String(!collapsed)); expand.setAttribute('aria-label', collapsed ? 'Развернуть способность' : 'Свернуть способность');
  expand.addEventListener('click', () => {
    if (!identity) return;
    setAbilityCollapsed(localStorage, identity.participantId, sheet.id, ability.id, !collapsed);
    renderSheetPanel();
  });
  const image = makeSheetPortrait(ability.assetId, ability.name, 'sheet-ability-image');
  const title = document.createElement('strong'); title.className = 'sheet-ability-name'; title.textContent = ability.name || 'Без названия';
  header.append(expand, image, title);
  if (collapsed && ability.counterEnabled) {
    const summary = document.createElement('span'); summary.className = 'sheet-ability-summary'; summary.textContent = `${ability.counterName || 'Счётчик'}: ${ability.counterValue}`;
    header.append(summary);
  }
  if (collapsed && ability.checkboxEnabled && ability.checked) {
    const summary = document.createElement('span'); summary.className = 'sheet-ability-summary'; summary.textContent = ability.checkboxLabel || 'Отмечено';
    header.append(summary);
  }
  card.append(header);
  if (collapsed) return card;

  const body = document.createElement('div'); body.className = 'sheet-ability-body';
  const description = document.createElement('div'); description.className = 'sheet-ability-description'; description.textContent = ability.description || 'Описание не задано.';
  body.append(description);

  if (ability.counterEnabled) {
    const counter = document.createElement('div'); counter.className = 'sheet-resource sheet-ability-resource';
    const label = document.createElement('strong'); label.textContent = ability.counterName || 'Счётчик';
    counter.append(label);
    if (canEditSheet(sheet)) {
      counter.append(makeStepper(ability.counterValue, -1_000_000_000, 1_000_000_000, ability.counterName || 'Счётчик способности', (value) => {
        if (editing) void runCommand('sheet:ability:update', { sheetId: sheet.id, id: ability.id, changes: { counterValue: value } });
        else void runCommand('sheet:ability:value', { sheetId: sheet.id, id: ability.id, counterValue: value });
      }));
    } else {
      const value = document.createElement('span'); value.className = 'sheet-resource-value'; value.textContent = String(ability.counterValue);
      counter.append(value);
    }
    body.append(counter);
  }

  if (ability.checkboxEnabled) {
    const checkLabel = document.createElement('label'); checkLabel.className = 'sheet-ability-check';
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = ability.checked; checkbox.disabled = !canEditSheet(sheet);
    checkbox.addEventListener('change', () => {
      if (editing) void runCommand('sheet:ability:update', { sheetId: sheet.id, id: ability.id, changes: { checked: checkbox.checked } });
      else void runCommand('sheet:ability:value', { sheetId: sheet.id, id: ability.id, checked: checkbox.checked });
    });
    checkLabel.append(checkbox, document.createTextNode(ability.checkboxLabel || 'Отметка'));
    body.append(checkLabel);
  }

  if (editing) {
    const editor = document.createElement('div'); editor.className = 'sheet-ability-editor';
    const nameLabel = document.createElement('label'); nameLabel.textContent = 'Название';
    const name = document.createElement('input'); name.value = ability.name; name.maxLength = 80;
    name.addEventListener('change', () => void runCommand('sheet:ability:update', { sheetId: sheet.id, id: ability.id, changes: { name: name.value } }));
    nameLabel.append(name);
    const descriptionLabel = document.createElement('label'); descriptionLabel.textContent = 'Описание';
    const descriptionInput = document.createElement('textarea'); descriptionInput.rows = 5; descriptionInput.maxLength = 8000; descriptionInput.value = ability.description;
    descriptionInput.addEventListener('change', () => void runCommand('sheet:ability:update', { sheetId: sheet.id, id: ability.id, changes: { description: descriptionInput.value } }));
    descriptionLabel.append(descriptionInput);
    editor.append(nameLabel, descriptionLabel);

    const imageRow = document.createElement('div'); imageRow.className = 'sheet-portrait-actions';
    const pick = document.createElement('button'); pick.type = 'button'; pick.className = 'secondary'; pick.textContent = 'Выбрать картинку';
    pick.addEventListener('click', () => { editingAbilityId = ability.id; selectedAbilityAssetId = ability.assetId ?? undefined; openAssetPicker('ability'); });
    imageRow.append(pick);
    if (ability.assetId) {
      const clear = document.createElement('button'); clear.type = 'button'; clear.className = 'secondary danger-text'; clear.textContent = 'Убрать картинку';
      clear.addEventListener('click', () => void runCommand('sheet:ability:update', { sheetId: sheet.id, id: ability.id, changes: { assetId: null } }));
      imageRow.append(clear);
    }
    editor.append(imageRow);

    const counterToggle = document.createElement('label'); counterToggle.className = 'sheet-inline-check';
    const counterEnabled = document.createElement('input'); counterEnabled.type = 'checkbox'; counterEnabled.checked = ability.counterEnabled;
    counterEnabled.addEventListener('change', () => {
      const next = counterEnabled.checked;
      void runCommand('sheet:ability:update', { sheetId: sheet.id, id: ability.id, changes: { counterEnabled: next, ...(next && !ability.counterName ? { counterName: 'Заряды' } : {}) } });
    });
    counterToggle.append(counterEnabled, document.createTextNode(' Числовой счётчик'));
    editor.append(counterToggle);
    if (ability.counterEnabled) {
      const counterNameLabel = document.createElement('label'); counterNameLabel.textContent = 'Название счётчика';
      const counterName = document.createElement('input'); counterName.value = ability.counterName; counterName.maxLength = 80;
      counterName.addEventListener('change', () => void runCommand('sheet:ability:update', { sheetId: sheet.id, id: ability.id, changes: { counterName: counterName.value } }));
      counterNameLabel.append(counterName);
      editor.append(counterNameLabel);
    }

    const checkboxToggle = document.createElement('label'); checkboxToggle.className = 'sheet-inline-check';
    const checkboxEnabled = document.createElement('input'); checkboxEnabled.type = 'checkbox'; checkboxEnabled.checked = ability.checkboxEnabled;
    checkboxEnabled.addEventListener('change', () => {
      const next = checkboxEnabled.checked;
      void runCommand('sheet:ability:update', { sheetId: sheet.id, id: ability.id, changes: { checkboxEnabled: next, ...(next && !ability.checkboxLabel ? { checkboxLabel: 'Использовано' } : {}) } });
    });
    checkboxToggle.append(checkboxEnabled, document.createTextNode(' Чекбокс'));
    editor.append(checkboxToggle);
    if (ability.checkboxEnabled) {
      const checkboxLabel = document.createElement('label'); checkboxLabel.textContent = 'Подпись чекбокса';
      const checkboxText = document.createElement('input'); checkboxText.value = ability.checkboxLabel; checkboxText.maxLength = 80;
      checkboxText.addEventListener('change', () => void runCommand('sheet:ability:update', { sheetId: sheet.id, id: ability.id, changes: { checkboxLabel: checkboxText.value } }));
      checkboxLabel.append(checkboxText);
      const checkedLabel = document.createElement('label'); checkedLabel.className = 'sheet-inline-check';
      const checked = document.createElement('input'); checked.type = 'checkbox'; checked.checked = ability.checked;
      checked.addEventListener('change', () => void runCommand('sheet:ability:update', { sheetId: sheet.id, id: ability.id, changes: { checked: checked.checked } }));
      checkedLabel.append(checked, document.createTextNode(' Отмечено'));
      editor.append(checkboxLabel, checkedLabel);
    }

    const tools = document.createElement('div'); tools.className = 'sheet-row-tools';
    tools.append(
      makeRowButton('↑', 'Переместить выше', () => {
        const ids = moveIds(sheet.abilities, ability.id, -1); if (ids) void runCommand('sheet:ability:reorder', { sheetId: sheet.id, ids });
      }),
      makeRowButton('↓', 'Переместить ниже', () => {
        const ids = moveIds(sheet.abilities, ability.id, 1); if (ids) void runCommand('sheet:ability:reorder', { sheetId: sheet.id, ids });
      }),
      makeRowButton('×', 'Удалить способность', () => void runCommand('sheet:ability:delete', { sheetId: sheet.id, id: ability.id }), true),
    );
    editor.append(tools);
    body.append(editor);
  }
  card.append(body);
  return card;
}

function setNoteMessage(message: string) { select<HTMLElement>('#note-message').textContent = message; }
function clearNoteContent() { select<HTMLElement>('#note-view-body').textContent = ''; select<HTMLElement>('#note-view-images').replaceChildren(); }
function closeNoteDialog() { noteRequestSequence += 1; noteDialog.close(); openNoteId = undefined; editingNoteId = undefined; clearNoteContent(); }

async function openNote(id: string) {
  const requestSequence = ++noteRequestSequence;
  try {
    const response = await fetch(`/api/notes/${encodeURIComponent(id)}`, { cache: 'no-store' });
    if (requestSequence !== noteRequestSequence) return;
    if (!response.ok) {
      if (openNoteId === id) closeNoteDialog();
      else showCanvasMessage('У вас больше нет доступа к этой заметке.', true);
      return;
    }
    const note = (await response.json() as { note: NoteRecord }).note;
    if (requestSequence !== noteRequestSequence) return;
    openNoteId = id; editingNoteId = id; noteDialogMode = 'view';
    select<HTMLElement>('#note-dialog-heading').textContent = note.title;
    select<HTMLElement>('#note-privacy').textContent = note.access === 'gm-only' ? 'Только ведущий' : note.access === 'selected-players' ? 'Выбранные игроки' : 'Все игроки';
    select<HTMLTextAreaElement>('#note-body').hidden = true;
    select<HTMLInputElement>('#note-title').hidden = true;
    select<HTMLLabelElement>('label[for="note-title"]').hidden = true;
    select<HTMLLabelElement>('label[for="note-access"]').hidden = true;
    select<HTMLSelectElement>('#note-access').hidden = true;
    select<HTMLLabelElement>('label[for="note-marker-type"]').hidden = true;
    select<HTMLSelectElement>('#note-marker-type').hidden = true;
    select<HTMLLabelElement>('label[for="note-body"]').hidden = true;
    select<HTMLElement>('#note-participants').hidden = true;
    select<HTMLElement>('.note-assets').hidden = true;
    select<HTMLElement>('#note-marker-text-row').hidden = true; select<HTMLElement>('#note-marker-image-row').hidden = true;
    const body = select<HTMLElement>('#note-view-body'); body.textContent = note.body; body.hidden = false;
    const images = select<HTMLElement>('#note-view-images'); images.replaceChildren(); images.hidden = note.images.length === 0;
    for (const asset of note.images) { const image = document.createElement('img'); image.src = `/api/assets/${encodeURIComponent(asset.id)}`; image.alt = asset.originalName; image.loading = 'lazy'; images.append(image); }
    select<HTMLButtonElement>('#note-save').hidden = true;
    select<HTMLButtonElement>('#note-place-marker').hidden = false;
    const edit = select<HTMLButtonElement>('#note-edit'); edit.hidden = identity?.role !== 'gm';
    setNoteMessage('');
    if (!noteDialog.open) noteDialog.showModal();
  } catch { setNoteMessage('Не удалось загрузить заметку. Проверьте соединение.'); }
}

function openNoteEditor(note?: NoteRecord) {
  if (identity?.role !== 'gm') return;
  noteRequestSequence += 1;
  noteEditorGeneration += 1;
  editingNoteId = note?.id; openNoteId = note?.id; noteDialogMode = 'edit';
  select<HTMLElement>('#note-dialog-heading').textContent = note ? 'Редактирование заметки' : 'Новая заметка';
  select<HTMLElement>('#note-privacy').textContent = note ? 'Настройки доступа' : 'Черновик';
  select<HTMLInputElement>('#note-title').value = note?.title || '';
  select<HTMLTextAreaElement>('#note-body').value = note?.body || '';
  select<HTMLSelectElement>('#note-access').value = note?.access || 'gm-only';
  select<HTMLSelectElement>('#note-marker-type').value = note?.markerType || 'text';
  select<HTMLInputElement>('#note-marker-text').value = note?.markerText === note?.title ? '' : note?.markerText || '';
  selectedMarkerAssetId = note?.markerAssetId;
  updateMarkerEditorFields();
  select<HTMLInputElement>('#note-title').hidden = false;
  select<HTMLTextAreaElement>('#note-body').hidden = false;
  select<HTMLLabelElement>('label[for="note-title"]').hidden = false;
  select<HTMLLabelElement>('label[for="note-access"]').hidden = false;
  select<HTMLSelectElement>('#note-access').hidden = false;
  select<HTMLLabelElement>('label[for="note-marker-type"]').hidden = false;
  select<HTMLSelectElement>('#note-marker-type').hidden = false;
  select<HTMLLabelElement>('label[for="note-body"]').hidden = false;
  select<HTMLElement>('#note-view-body').hidden = true; select<HTMLElement>('#note-view-images').hidden = true;
  select<HTMLElement>('.note-assets').hidden = false;
  const participantWrap = select<HTMLElement>('#note-participants'); participantWrap.hidden = true;
  const participantList = select<HTMLElement>('#note-participant-list'); participantList.replaceChildren();
  const participants = roomState?.participants.filter((person) => person.role === 'player') || [];
  for (const person of participants) {
    const label = document.createElement('label'); label.className = 'note-participant-row'; const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.value = person.participantId; checkbox.checked = note?.selectedParticipantIds.includes(person.participantId) || false;
    label.append(checkbox, document.createTextNode(person.name)); participantList.append(label);
  }
  const onlineIds = new Set(participants.map((person) => person.participantId));
  for (const participantId of note?.selectedParticipantIds || []) {
    if (onlineIds.has(participantId)) continue;
    const label = document.createElement('label'); label.className = 'note-participant-row';
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.value = participantId; checkbox.checked = true;
    label.append(checkbox, document.createTextNode(`Отключённый участник · ${participantId.slice(0, 8)}`)); participantList.append(label);
  }
  participantWrap.hidden = select<HTMLSelectElement>('#note-access').value !== 'selected-players';
  editingAssetIds = [...(note?.assetIds || [])]; renderNoteAttachments();
  select<HTMLButtonElement>('#note-save').hidden = false;
  select<HTMLButtonElement>('#note-place-marker').hidden = true;
  select<HTMLButtonElement>('#note-edit').hidden = true;
  setNoteMessage(''); if (!noteDialog.open) noteDialog.showModal();
}

function updateMarkerEditorFields() {
  const imageMode = select<HTMLSelectElement>('#note-marker-type').value === 'image';
  select<HTMLElement>('#note-marker-text-row').hidden = imageMode;
  select<HTMLElement>('#note-marker-image-row').hidden = !imageMode;
  const asset = roomState?.assets?.find((entry) => entry.id === selectedMarkerAssetId);
  select<HTMLElement>('#note-marker-image-name').textContent = asset?.originalName || (selectedMarkerAssetId ? 'Выбранное изображение' : 'Изображение не выбрано');
}

function renderNoteAttachments() {
  const selected = select<HTMLElement>('#note-selected-assets'); selected.replaceChildren();
  for (const id of editingAssetIds) {
    const asset = roomState?.assets?.find((entry) => entry.id === id); if (!asset) continue;
    const item = document.createElement('div'); item.className = 'note-attachment-thumb';
    const image = document.createElement('img'); image.src = `/api/assets/${encodeURIComponent(id)}`; image.alt = asset.originalName; image.title = asset.originalName;
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×'; remove.title = 'Убрать из заметки'; remove.addEventListener('click', () => { editingAssetIds = editingAssetIds.filter((entry) => entry !== id); renderNoteAttachments(); });
    item.append(image, remove); selected.append(item);
  }
}

function renderAssetPicker() {
  const grid = select<HTMLElement>('#asset-picker-grid'); grid.replaceChildren();
  const singleChoice = assetPickerMode === 'marker' || assetPickerMode === 'sheet-portrait' || assetPickerMode === 'ability';
  for (const asset of accessibleAssets()) {
    const label = document.createElement('label'); label.className = 'asset-picker-item';
    const input = document.createElement('input'); input.type = singleChoice ? 'radio' : 'checkbox'; input.name = 'asset-picker-selection'; input.value = asset.id;
    input.checked = assetPickerMode === 'marker' ? asset.id === selectedMarkerAssetId
      : assetPickerMode === 'sheet-portrait' ? asset.id === selectedSheetPortraitAssetId
        : assetPickerMode === 'ability' ? asset.id === selectedAbilityAssetId
          : editingAssetIds.includes(asset.id);
    const image = document.createElement('img'); image.src = `/api/assets/${encodeURIComponent(asset.id)}`; image.alt = ''; image.loading = 'lazy';
    const name = document.createElement('span'); name.textContent = asset.originalName; name.title = asset.originalName;
    label.append(input, image, name); grid.append(label);
  }
  if (!accessibleAssets().length) {
    const empty = document.createElement('p'); empty.className = 'panel-note'; empty.textContent = 'Нет доступных изображений. Загрузите новое.';
    grid.append(empty);
  }
}

function openAssetPicker(mode: AssetPickerMode) {
  assetPickerMode = mode;
  if (mode === 'sheet-portrait') {
    selectedSheetPortraitAssetId = roomState?.sheets.find((sheet) => sheet.id === openSheetId)?.portraitAssetId ?? undefined;
  } else if (mode === 'ability') {
    selectedAbilityAssetId = roomState?.sheets.find((sheet) => sheet.id === openSheetId)?.abilities.find((ability) => ability.id === editingAbilityId)?.assetId ?? undefined;
  }
  renderAssetPicker();
  if (!pendingNoteUploads) clearNoteUploadStatuses();
  setAssetPickerLibraryMode();
  if (!assetPickerDialog.open) assetPickerDialog.showModal();
}

interface NoteUploadRow {
  file: File;
  item: HTMLLIElement;
  progress: HTMLProgressElement;
  status: HTMLSpanElement;
}

function setUploadRow(row: NoteUploadRow, message: string, state?: 'success' | 'error') {
  row.status.textContent = message;
  row.item.classList.toggle('success', state === 'success');
  row.item.classList.toggle('error', state === 'error');
}

function uploadNoteAsset(file: File, onProgress: (percent: number) => void): Promise<{ asset: NonNullable<BoardSnapshot['assets']>[number]; deduplicated: boolean }> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', '/api/assets');
    request.withCredentials = true;
    request.timeout = 120_000;
    request.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) onProgress(Math.round(event.loaded / event.total * 100));
    });
    request.addEventListener('load', () => {
      let result: { asset?: NonNullable<BoardSnapshot['assets']>[number]; deduplicated?: boolean; error?: string };
      try { result = JSON.parse(request.responseText) as typeof result; }
      catch { reject(new Error('Сервер вернул некорректный ответ.')); return; }
      if (request.status < 200 || request.status >= 300 || !result.asset) {
        reject(new Error(result.error || `Ошибка загрузки (HTTP ${request.status}).`)); return;
      }
      resolve({ asset: result.asset, deduplicated: result.deduplicated === true });
    });
    request.addEventListener('error', () => reject(new Error('Не удалось связаться с сервером.')));
    request.addEventListener('timeout', () => reject(new Error('Истекло время ожидания загрузки.')));
    const data = new FormData(); data.append('image', file);
    request.send(data);
  });
}

async function uploadNoteImageFiles(files: File[]) {
  if (!files.length) return;
  if (!pendingNoteUploads) clearNoteUploadStatuses();
  const targetMode = assetPickerMode;
  const editorGeneration = noteEditorGeneration;
  const sheetEditorGeneration = sheetGeneration;
  const limit = roomState?.maxUploadBytes ?? 25 * 1024 * 1024;
  const rows: NoteUploadRow[] = files.map((file) => {
    const item = document.createElement('li'); item.className = 'note-upload-row';
    const name = document.createElement('span'); name.className = 'note-upload-name'; name.textContent = file.name; name.title = file.name;
    const progress = document.createElement('progress'); progress.max = 100; progress.value = 0; progress.setAttribute('aria-label', `Загрузка ${file.name}`);
    const status = document.createElement('span'); status.className = 'note-upload-result'; status.textContent = file.size > limit ? `Ошибка: превышен лимит ${formatSize(limit)}.` : 'В очереди';
    item.append(name, progress, status); noteImageUploadStatus.append(item);
    const row = { file, item, progress, status };
    if (file.size > limit) { progress.hidden = true; item.classList.add('error'); }
    return row;
  });
  pendingNoteUploads += rows.length;
  let cursor = 0;
  const worker = async () => {
    while (cursor < rows.length) {
      const row = rows[cursor++]!;
      if (row.file.size > limit) continue;
      setUploadRow(row, 'Загрузка · 0%');
      try {
        const result = await uploadNoteAsset(row.file, (percent) => {
          row.progress.value = percent; setUploadRow(row, `Загрузка · ${percent}%`);
        });
        row.progress.value = 100;
        if (roomState) {
          roomState.assets = [...(roomState.assets || []).filter((entry) => entry.id !== result.asset.id), result.asset];
          roomState.availableAssets = [...(roomState.availableAssets || []).filter((entry) => entry.id !== result.asset.id), result.asset];
        }
        const sameEditor = editorGeneration === noteEditorGeneration && noteDialog.open && noteDialogMode === 'edit';
        const sameSheetEditor = sheetEditorGeneration === sheetGeneration && !sheetPanel.hidden;
        const attached = sameEditor && targetMode === 'attachments' && !editingAssetIds.includes(result.asset.id);
        if (sameEditor && targetMode === 'marker') selectedMarkerAssetId = result.asset.id;
        else if (attached) editingAssetIds.push(result.asset.id);
        if (sameSheetEditor && targetMode === 'sheet-portrait') { selectedSheetPortraitAssetId = result.asset.id; renderSheetPanel(); }
        else if (sameSheetEditor && targetMode === 'ability') { selectedAbilityAssetId = result.asset.id; renderSheetPanel(); }
        const resultLabel = result.deduplicated ? 'Уже в библиотеке' : 'Загружено';
        const selectedForSheet = sameSheetEditor && (targetMode === 'sheet-portrait' || targetMode === 'ability');
        setUploadRow(row, `${resultLabel} · ${selectedForSheet ? 'выбрано для листа' : sameEditor && (targetMode === 'marker' || attached || targetMode === 'attachments' && editingAssetIds.includes(result.asset.id)) ? 'прикреплено к заметке' : 'сохранено в библиотеке'}`, 'success');
        renderAssets(); renderAssetPicker(); renderNoteAttachments(); updateMarkerEditorFields();
      } catch (error) {
        row.progress.hidden = true;
        setUploadRow(row, `Ошибка: ${error instanceof Error ? error.message : 'не удалось загрузить файл.'}`, 'error');
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, rows.length) }, worker));
  pendingNoteUploads = Math.max(0, pendingNoteUploads - rows.length);
}

function hasDraggedFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types || []).includes('Files');
}

function clearNoteUploadStatuses() {
  noteImageUploadStatus.replaceChildren();
  noteDropDepth = 0; noteImageDropZone.classList.remove('drag-over');
}

noteImageDropZone.addEventListener('dragenter', (event) => {
  if (!hasDraggedFiles(event)) return;
  event.preventDefault(); noteDropDepth += 1; noteImageDropZone.classList.add('drag-over');
});
noteImageDropZone.addEventListener('dragover', (event) => {
  if (!hasDraggedFiles(event)) return;
  event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  noteImageDropZone.classList.add('drag-over');
});
noteImageDropZone.addEventListener('dragleave', (event) => {
  if (event.relatedTarget instanceof Node && noteImageDropZone.contains(event.relatedTarget)) return;
  noteDropDepth = Math.max(0, noteDropDepth - 1);
  if (!noteDropDepth) noteImageDropZone.classList.remove('drag-over');
});
noteImageDropZone.addEventListener('drop', (event) => {
  if (!hasDraggedFiles(event)) return;
  event.preventDefault(); event.stopPropagation(); noteDropDepth = 0; noteImageDropZone.classList.remove('drag-over');
  void uploadNoteImageFiles(Array.from(event.dataTransfer?.files || []));
});
noteImageDropZone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select<HTMLInputElement>('#note-image-upload').click(); }
});

async function uploadNoteImageFilesFromInput(event: Event) {
  const input = event.currentTarget as HTMLInputElement;
  const files = Array.from(input.files || []);
  input.value = '';
  await uploadNoteImageFiles(files);
}

function setAssetPickerUploadMode() {
  select<HTMLElement>('#asset-picker-library').hidden = true;
  select<HTMLElement>('#asset-picker-upload').hidden = false;
  select<HTMLButtonElement>('#asset-picker-add').hidden = true;
  select<HTMLButtonElement>('#asset-picker-library-mode').classList.remove('active');
  select<HTMLButtonElement>('#asset-picker-upload-mode').classList.add('active');
}

function setAssetPickerLibraryMode() {
  select<HTMLElement>('#asset-picker-library').hidden = false;
  select<HTMLElement>('#asset-picker-upload').hidden = true;
  select<HTMLButtonElement>('#asset-picker-add').hidden = false;
  select<HTMLButtonElement>('#asset-picker-library-mode').classList.add('active');
  select<HTMLButtonElement>('#asset-picker-upload-mode').classList.remove('active');
}

async function saveNote() {
  if (identity?.role !== 'gm') return;
  if (pendingNoteUploads > 0) { setNoteMessage('Дождитесь завершения загрузки изображений.'); return; }
  const selectedParticipantIds = Array.from(select<HTMLElement>('#note-participant-list').querySelectorAll<HTMLInputElement>('input:checked'), (input) => input.value);
  const markerType = select<HTMLSelectElement>('#note-marker-type').value;
  if (markerType === 'image' && !selectedMarkerAssetId) { setNoteMessage('Выберите изображение для графической метки.'); return; }
  const id = editingNoteId;
  try {
    const response = await fetch(id ? `/api/notes/${encodeURIComponent(id)}` : '/api/notes', { method: id ? 'PUT' : 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: select<HTMLInputElement>('#note-title').value, body: select<HTMLTextAreaElement>('#note-body').value, access: select<HTMLSelectElement>('#note-access').value, selectedParticipantIds, assetIds: editingAssetIds, markerType, markerText: select<HTMLInputElement>('#note-marker-text').value, ...(markerType === 'image' && selectedMarkerAssetId ? { markerAssetId: selectedMarkerAssetId } : {}) }) });
    const result = await response.json() as { note?: NoteRecord; error?: string };
    if (!response.ok) throw new Error(result.error || 'Не удалось сохранить заметку.');
    closeNoteDialog(); await refreshNotesList();
    if (!id && result.note) startNotePlacement(result.note.id);
  } catch (error) { setNoteMessage(error instanceof Error ? error.message : 'Ошибка сервера.'); }
}

function startNotePlacement(id: string) {
  if (identity?.role !== 'gm') return;
  if (!activeLayerId || !roomState?.layers.some((layer) => layer.id === activeLayerId && !layer.locked)) { showCanvasMessage('Выберите открытый слой для метки.', true); return; }
  notePlacementId = id; notePlacementHint.hidden = false; canvasContainer.style.cursor = 'crosshair';
}

function refreshNotesListIfVisible(): void {
  if (identity?.role === 'gm' && !notesPanel.hidden) void refreshNotesList();
}

async function refreshNotesList() {
  try {
    const response = await fetch('/api/notes', { cache: 'no-store' }); if (!response.ok) return;
    const notes = (await response.json() as { notes: NoteListItem[] }).notes; notesList.replaceChildren();
    for (const note of notes) {
      const item = document.createElement('li'); item.className = 'note-entry';
      const title = document.createElement('span'); title.className = 'note-entry-title'; title.textContent = `${note.title} · ${note.access === 'gm-only' ? 'только ведущий' : note.access === 'selected-players' ? 'выбранные игроки' : 'все игроки'}`; title.title = note.title;
      const actions = document.createElement('div'); actions.className = 'note-entry-actions';
      const open = document.createElement('button'); open.type = 'button'; open.textContent = 'Просмотр'; open.addEventListener('click', () => void openNote(note.id));
      const edit = document.createElement('button'); edit.type = 'button'; edit.textContent = 'Править'; edit.addEventListener('click', async () => { try { const res = await fetch(`/api/notes/${encodeURIComponent(note.id)}`, { cache: 'no-store' }); if (res.ok) openNoteEditor((await res.json() as { note: NoteRecord }).note); } catch { showCanvasMessage('Не удалось загрузить заметку.', true); } });
      const place = document.createElement('button'); place.type = 'button'; place.textContent = note.markerId ? 'Переместить метку' : 'Поставить метку'; place.addEventListener('click', () => startNotePlacement(note.id));
      const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Удалить'; remove.addEventListener('click', async () => { if (!window.confirm(`Удалить заметку «${note.title}»?`)) return; const res = await fetch(`/api/notes/${encodeURIComponent(note.id)}`, { method: 'DELETE' }); if (res.ok) void refreshNotesList(); });
      actions.append(open, edit, place, remove); item.append(title, actions); notesList.append(item);
    }
  } catch { /* Keep the current list during a brief network failure. */ }
}

function renderLayers() {
  layersList.replaceChildren();
  if (!roomState || identity?.role !== 'gm') return;
  const topFirst = [...roomState.layers].sort((a, b) => b.orderIndex - a.orderIndex);
  for (const layer of topFirst) {
    const item = document.createElement('li');
    item.className = `layer-item${layer.id === activeLayerId ? ' active' : ''}`;
    item.draggable = true;
    item.dataset.layerId = layer.id;
    item.addEventListener('dragstart', (event) => { item.classList.add('dragging'); event.dataTransfer?.setData('text/plain', layer.id); });
    item.addEventListener('dragend', () => item.classList.remove('dragging'));
    item.addEventListener('dragover', (event) => event.preventDefault());
    item.addEventListener('drop', (event) => {
      event.preventDefault();
      const draggedId = event.dataTransfer?.getData('text/plain');
      if (!draggedId || draggedId === layer.id) return;
      const reordered = [...topFirst];
      const from = reordered.findIndex((entry) => entry.id === draggedId);
      const to = reordered.findIndex((entry) => entry.id === layer.id);
      if (from < 0 || to < 0) return;
      const [moving] = reordered.splice(from, 1);
      reordered.splice(to, 0, moving!);
      void runCommand('layer:reorder', { ids: reordered.reverse().map((entry) => entry.id) });
    });

    const main = document.createElement('div'); main.className = 'layer-main';
    const choose = document.createElement('button'); choose.type = 'button'; choose.className = 'layer-select'; choose.textContent = layer.name;
    choose.title = layer.name;
    choose.addEventListener('click', () => { activeLayerId = layer.id; localStorage.setItem(`tabletop-active-layer:${location.host}`, layer.id); renderLayers(); });
    const visible = document.createElement('button'); visible.type = 'button'; visible.className = 'layer-action'; visible.textContent = layer.visible ? '◉' : '○'; visible.title = layer.visible ? 'Скрыть слой' : 'Показать слой';
    visible.addEventListener('click', () => void runCommand('layer:update', { id: layer.id, changes: { visible: !layer.visible } }));
    const locked = document.createElement('button'); locked.type = 'button'; locked.className = `layer-action layer-lock${layer.locked ? ' is-locked' : ''}`; locked.textContent = layer.locked ? '🔒' : '🔓'; locked.title = layer.locked ? 'Разблокировать слой' : 'Заблокировать слой'; locked.setAttribute('aria-label', locked.title); locked.setAttribute('aria-pressed', String(layer.locked));
    locked.addEventListener('click', () => void runCommand('layer:update', { id: layer.id, changes: { locked: !layer.locked } }));
    main.append(choose, visible, locked);
    const meta = document.createElement('div'); meta.className = 'layer-meta';
    const access = document.createElement('select'); access.setAttribute('aria-label', `Доступ к слою ${layer.name}`);
    for (const [value, label] of [['all-players', 'Виден игрокам'], ['gm-only', 'Только ведущий']] as const) {
      const option = document.createElement('option'); option.value = value; option.textContent = label; access.append(option);
    }
    access.value = layer.audience;
    access.addEventListener('change', () => void runCommand('layer:update', { id: layer.id, changes: { audience: access.value } }));
    const rename = document.createElement('button'); rename.type = 'button'; rename.className = 'layer-action'; rename.textContent = '✎'; rename.title = 'Переименовать';
    rename.addEventListener('click', () => {
      const name = window.prompt('Название слоя', layer.name);
      if (name?.trim()) void runCommand('layer:update', { id: layer.id, changes: { name: name.trim() } });
    });
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'layer-action'; remove.textContent = '×'; remove.title = 'Удалить слой';
    remove.addEventListener('click', () => {
      const objectCount = (roomState?.objects.filter((object) => object.layerId === layer.id).length || 0) + (roomState?.stickers.filter((object) => object.layerId === layer.id).length || 0) + (roomState?.noteMarkers.filter((object) => object.layerId === layer.id).length || 0);
      const deleteObjects = objectCount > 0 && window.confirm(`В слое ${objectCount} объектов. Удалить слой вместе с объектами?`);
      if (objectCount > 0 && !deleteObjects) return;
      void runCommand('layer:delete', { id: layer.id, deleteObjects });
    });
    meta.append(access, rename, remove);
    const state = document.createElement('div'); state.className = 'layer-state';
    const layerCount = roomState.objects.filter((object) => object.layerId === layer.id).length + roomState.stickers.filter((object) => object.layerId === layer.id).length + roomState.noteMarkers.filter((object) => object.layerId === layer.id).length;
    state.textContent = `${layerCount} объектов`;
    item.append(main, meta, state);
    layersList.append(item);
  }
}

function renderAssets() {
  assetsList.replaceChildren();
  const assets = roomState?.assets;
  if (!assets || identity?.role !== 'gm') return;
  const limit = roomState?.maxUploadBytes;
  if (limit) select<HTMLElement>('#upload-limit').textContent = `${Math.round(limit / 1024 / 1024)}`;
  for (const asset of assets) {
    const item = document.createElement('li'); item.className = 'asset-item';
    const image = document.createElement('img'); image.className = 'asset-thumb'; image.src = `/api/assets/${encodeURIComponent(asset.id)}`; image.alt = '';
    const text = document.createElement('div'); text.className = 'asset-copy';
    const name = document.createElement('div'); name.className = 'asset-name'; name.textContent = asset.originalName; name.title = asset.originalName;
    const size = document.createElement('div'); size.className = 'asset-size'; size.textContent = `${asset.width} × ${asset.height} · ${formatSize(asset.size)}`;
    text.append(name, size);
    const actions = document.createElement('div');
    actions.className = 'asset-actions';
    const add = document.createElement('button'); add.type = 'button'; add.className = 'asset-add'; add.textContent = 'Добавить';
    add.disabled = !activeLayerId || !roomState?.layers.some((layer) => layer.id === activeLayerId && !layer.locked);
    add.addEventListener('click', () => {
      const world = stage ? { x: (stage.width() / 2 - stage.x()) / stage.scaleX(), y: (stage.height() / 2 - stage.y()) / stage.scaleY() } : { x: 0, y: 0 };
      const scale = Math.min(1, 320 / asset.width, 240 / asset.height);
      const width = asset.width * scale; const height = asset.height * scale;
      void runCommand('object:create', { assetId: asset.id, layerId: activeLayerId, x: Math.round(world.x - width / 2), y: Math.round(world.y - height / 2) });
      libraryPanel.hidden = true;
    });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'asset-delete danger-text';
    remove.textContent = 'Удалить';
    remove.title = 'Удалить изображение из библиотеки';
    remove.addEventListener('click', () => void openAssetDeleteDialog(asset));
    actions.append(add, remove);
    item.append(image, text, actions); assetsList.append(item);
  }
}

const ASSET_USAGE_LABELS: Record<BoardAssetUsage['kind'], string> = {
  'board-object': 'Объекты игровой доски',
  'note-attachment': 'Изображения заметок',
  'note-marker': 'Метки заметок',
  'sheet-portrait': 'Портреты персонажей',
  'sheet-ability': 'Изображения способностей',
};

function renderAssetUsage(usage: BoardAssetUsage[]): void {
  const wrap = select<HTMLElement>('#asset-delete-usage-wrap');
  const list = select<HTMLUListElement>('#asset-delete-usage');
  list.replaceChildren();
  wrap.hidden = usage.length === 0;
  for (const entry of usage) {
    const item = document.createElement('li');
    item.textContent = `${ASSET_USAGE_LABELS[entry.kind]} — ${entry.count}`;
    list.append(item);
  }
  select<HTMLButtonElement>('#asset-delete-confirm').disabled = usage.length > 0;
}

async function openAssetDeleteDialog(asset: BoardAsset): Promise<void> {
  pendingAssetDeleteId = asset.id;
  select<HTMLImageElement>('#asset-delete-thumb').src = `/api/assets/${encodeURIComponent(asset.id)}`;
  select<HTMLImageElement>('#asset-delete-thumb').alt = asset.originalName;
  select<HTMLElement>('#asset-delete-name').textContent = asset.originalName;
  select<HTMLElement>('#asset-delete-message').textContent = '';
  renderAssetUsage([]);
  if (!assetDeleteDialog.open) assetDeleteDialog.showModal();
  try {
    const response = await fetch(`/api/assets/${encodeURIComponent(asset.id)}/usage`, { cache: 'no-store' });
    const result = await response.json() as { usage?: BoardAssetUsage[]; error?: string };
    if (!response.ok) throw new Error(result.error || 'Не удалось проверить использование изображения.');
    renderAssetUsage(result.usage || []);
  } catch (error) {
    select<HTMLElement>('#asset-delete-message').textContent = error instanceof Error ? error.message : 'Не удалось проверить использование изображения.';
    select<HTMLButtonElement>('#asset-delete-confirm').disabled = true;
  }
}

async function confirmAssetDelete(): Promise<void> {
  if (!pendingAssetDeleteId) return;
  const id = pendingAssetDeleteId;
  const button = select<HTMLButtonElement>('#asset-delete-confirm');
  button.disabled = true;
  try {
    const response = await fetch(`/api/assets/${encodeURIComponent(id)}`, { method: 'DELETE' });
    const result = response.status === 204 ? undefined : await response.json() as { usage?: BoardAssetUsage[]; error?: string };
    if (response.status === 409 && result?.usage?.length) {
      renderAssetUsage(result.usage);
      select<HTMLElement>('#asset-delete-message').textContent = result.error || 'Изображение используется.';
      return;
    }
    if (!response.ok) throw new Error(result?.error || `Не удалось удалить изображение (HTTP ${response.status}).`);
    assetDeleteDialog.close();
    await refreshBoard();
    uploadMessage.textContent = 'Изображение удалено из библиотеки.';
  } catch (error) {
    select<HTMLElement>('#asset-delete-message').textContent = error instanceof Error ? error.message : 'Не удалось удалить изображение.';
    button.disabled = false;
  }
}

function formatSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function closeWorkspace(message: string) {
  resizeObserver?.disconnect();
  stage?.destroy(); stage = undefined; boardLayer = undefined; interactionLayer = undefined; transformer = undefined; cropTransformer = undefined; markerTransformer = undefined;
  markerResizeMode = false; markerResizeOriginal = undefined;
  selectedObjectId = undefined; roomState = undefined; imageCache.clear(); renderedObjects.clear();
  closeSheetRollPanel();
  sheetPanel.hidden = true;
  openSheetId = undefined; editingAbilityId = undefined; pendingRollContext = undefined; openOwnSheetAfterCreate = false;
  uiPreferencesParticipantId = undefined;
  sheetsPanel.hidden = true;
  workspace.hidden = true; loginShell.hidden = false;
  form.reset();
  gmField.hidden = true;
  gmPassword.required = false;
  loginMessage.textContent = message;
}

roleSelect.addEventListener('change', () => {
  gmField.hidden = roleSelect.value !== 'gm';
  gmPassword.required = roleSelect.value === 'gm';
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  loginMessage.textContent = '';
  const fields = new FormData(form);
  try {
    const response = await fetch('/api/session', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: fields.get('name'), roomCode: fields.get('roomCode'), role: fields.get('role'), gmPassword: fields.get('gmPassword') }),
    });
    const result = await response.json() as { identity?: AppIdentity; error?: string };
    if (!response.ok || !result.identity) throw new Error(result.error || 'Не удалось подключиться.');
    leaving = false;
    login(result.identity.role, result.identity.name);
  } catch (error) { loginMessage.textContent = error instanceof Error ? error.message : 'Не удалось подключиться.'; }
});

select<HTMLButtonElement>('#leave').addEventListener('click', async () => {
  leaving = true;
  window.clearTimeout(reconnectTimer);
  socket?.close();
  await fetch('/api/session', { method: 'DELETE' });
  closeWorkspace('Вы вышли из комнаты.');
});

select<HTMLButtonElement>('#dice-tools-toggle').addEventListener('click', () => setFloatingPanelOpen(diceToolsPanel, 'dice-tools', diceToolsPanel.hidden));
select<HTMLButtonElement>('#dice-history-toggle').addEventListener('click', () => setFloatingPanelOpen(diceHistoryPanel, 'dice-history', diceHistoryPanel.hidden));
select<HTMLButtonElement>('#dice-tools-close').addEventListener('click', () => setFloatingPanelOpen(diceToolsPanel, 'dice-tools', false));
select<HTMLButtonElement>('#dice-history-close').addEventListener('click', () => setFloatingPanelOpen(diceHistoryPanel, 'dice-history', false));
select<HTMLButtonElement>('#dice-tools-reset').addEventListener('click', () => resetFloatingPanelPosition(diceToolsPanel, 'dice-tools', 'left'));
select<HTMLButtonElement>('#dice-history-reset').addEventListener('click', () => resetFloatingPanelPosition(diceHistoryPanel, 'dice-history', 'right'));
select<HTMLButtonElement>('#sheets-toggle').addEventListener('click', () => {
  sheetsPanel.hidden = !sheetsPanel.hidden;
  select<HTMLButtonElement>('#sheets-toggle').setAttribute('aria-expanded', String(!sheetsPanel.hidden));
  if (!sheetsPanel.hidden) renderSheetsCatalog();
});
select<HTMLButtonElement>('#sheets-close').addEventListener('click', () => {
  sheetsPanel.hidden = true;
  select<HTMLButtonElement>('#sheets-toggle').setAttribute('aria-expanded', 'false');
});
select<HTMLButtonElement>('#sheet-close').addEventListener('click', closeSheetPanel);
select<HTMLButtonElement>('#sheet-roll-close').addEventListener('click', closeSheetRollPanel);
select<HTMLButtonElement>('#sheet-roll-reset').addEventListener('click', resetSheetRollPanelPosition);
sheetCollapse.addEventListener('click', () => setSheetCollapsed(!sheetPanel.classList.contains('is-collapsed')));
sheetEditToggle.addEventListener('click', () => {
  sheetDialogMode = toggleSheetMode(sheetDialogMode);
  sheetGeneration += 1;
  renderSheetPanel();
  clampFloatingPanel(sheetPanel);
  saveSheetPanelPreference();
});
select<HTMLInputElement>('#pbta-bonus').addEventListener('input', () => {
  if (pendingRollContext && Number(select<HTMLInputElement>('#pbta-bonus').value) !== pendingRollContext.characteristicBonus) pendingRollContext = undefined;
});
pbtaActor.addEventListener('change', () => {
  if (pendingRollContext && identity?.role === 'gm' && pbtaActor.value !== pendingRollContext.characterOwnerId) pendingRollContext = undefined;
});
makeFloatingPanelDraggable(diceToolsPanel, 'dice-tools');
makeFloatingPanelDraggable(diceHistoryPanel, 'dice-history');
makeFloatingPanelDraggable(sheetPanel, 'sheet');
makeFloatingPanelDraggable(sheetRollPanel, 'sheet-roll');
window.addEventListener('resize', () => {
  for (const [panel, key] of [[diceToolsPanel, 'dice-tools'], [diceHistoryPanel, 'dice-history']] as const) {
    clampFloatingPanel(panel);
    if (identity?.participantId) saveFloatingPanel(panel, identity.participantId, key);
  }
  if (!sheetPanel.hidden) {
    clampFloatingPanel(sheetPanel);
    saveSheetPanelPreference();
  }
  if (!sheetRollPanel.hidden) {
    clampFloatingPanel(sheetRollPanel);
    saveSheetRollPanelPreference();
  }
});
select<HTMLButtonElement>('#layers-collapse').addEventListener('click', () => setLayersCollapsed(true));
layersExpandButton.addEventListener('click', () => setLayersCollapsed(false));
systemSelect.addEventListener('change', () => { systemSave.hidden = systemSelect.value === (roomState?.activeSystem?.id ?? 'none'); });
systemSave.addEventListener('click', () => {
  if (identity?.role !== 'gm') return;
  const systemId = systemSelect.value;
  const message = 'При смене основной системы сохранённые результаты бросков останутся в истории. Данные персонажей не преобразуются автоматически. Продолжить?';
  if (!window.confirm(message)) { systemSelect.value = roomState?.activeSystem?.id ?? 'none'; systemSave.hidden = true; return; }
  void runCommand('room:system:set', { systemId: systemId === 'none' ? null : systemId, version: systemId === 'none' ? null : '1.0.0' });
});
select<HTMLButtonElement>('#pbta-roll').addEventListener('click', () => {
  const characteristicBonus = Number(select<HTMLInputElement>('#pbta-bonus').value);
  const situationalModifier = Number(select<HTMLSelectElement>('#pbta-modifier').value);
  const disadvantage = select<HTMLInputElement>('#pbta-disadvantage').checked;
  const actorId = identity?.role === 'gm' ? pbtaActor.value : undefined;
  let context = pendingRollContext;
  if (context && (characteristicBonus !== context.characteristicBonus
    || (identity?.role === 'gm' ? actorId !== context.characterOwnerId : context.characterOwnerId !== identity?.participantId))) context = undefined;
  void runCommand('dice:pbta', {
    characteristicBonus, situationalModifier, disadvantage,
    ...(actorId ? { actorId } : {}),
    ...(context ? { characteristicName: context.characteristicName, characterId: context.characterId, characterOwnerId: context.characterOwnerId } : {}),
  });
});
select<HTMLButtonElement>('#free-roll').addEventListener('click', () => {
  const count = Number(select<HTMLInputElement>('#free-count').value);
  const sides = Number(select<HTMLSelectElement>('#free-sides').value);
  void runCommand('dice:free', { count, sides });
});

boardBackgroundSelect.addEventListener('change', () => {
  if (identity?.role !== 'gm') { applyBoardBackground(roomState?.background); return; }
  const background: BoardBackground = boardBackgroundSelect.value === 'black' ? 'black' : 'gray';
  applyBoardBackground(background);
  void runCommand('room:background:set', { background });
});
select<HTMLButtonElement>('#library-toggle').addEventListener('click', () => { libraryPanel.hidden = !libraryPanel.hidden; });
select<HTMLButtonElement>('#library-close').addEventListener('click', () => { libraryPanel.hidden = true; });
select<HTMLButtonElement>('#notes-toggle').addEventListener('click', () => { notesPanel.hidden = !notesPanel.hidden; if (!notesPanel.hidden) void refreshNotesList(); });
select<HTMLButtonElement>('#notes-close').addEventListener('click', () => { notesPanel.hidden = true; });
select<HTMLButtonElement>('#note-create').addEventListener('click', () => openNoteEditor());
select<HTMLButtonElement>('#note-close').addEventListener('click', closeNoteDialog);
noteDialog.addEventListener('close', () => { noteRequestSequence += 1; noteEditorGeneration += 1; openNoteId = undefined; editingNoteId = undefined; clearNoteContent(); });
select<HTMLButtonElement>('#note-save').addEventListener('click', () => void saveNote());
select<HTMLButtonElement>('#note-edit').addEventListener('click', async () => { if (!openNoteId) return; try { const response = await fetch(`/api/notes/${encodeURIComponent(openNoteId)}`, { cache: 'no-store' }); if (response.ok) openNoteEditor((await response.json() as { note: NoteRecord }).note); } catch { setNoteMessage('Не удалось загрузить заметку.'); } });
select<HTMLButtonElement>('#note-place-marker').addEventListener('click', () => { if (openNoteId) { const id = openNoteId; closeNoteDialog(); startNotePlacement(id); } });
select<HTMLSelectElement>('#note-access').addEventListener('change', (event) => { select<HTMLElement>('#note-participants').hidden = (event.currentTarget as HTMLSelectElement).value !== 'selected-players'; });
select<HTMLSelectElement>('#note-marker-type').addEventListener('change', updateMarkerEditorFields);
select<HTMLButtonElement>('#note-add-image').addEventListener('click', () => openAssetPicker('attachments'));
select<HTMLButtonElement>('#note-marker-image-pick').addEventListener('click', () => openAssetPicker('marker'));
select<HTMLInputElement>('#note-image-upload').addEventListener('change', (event) => { void uploadNoteImageFilesFromInput(event); });
select<HTMLButtonElement>('#asset-picker-close').addEventListener('click', () => assetPickerDialog.close());
select<HTMLButtonElement>('#asset-picker-cancel').addEventListener('click', () => assetPickerDialog.close());
select<HTMLButtonElement>('#asset-delete-close').addEventListener('click', () => assetDeleteDialog.close());
select<HTMLButtonElement>('#asset-delete-cancel').addEventListener('click', () => assetDeleteDialog.close());
select<HTMLButtonElement>('#asset-delete-confirm').addEventListener('click', () => void confirmAssetDelete());
assetDeleteDialog.addEventListener('close', () => { pendingAssetDeleteId = undefined; });
select<HTMLButtonElement>('#asset-picker-library-mode').addEventListener('click', setAssetPickerLibraryMode);
select<HTMLButtonElement>('#asset-picker-upload-mode').addEventListener('click', setAssetPickerUploadMode);
select<HTMLButtonElement>('#asset-picker-add').addEventListener('click', () => {
  const values = Array.from(select<HTMLElement>('#asset-picker-grid').querySelectorAll<HTMLInputElement>('input:checked'), (input) => input.value);
  if (assetPickerMode === 'marker') { if (values[0]) selectedMarkerAssetId = values[0]; updateMarkerEditorFields(); }
  else if (assetPickerMode === 'sheet-portrait') {
    if (values[0] && openSheetId) void runCommand('sheet:update', { id: openSheetId, changes: { portraitAssetId: values[0] } });
  } else if (assetPickerMode === 'ability') {
    if (editingAbilityId && openSheetId) void runCommand('sheet:ability:update', { sheetId: openSheetId, id: editingAbilityId, changes: { assetId: values[0] ?? null } });
  } else editingAssetIds = [...new Set([...editingAssetIds, ...values])];
  renderNoteAttachments(); assetPickerDialog.close();
});
select<HTMLButtonElement>('#marker-edit').addEventListener('click', () => { const marker = roomState?.noteMarkers.find((entry) => entry.id === selectedMarkerId); if (marker) void openNote(marker.noteId); });
select<HTMLButtonElement>('#marker-resize').addEventListener('click', () => setMarkerResizeMode(!markerResizeMode));
select<HTMLButtonElement>('#marker-delete').addEventListener('click', () => { if (selectedMarkerId) void runCommand('note-marker:delete', { id: selectedMarkerId }).then(refreshNotesListIfVisible); });
select<HTMLButtonElement>('#sticker-create').addEventListener('click', () => { select<HTMLTextAreaElement>('#sticker-new-text').value = ''; stickerCreateDialog.showModal(); });
select<HTMLButtonElement>('#sticker-create-cancel').addEventListener('click', () => stickerCreateDialog.close());
select<HTMLButtonElement>('#sticker-create-confirm').addEventListener('click', () => {
  const text = select<HTMLTextAreaElement>('#sticker-new-text').value.trim(); if (!text || !roomState) return;
  const layer = identity?.role === 'gm' ? roomState.layers.find((entry) => entry.id === activeLayerId && !entry.locked) : undefined;
  if (identity?.role === 'gm' && !layer) { showCanvasMessage('Выберите незаблокированный слой для стикера.', true); return; }
  const x = stage ? clampWorld((stage.width() / 2 - stage.x()) / stage.scaleX()) : 0; const y = stage ? clampWorld((stage.height() / 2 - stage.y()) / stage.scaleY()) : 0;
  void runCommand('sticker:create', { ...(layer ? { layerId: layer.id } : {}), text, x, y, fontSize: Number(select<HTMLSelectElement>('#sticker-new-size').value), textColor: select<HTMLSelectElement>('#sticker-new-color').value });
  stickerCreateDialog.close();
});
select<HTMLButtonElement>('#sticker-edit').addEventListener('click', () => { const sticker = roomState?.stickers.find((entry) => entry.id === selectedStickerId); if (!sticker) return; const text = window.prompt('Текст стикера', sticker.text); if (text?.trim()) void runCommand('sticker:update', { id: sticker.id, changes: { text: text.trim() } }); });
select<HTMLSelectElement>('#sticker-bg').addEventListener('change', (event) => selectedStickerId && void runCommand('sticker:update', { id: selectedStickerId, changes: { bgColor: (event.currentTarget as HTMLSelectElement).value } }));
select<HTMLSelectElement>('#sticker-text-color').addEventListener('change', (event) => selectedStickerId && void runCommand('sticker:update', { id: selectedStickerId, changes: { textColor: (event.currentTarget as HTMLSelectElement).value } }));
select<HTMLSelectElement>('#sticker-font-size').addEventListener('change', (event) => selectedStickerId && void runCommand('sticker:update', { id: selectedStickerId, changes: { fontSize: Number((event.currentTarget as HTMLSelectElement).value) } }));
select<HTMLButtonElement>('#sticker-duplicate').addEventListener('click', () => selectedStickerId && void runCommand('sticker:duplicate', { id: selectedStickerId }));
select<HTMLButtonElement>('#sticker-delete').addEventListener('click', () => selectedStickerId && void runCommand('sticker:delete', { id: selectedStickerId }));
select<HTMLButtonElement>('#layer-create').addEventListener('click', () => {
  const name = window.prompt('Название слоя');
  if (name?.trim()) void runCommand('layer:create', { name: name.trim(), audience: 'all-players' });
});
select<HTMLButtonElement>('#duplicate-object').addEventListener('click', () => selectedObjectId && void runCommand('object:duplicate', { id: selectedObjectId }));
select<HTMLButtonElement>('#delete-object').addEventListener('click', () => selectedObjectId && void runCommand('object:delete', { id: selectedObjectId }));
select<HTMLButtonElement>('#object-front').addEventListener('click', () => selectedObjectId && void runCommand('object:order', { id: selectedObjectId, direction: 'front' }));
select<HTMLButtonElement>('#object-back').addEventListener('click', () => selectedObjectId && void runCommand('object:order', { id: selectedObjectId, direction: 'back' }));
select<HTMLButtonElement>('#flip-x').addEventListener('click', () => {
  const item = roomState?.objects.find((object) => object.id === selectedObjectId);
  if (item) void runCommand('object:update', { id: item.id, changes: { flipX: !item.flipX } });
});
select<HTMLButtonElement>('#flip-y').addEventListener('click', () => {
  const item = roomState?.objects.find((object) => object.id === selectedObjectId);
  if (item) void runCommand('object:update', { id: item.id, changes: { flipY: !item.flipY } });
});
select<HTMLButtonElement>('#crop-toggle').addEventListener('click', () => {
  const item = roomState?.objects.find((object) => object.id === selectedObjectId);
  const layer = item && roomState?.layers.find((entry) => entry.id === item.layerId);
  if (identity?.role !== 'gm' || !item || !layer || layer.locked) return;
  cropMode = !cropMode;
  drawObjects();
});
select<HTMLButtonElement>('#crop-cancel').addEventListener('click', () => {
  cropMode = false; cropTransformer?.nodes([]); drawObjects();
});
select<HTMLButtonElement>('#crop-confirm').addEventListener('click', confirmCrop);
select<HTMLButtonElement>('#crop-reset').addEventListener('click', () => selectedObjectId && void runCommand('object:update', { id: selectedObjectId, changes: { crop: null } }));
stretchControl.addEventListener('change', () => {
  const item = roomState?.objects.find((object) => object.id === selectedObjectId);
  const layer = item && roomState?.layers.find((entry) => entry.id === item.layerId);
  if (!item || identity?.role !== 'gm' || layer?.locked) return;
  item.freeStretch = stretchControl.checked;
  const changes: Record<string, unknown> = { freeStretch: item.freeStretch };
  if (!item.freeStretch) {
    const asset = roomState?.assets?.find((entry) => entry.id === item.assetId);
    if (asset) { item.height = Math.max(1, Math.round(item.width / (asset.width / asset.height))); changes.height = item.height; }
  }
  drawObjects();
  void runCommand('object:update', { id: item.id, changes });
});
allowPlayerMoveControl.addEventListener('change', () => selectedObjectId && void runCommand('object:update', { id: selectedObjectId, changes: { allowPlayerMove: allowPlayerMoveControl.checked } }));
selectedLayer.addEventListener('change', () => selectedObjectId && void runCommand('object:update', { id: selectedObjectId, changes: { layerId: selectedLayer.value } }));

async function uploadFiles(files: File[]) {
  uploadInput.value = '';
  if (!files.length) return;
  const limit = roomState?.maxUploadBytes ?? 25 * 1024 * 1024;
  const statuses = files.map((file) => ({ file, result: file.size > limit ? `Ошибка: файл больше лимита ${formatSize(limit)}` : 'Загрузка…' }));
  const renderStatus = () => { uploadMessage.textContent = statuses.map(({ file, result }) => `${file.name}: ${result}`).join('\n'); };
  renderStatus();
  let cursor = 0;
  const worker = async () => {
    while (cursor < statuses.length) {
      const index = cursor++;
      const current = statuses[index]!;
      if (current.file.size > limit) continue;
      const body = new FormData(); body.append('image', current.file);
      try {
        const response = await fetch('/api/assets', { method: 'POST', body });
        const result = await response.json() as { deduplicated?: boolean; error?: string };
        if (!response.ok) throw new Error(result.error || 'Не удалось загрузить файл.');
        current.result = result.deduplicated ? 'Уже есть в библиотеке (дубликат).' : 'Загружено.';
      } catch (error) { current.result = `Ошибка: ${error instanceof Error ? error.message : 'не удалось загрузить.'}`; }
      renderStatus();
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, statuses.length) }, worker));
}

uploadInput.addEventListener('change', () => { void uploadFiles(Array.from(uploadInput.files || [])); });
uploadDropZone.addEventListener('dragenter', (event) => {
  if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return;
  event.preventDefault(); uploadDropZone.classList.add('drag-over');
});
uploadDropZone.addEventListener('dragover', (event) => {
  if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return;
  event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  uploadDropZone.classList.add('drag-over');
});
uploadDropZone.addEventListener('dragleave', (event) => {
  if (event.relatedTarget instanceof Node && uploadDropZone.contains(event.relatedTarget)) return;
  uploadDropZone.classList.remove('drag-over');
});
uploadDropZone.addEventListener('drop', (event) => {
  event.preventDefault(); event.stopPropagation(); uploadDropZone.classList.remove('drag-over');
  void uploadFiles(Array.from(event.dataTransfer?.files || []));
});
uploadDropZone.addEventListener('click', () => uploadInput.click());
uploadDropZone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); uploadInput.click(); }
});
window.addEventListener('dragover', (event) => {
  if (Array.from(event.dataTransfer?.types || []).includes('Files')) event.preventDefault();
});
window.addEventListener('drop', (event) => {
  if (Array.from(event.dataTransfer?.types || []).includes('Files')) event.preventDefault();
  noteDropDepth = 0; noteImageDropZone.classList.remove('drag-over');
});

async function restoreSession() {
  try {
    const response = await fetch('/api/session');
    if (!response.ok) return;
    const result = await response.json() as { identity: AppIdentity };
    leaving = false;
    login(result.identity.role, result.identity.name);
  } catch { loginMessage.textContent = 'Нет соединения с сервером.'; }
}

void restoreSession();
