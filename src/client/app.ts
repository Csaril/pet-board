import Konva from 'konva';
import type { BoardImage, BoardLayer, BoardSnapshot, BoardStateMessage, BoardSticker, CropRect, NoteListItem, NoteRecord, RoomParticipant } from '../shared/board.js';
import { cameraForBounds, isValidCamera, screenToWorld, zoomKeepingScreenPoint } from '../shared/camera.js';
import { clampRect, cropToDisplayRect, displayRectToCrop, lockTransformScales, transformedSize, type Rect } from '../shared/image-geometry.js';

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
const stickerCreateDialog = select<HTMLDialogElement>('#sticker-create-dialog');
const notePlacementHint = select<HTMLElement>('#note-place-hint');
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
let editingAssetIds: string[] = [];
let selectedMarkerAssetId: string | undefined;
let assetPickerMode: 'attachments' | 'marker' = 'attachments';
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

function login(role: AppIdentity['role'], name: string) {
  identity = { participantId: '', role, name };
  loginShell.hidden = true;
  workspace.hidden = false;
  for (const element of document.querySelectorAll<HTMLElement>('.gm-only')) element.hidden = role !== 'gm';
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
    for (const element of document.querySelectorAll<HTMLElement>('.gm-only')) element.hidden = identity.role !== 'gm';
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
  interactionLayer.add(transformer);
  interactionLayer.add(cropTransformer);
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
      if (existingMarker) void runCommand('note-marker:update', { id: existingMarker.id, changes: { layerId: layer.id, x: Math.round(world.x), y: Math.round(world.y) } });
      else void runCommand('note-marker:create', { noteId, layerId: layer.id, x: Math.round(world.x), y: Math.round(world.y) });
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
  for (const marker of roomState.noteMarkers.filter((item) => visibleIds.has(item.layerId))) boundsRects.push({ x: marker.x, y: marker.y, width: marker.type === 'image' ? 84 : Math.min(200, Math.max(64, marker.text.length * 8 + 18)), height: marker.type === 'image' ? 60 : 34 });
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
      const assetWidth = marker.assetWidth || 84; const assetHeight = marker.assetHeight || 60;
      const markerWidth = marker.type === 'image' ? Math.min(84, assetWidth) : Math.min(200, Math.max(64, marker.text.length * 8 + 18));
      const markerHeight = marker.type === 'image' ? Math.min(60, assetHeight) : 34;
      const group = new Konva.Group({ x: marker.x, y: marker.y, width: markerWidth, height: markerHeight, draggable: identity?.role === 'gm' && !layer.locked, name: `note-marker ${marker.id}` });
      if (marker.type === 'image' && marker.assetId) {
        const image = cachedImage(marker.assetId);
        const ratio = Math.min(84 / assetWidth, 60 / assetHeight);
        const width = assetWidth * ratio; const height = assetHeight * ratio;
        group.setAttrs({ width, height });
        group.add(new Konva.Rect({ width, height, fill: '#fff', cornerRadius: 5, stroke: '#426c59', strokeWidth: 2 }));
        group.add(new Konva.Image({ x: 2, y: 2, width: width - 4, height: height - 4, image, listening: false }));
      } else {
        group.add(new Konva.Rect({ width: markerWidth, height: markerHeight, fill: '#fffdf4', stroke: '#52645a', strokeWidth: 1.5, cornerRadius: 5, shadowColor: '#17231a', shadowBlur: 4, shadowOpacity: .15, shadowOffsetY: 2 }));
        group.add(new Konva.Text({ x: 8, y: 0, width: markerWidth - 16, height: markerHeight, text: marker.text.slice(0, 60), fontSize: 13, fontFamily: 'system-ui, sans-serif', fill: '#202722', wrap: 'none', ellipsis: true, verticalAlign: 'middle', align: 'center', listening: false }));
      }
      group.on('click tap', (event) => { event.cancelBubble = true; setSelectedMarker(marker.id); void openNote(marker.noteId); });
      group.on('dragend', () => void runCommand('note-marker:update', { id: marker.id, changes: { x: clampWorld(group.x()), y: clampWorld(group.y()) } }));
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
  updateSelectionControls();
  if (cropMode && changed) cropMode = false;
  drawObjects();
}

function setSelectedSticker(id: string | undefined) { selectedObjectId = undefined; selectedMarkerId = undefined; selectedStickerId = id; cropMode = false; updateSelectionControls(); drawObjects(); }
function setSelectedMarker(id: string | undefined) { selectedObjectId = undefined; selectedStickerId = undefined; selectedMarkerId = id; cropMode = false; updateSelectionControls(); drawObjects(); }

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
  markerTools.hidden = !marker || !markerRendered || identity?.role !== 'gm' || markerLayer?.locked === true;
  select<HTMLElement>('#lock-indicator').hidden = !(sticker && stickerLayer?.locked || marker && markerLayer?.locked);
  if (sticker && stickerRendered) {
    transformer?.nodes(canEditSticker ? [stickerRendered.group] : []); cropTransformer?.nodes([]);
    select<HTMLSelectElement>('#sticker-bg').value = sticker.bgColor; select<HTMLSelectElement>('#sticker-text-color').value = sticker.textColor; select<HTMLSelectElement>('#sticker-font-size').value = String(sticker.fontSize);
    return;
  }
  if (marker && markerRendered) { transformer?.nodes([]); cropTransformer?.nodes([]); return; }
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

