import Konva from 'konva';
import type { BoardImage, BoardLayer, BoardSnapshot, BoardStateMessage, CropRect } from '../shared/board.js';
import { cameraForBounds, isValidCamera, zoomKeepingScreenPoint } from '../shared/camera.js';

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
const selectedLayer = select<HTMLSelectElement>('#object-layer');
const stretchControl = select<HTMLInputElement>('#free-stretch');
const allowPlayerMoveControl = select<HTMLInputElement>('#allow-player-move');
const MAX_WORLD_COORDINATE = 10_000_000;
const MAX_ZOOM = 4;
const MIN_ZOOM = 0.00001;

type AppIdentity = BoardStateMessage['identity'];
interface RoomMessage extends BoardStateMessage {
  participants: Array<{ name: string; role: 'gm' | 'player' }>;
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
}
interface CropGesture {
  id: string;
  group: Konva.Group;
  selection: Konva.Rect;
  start: { x: number; y: number };
}

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
let resizeObserver: ResizeObserver | undefined;
let selectedObjectId: string | undefined;
let activeLayerId: string | undefined;
let cropMode = false;
let cropGesture: CropGesture | undefined;
let camera = { x: 0, y: 0, scale: 1 };
let hasRestoredCamera = false;
let panGesture: { x: number; y: number; cameraX: number; cameraY: number } | undefined;
let messageTimer: number | undefined;
const imageCache = new Map<string, HTMLImageElement>();
const renderedObjects = new Map<string, RenderedObject>();
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
  identity = { role, name };
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
  });
  interactionLayer.add(transformer);
  stage.add(boardLayer, interactionLayer);
  stage.on('mousedown touchstart', (event) => {
    if (event.target !== stage || cropMode) return;
    const pointer = stage!.getPointerPosition();
    if (!pointer) return;
    panGesture = { x: pointer.x, y: pointer.y, cameraX: stage!.x(), cameraY: stage!.y() };
  });
  stage.on('mousemove touchmove', () => {
    if (cropGesture) updateCropGesture();
    if (!panGesture) return;
    const pointer = stage!.getPointerPosition();
    if (!pointer) return;
    stage!.position({ x: panGesture.cameraX + pointer.x - panGesture.x, y: panGesture.cameraY + pointer.y - panGesture.y });
    boardLayer!.batchDraw();
  });
  stage.on('mouseup touchend', () => {
    panGesture = undefined;
    if (cropGesture) commitCropGesture();
    else saveCamera();
  });
  stage.on('click tap', (event) => {
    if (event.target === stage && selectedObjectId) setSelectedObject(undefined);
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

function fitAllObjects() {
  if (!stage || !roomState) return;
  const visibleIds = new Set(roomState.layers.filter((layer) => layer.visible).map((layer) => layer.id));
  const objects = roomState.objects.filter((item) => visibleIds.has(item.layerId));
  const bounds = objects.length ? {
    minX: Math.min(...objects.map((item) => item.x)), minY: Math.min(...objects.map((item) => item.y)),
    maxX: Math.max(...objects.map((item) => item.x + item.width)), maxY: Math.max(...objects.map((item) => item.y + item.height)),
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

function imageCrop(item: BoardImage, image: HTMLImageElement) {
  const crop = item.crop ?? { x: 0, y: 0, width: 1, height: 1 };
  return { x: crop.x * image.naturalWidth, y: crop.y * image.naturalHeight, width: crop.width * image.naturalWidth, height: crop.height * image.naturalHeight };
}

function updateImageNode(node: Konva.Image, item: BoardImage, image: HTMLImageElement) {
  node.setAttrs({
    x: item.flipX ? item.width : 0,
    y: item.flipY ? item.height : 0,
    width: item.width,
    height: item.height,
    scaleX: item.flipX ? -1 : 1,
    scaleY: item.flipY ? -1 : 1,
    crop: imageCrop(item, image),
    image,
  });
}

function drawObjects() {
  if (!boardLayer || !roomState) return;
  boardLayer.destroyChildren();
  transformer?.nodes([]);
  renderedObjects.clear();
  const visibleLayers = roomState.layers.filter((layer) => layer.visible).sort((a, b) => a.orderIndex - b.orderIndex);
  for (const layer of visibleLayers) {
    const objects = roomState.objects.filter((object) => object.layerId === layer.id).sort((a, b) => a.orderIndex - b.orderIndex);
    for (const item of objects) {
      const htmlImage = cachedImage(item.assetId);
      const group = new Konva.Group({
        x: item.x, y: item.y, width: item.width, height: item.height,
        draggable: canMove(item, layer) && !(cropMode && selectedObjectId === item.id),
        name: `board-object ${item.id}`,
      });
      const imageNode = new Konva.Image({ image: htmlImage, listening: true });
      updateImageNode(imageNode, item, htmlImage);
      const border = new Konva.Rect({ x: 0, y: 0, width: item.width, height: item.height, stroke: layer.locked ? '#bd7b20' : '#1684d4', strokeWidth: 2, dash: [5, 3], listening: false, strokeEnabled: false });
      group.add(imageNode, border);
      group.on('click tap', (event) => { event.cancelBubble = true; setSelectedObject(item.id); });
      group.on('dragend', () => { void runCommand('object:update', { id: item.id, changes: { x: clampWorld(group.x()), y: clampWorld(group.y()) } }); });
      group.on('transformend', () => {
        if (identity?.role !== 'gm' || layer.locked) return;
        const width = Math.max(1, Math.round(group.width() * Math.abs(group.scaleX())));
        const height = Math.max(1, Math.round(group.height() * Math.abs(group.scaleY())));
        group.scale({ x: 1, y: 1 });
        group.size({ width, height });
        void runCommand('object:update', { id: item.id, changes: { x: clampWorld(group.x()), y: clampWorld(group.y()), width, height } });
      });
      group.on('mousedown touchstart', (event) => {
        if (!cropMode || selectedObjectId !== item.id || identity?.role !== 'gm' || layer.locked) return;
        event.cancelBubble = true;
        startCropGesture(item.id, group);
      });
      boardLayer.add(group);
      renderedObjects.set(item.id, { group, image: imageNode, border });
    }
  }
  if (selectedObjectId) updateSelectionControls();
  boardLayer.batchDraw();
}

function clampWorld(value: number) { return Math.max(-MAX_WORLD_COORDINATE, Math.min(MAX_WORLD_COORDINATE, value)); }

function setSelectedObject(id: string | undefined) {
  selectedObjectId = id;
  updateSelectionControls();
  if (cropMode && id) cropMode = false;
  drawObjects();
}

function updateSelectionControls() {
  const item = roomState?.objects.find((object) => object.id === selectedObjectId);
  const layer = item && roomState?.layers.find((entry) => entry.id === item.layerId);
  const rendered = item && renderedObjects.get(item.id);
  objectTools.hidden = !item || !layer || !rendered || identity?.role !== 'gm';
  if (!item || !layer || !rendered) {
    select<HTMLElement>('#lock-indicator').hidden = true;
    transformer?.nodes([]);
    return;
  }
  select<HTMLElement>('#selection-name').textContent = roomState?.assets?.find((asset) => asset.id === item.assetId)?.originalName || 'Изображение';
  rendered.border.strokeEnabled(true);
  select<HTMLElement>('#lock-indicator').hidden = !layer.locked;
  selectedLayer.replaceChildren(...(roomState?.layers || []).map((entry) => {
    const option = document.createElement('option'); option.value = entry.id; option.textContent = entry.name; option.disabled = entry.locked && entry.id !== item.layerId; return option;
  }));
  selectedLayer.value = item.layerId;
  allowPlayerMoveControl.checked = item.allowPlayerMove;
  const isGm = identity?.role === 'gm';
  const editable = isGm && !layer.locked;
  transformer?.nodes(editable && !cropMode ? [rendered.group] : []);
  if (transformer) transformer.keepRatio(!stretchControl.checked);
  select<HTMLButtonElement>('#crop-toggle').classList.toggle('active', cropMode);
  select<HTMLButtonElement>('#crop-reset').hidden = !item.crop;
  select<HTMLButtonElement>('#crop-cancel').hidden = !cropMode;
  for (const element of objectTools.querySelectorAll<HTMLElement>('.gm-only')) element.hidden = !isGm;
  for (const button of objectTools.querySelectorAll<HTMLButtonElement>('button')) {
    if (button.id === 'crop-toggle') { button.disabled = !editable; continue; }
    if (button.id === 'crop-cancel') continue;
    if (button.id === 'crop-reset') button.disabled = !editable || !item.crop;
    else button.disabled = identity?.role === 'gm' ? !editable : button.id !== 'crop-toggle';
  }
  allowPlayerMoveControl.disabled = !editable;
  stretchControl.disabled = !editable;
  selectedLayer.disabled = !editable;
}

function startCropGesture(id: string, group: Konva.Group) {
  const start = group.getRelativePointerPosition();
  if (!start) return;
  cropGesture?.selection.destroy();
  const selection = new Konva.Rect({ x: start.x, y: start.y, width: 1, height: 1, stroke: '#426c59', strokeWidth: 2, dash: [5, 3], fill: '#426c5920', listening: false });
  group.add(selection);
  cropGesture = { id, group, selection, start };
}

function updateCropGesture() {
  if (!cropGesture) return;
  const pointer = cropGesture.group.getRelativePointerPosition();
  if (!pointer) return;
  const x = Math.max(0, Math.min(cropGesture.group.width(), Math.min(cropGesture.start.x, pointer.x)));
  const y = Math.max(0, Math.min(cropGesture.group.height(), Math.min(cropGesture.start.y, pointer.y)));
  const right = Math.max(0, Math.min(cropGesture.group.width(), Math.max(cropGesture.start.x, pointer.x)));
  const bottom = Math.max(0, Math.min(cropGesture.group.height(), Math.max(cropGesture.start.y, pointer.y)));
  cropGesture.selection.setAttrs({ x, y, width: right - x, height: bottom - y });
  boardLayer?.batchDraw();
}

function commitCropGesture() {
  const gesture = cropGesture;
  cropGesture = undefined;
  if (!gesture) return;
  const { selection, group, id } = gesture;
  const selectionRect = { x: selection.x(), y: selection.y(), width: selection.width(), height: selection.height() };
  selection.destroy();
  const width = group.width(); const height = group.height();
  if (selectionRect.width < 8 || selectionRect.height < 8 || width < 1 || height < 1) { boardLayer?.batchDraw(); return; }
  const item = roomState?.objects.find((object) => object.id === id);
  if (!item) return;
  const current = item.crop ?? { x: 0, y: 0, width: 1, height: 1 };
  let relativeX = selectionRect.x / width; let relativeY = selectionRect.y / height;
  const relativeWidth = selectionRect.width / width; const relativeHeight = selectionRect.height / height;
  if (item.flipX) relativeX = 1 - relativeX - relativeWidth;
  if (item.flipY) relativeY = 1 - relativeY - relativeHeight;
  const next: CropRect = {
    x: current.x + relativeX * current.width,
    y: current.y + relativeY * current.height,
    width: relativeWidth * current.width,
    height: relativeHeight * current.height,
  };
  cropMode = false;
  void runCommand('object:update', { id, changes: { crop: next } });
  updateSelectionControls();
  boardLayer?.batchDraw();
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
  renderLayers();
  renderAssets();
  drawObjects();
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
      const objectCount = roomState?.objects.filter((object) => object.layerId === layer.id).length || 0;
      const deleteObjects = objectCount > 0 && window.confirm(`В слое ${objectCount} объектов. Удалить слой вместе с объектами?`);
      if (objectCount > 0 && !deleteObjects) return;
      void runCommand('layer:delete', { id: layer.id, deleteObjects });
    });
    meta.append(access, rename, remove);
    const state = document.createElement('div'); state.className = 'layer-state';
    state.textContent = `${roomState.objects.filter((object) => object.layerId === layer.id).length} изображ.`;
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
  stage?.destroy(); stage = undefined; boardLayer = undefined; interactionLayer = undefined; transformer = undefined;
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
  cropMode = !cropMode;
  canvasContainer.style.cursor = cropMode ? 'crosshair' : '';
  updateSelectionControls();
  drawObjects();
});
select<HTMLButtonElement>('#crop-cancel').addEventListener('click', () => {
  cropMode = false; cropGesture?.selection.destroy(); cropGesture = undefined;
  canvasContainer.style.cursor = ''; updateSelectionControls(); drawObjects();
});
select<HTMLButtonElement>('#crop-reset').addEventListener('click', () => selectedObjectId && void runCommand('object:update', { id: selectedObjectId, changes: { crop: null } }));
stretchControl.addEventListener('change', () => { if (transformer) transformer.keepRatio(!stretchControl.checked); });
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