function updateBoard(state: RoomMessage) {
  roomState = state;
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
  drawObjects();
  if (identity?.role === 'gm' && !notesPanel.hidden) void refreshNotesList();
  if (openNoteId && noteDialog.open && noteDialogMode === 'view') void openNote(openNoteId, false);
}

function setNoteMessage(message: string) { select<HTMLElement>('#note-message').textContent = message; }
function clearNoteContent() { select<HTMLElement>('#note-view-body').textContent = ''; select<HTMLElement>('#note-view-images').replaceChildren(); }
function closeNoteDialog() { noteRequestSequence += 1; noteDialog.close(); openNoteId = undefined; editingNoteId = undefined; clearNoteContent(); }

async function openNote(id: string, show = true) {
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
    if (show && !noteDialog.open) noteDialog.showModal();
  } catch { setNoteMessage('Не удалось загрузить заметку. Проверьте соединение.'); }
}

function openNoteEditor(note?: NoteRecord) {
  if (identity?.role !== 'gm') return;
  noteRequestSequence += 1;
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
  for (const asset of roomState?.assets || []) {
    const label = document.createElement('label'); label.className = 'asset-picker-item';
    const input = document.createElement('input'); input.type = assetPickerMode === 'marker' ? 'radio' : 'checkbox'; input.name = 'asset-picker-selection'; input.value = asset.id;
    input.checked = assetPickerMode === 'marker' ? asset.id === selectedMarkerAssetId : editingAssetIds.includes(asset.id);
    const image = document.createElement('img'); image.src = `/api/assets/${encodeURIComponent(asset.id)}`; image.alt = ''; image.loading = 'lazy';
    const name = document.createElement('span'); name.textContent = asset.originalName; name.title = asset.originalName;
    label.append(input, image, name); grid.append(label);
  }
  select<HTMLElement>('#asset-picker-library').hidden = false;
}

function openAssetPicker(mode: 'attachments' | 'marker') {
  assetPickerMode = mode; renderAssetPicker();
  select<HTMLElement>('#asset-picker-upload').hidden = true;
  select<HTMLButtonElement>('#asset-picker-library-mode').classList.add('active');
  select<HTMLButtonElement>('#asset-picker-upload-mode').classList.remove('active');
  select<HTMLButtonElement>('#asset-picker-add').hidden = false;
  select<HTMLElement>('#asset-picker-upload-message').textContent = '';
  if (!assetPickerDialog.open) assetPickerDialog.showModal();
}

async function uploadNoteImageFiles(files: File[]) {
  const message = select<HTMLElement>('#asset-picker-upload-message');
  const limit = roomState?.maxUploadBytes ?? 25 * 1024 * 1024;
  for (const file of files) {
    if (file.size > limit) { message.textContent = `${file.name}: превышен лимит ${formatSize(limit)}.`; continue; }
    const formData = new FormData(); formData.append('image', file);
    try {
      const response = await fetch('/api/assets', { method: 'POST', body: formData });
      const result = await response.json() as { asset?: NonNullable<BoardSnapshot['assets']>[number]; error?: string };
      if (!response.ok || !result.asset) throw new Error(result.error || 'Не удалось загрузить изображение.');
      if (roomState) roomState.assets = [...(roomState.assets || []).filter((entry) => entry.id !== result.asset!.id), result.asset];
      if (assetPickerMode === 'marker') selectedMarkerAssetId = result.asset.id;
      else if (!editingAssetIds.includes(result.asset.id)) editingAssetIds.push(result.asset.id);
      message.textContent = `${file.name}: загружено${result.asset.id !== undefined ? ' и добавлено в выбор' : ''}.`;
      renderAssets(); renderAssetPicker(); renderNoteAttachments(); updateMarkerEditorFields();
    } catch (error) { message.textContent = `${file.name}: ${error instanceof Error ? error.message : 'ошибка загрузки.'}`; }
  }
}

async function saveNote() {
  if (identity?.role !== 'gm') return;
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
    const add = document.createElement('button'); add.type = 'button'; add.className = 'asset-add'; add.textContent = 'Добавить';
    add.disabled = !activeLayerId || !roomState?.layers.some((layer) => layer.id === activeLayerId && !layer.locked);
    add.addEventListener('click', () => {
      const world = stage ? { x: (stage.width() / 2 - stage.x()) / stage.scaleX(), y: (stage.height() / 2 - stage.y()) / stage.scaleY() } : { x: 0, y: 0 };
      const scale = Math.min(1, 320 / asset.width, 240 / asset.height);
      const width = asset.width * scale; const height = asset.height * scale;
      void runCommand('object:create', { assetId: asset.id, layerId: activeLayerId, x: Math.round(world.x - width / 2), y: Math.round(world.y - height / 2) });
      libraryPanel.hidden = true;
    });
    item.append(image, text, add); assetsList.append(item);
  }
}

function formatSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function closeWorkspace(message: string) {
  resizeObserver?.disconnect();
  stage?.destroy(); stage = undefined; boardLayer = undefined; interactionLayer = undefined; transformer = undefined; cropTransformer = undefined;
  selectedObjectId = undefined; roomState = undefined; imageCache.clear(); renderedObjects.clear();
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

select<HTMLButtonElement>('#library-toggle').addEventListener('click', () => { libraryPanel.hidden = !libraryPanel.hidden; });
select<HTMLButtonElement>('#library-close').addEventListener('click', () => { libraryPanel.hidden = true; });
select<HTMLButtonElement>('#notes-toggle').addEventListener('click', () => { notesPanel.hidden = !notesPanel.hidden; if (!notesPanel.hidden) void refreshNotesList(); });
select<HTMLButtonElement>('#notes-close').addEventListener('click', () => { notesPanel.hidden = true; });
select<HTMLButtonElement>('#note-create').addEventListener('click', () => openNoteEditor());
select<HTMLButtonElement>('#note-close').addEventListener('click', closeNoteDialog);
noteDialog.addEventListener('close', () => { noteRequestSequence += 1; openNoteId = undefined; editingNoteId = undefined; clearNoteContent(); });
select<HTMLButtonElement>('#note-save').addEventListener('click', () => void saveNote());
select<HTMLButtonElement>('#note-edit').addEventListener('click', async () => { if (!openNoteId) return; try { const response = await fetch(`/api/notes/${encodeURIComponent(openNoteId)}`, { cache: 'no-store' }); if (response.ok) openNoteEditor((await response.json() as { note: NoteRecord }).note); } catch { setNoteMessage('Не удалось загрузить заметку.'); } });
select<HTMLButtonElement>('#note-place-marker').addEventListener('click', () => { if (openNoteId) { const id = openNoteId; closeNoteDialog(); startNotePlacement(id); } });
select<HTMLSelectElement>('#note-access').addEventListener('change', (event) => { select<HTMLElement>('#note-participants').hidden = (event.currentTarget as HTMLSelectElement).value !== 'selected-players'; });
select<HTMLSelectElement>('#note-marker-type').addEventListener('change', updateMarkerEditorFields);
select<HTMLButtonElement>('#note-add-image').addEventListener('click', () => openAssetPicker('attachments'));
select<HTMLButtonElement>('#note-marker-image-pick').addEventListener('click', () => openAssetPicker('marker'));
select<HTMLInputElement>('#note-image-upload').addEventListener('change', (event) => { void uploadNoteImageFiles(Array.from((event.currentTarget as HTMLInputElement).files || [])); (event.currentTarget as HTMLInputElement).value = ''; });
select<HTMLButtonElement>('#asset-picker-close').addEventListener('click', () => assetPickerDialog.close());
select<HTMLButtonElement>('#asset-picker-cancel').addEventListener('click', () => assetPickerDialog.close());
select<HTMLButtonElement>('#asset-picker-library-mode').addEventListener('click', () => { select<HTMLElement>('#asset-picker-library').hidden = false; select<HTMLElement>('#asset-picker-upload').hidden = true; select<HTMLButtonElement>('#asset-picker-add').hidden = false; select<HTMLButtonElement>('#asset-picker-library-mode').classList.add('active'); select<HTMLButtonElement>('#asset-picker-upload-mode').classList.remove('active'); });
select<HTMLButtonElement>('#asset-picker-upload-mode').addEventListener('click', () => { select<HTMLElement>('#asset-picker-library').hidden = true; select<HTMLElement>('#asset-picker-upload').hidden = false; select<HTMLButtonElement>('#asset-picker-add').hidden = true; select<HTMLButtonElement>('#asset-picker-library-mode').classList.remove('active'); select<HTMLButtonElement>('#asset-picker-upload-mode').classList.add('active'); });
select<HTMLButtonElement>('#asset-picker-add').addEventListener('click', () => {
  const values = Array.from(select<HTMLElement>('#asset-picker-grid').querySelectorAll<HTMLInputElement>('input:checked'), (input) => input.value);
  if (assetPickerMode === 'marker') { if (values[0]) selectedMarkerAssetId = values[0]; updateMarkerEditorFields(); }
  else editingAssetIds = [...new Set([...editingAssetIds, ...values])];
  renderNoteAttachments(); assetPickerDialog.close();
});
select<HTMLButtonElement>('#marker-edit').addEventListener('click', () => { const marker = roomState?.noteMarkers.find((entry) => entry.id === selectedMarkerId); if (marker) void openNote(marker.noteId); });
select<HTMLButtonElement>('#marker-delete').addEventListener('click', () => selectedMarkerId && void runCommand('note-marker:delete', { id: selectedMarkerId }));
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
