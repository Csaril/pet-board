import { randomUUID } from 'node:crypto';
import type { BoardFontFamily, BoardImage, CropRect, LayerAudience, StickerBackground, StickerTextColor } from '../src/shared/board.js';
import { DEFAULT_BOARD_FONT, isBoardFontFamily } from '../src/shared/fonts.js';
import type { Identity } from './store.js';
import { RoomStore } from './store.js';

export class BoardCommandError extends Error {}

type Command = Record<string, unknown> & { type?: string; requestId?: unknown };
const owns = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
const MIN_TEXT_MARKER_WIDTH = 64;
const MIN_TEXT_MARKER_HEIGHT = 34;
const MIN_IMAGE_MARKER_SIZE = 24;
const MAX_MARKER_SIZE = 4000;

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BoardCommandError(`${label} должен быть объектом.`);
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || value.trim().length < 1 || value.trim().length > maxLength) {
    throw new BoardCommandError(`${label}: допустимо от 1 до ${maxLength} символов.`);
  }
  return value.trim();
}
function number(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new BoardCommandError(`Недопустимое значение ${label}.`);
  }
  return value;
}
function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new BoardCommandError(`Недопустимое значение ${label}.`);
  return value;
}
function gmOnly(identity: Identity): void {
  if (identity.role !== 'gm') throw new BoardCommandError('Это действие доступно только ведущему.');
}
function audience(value: unknown): LayerAudience {
  if (value !== 'gm-only' && value !== 'all-players') throw new BoardCommandError('Недопустимая видимость слоя.');
  return value;
}
function stickerBackground(value: unknown): StickerBackground {
  if (value !== 'butter' && value !== 'rose' && value !== 'sky' && value !== 'sage') throw new BoardCommandError('Недопустимый цвет стикера.');
  return value;
}
function stickerTextColor(value: unknown): StickerTextColor {
  if (value !== 'black' && value !== 'white') throw new BoardCommandError('Недопустимый цвет текста.');
  return value;
}
function stickerFontSize(value: unknown): number {
  if (![12, 14, 16, 18, 24, 32, 40].includes(value as number)) throw new BoardCommandError('Недопустимый размер текста стикера.');
  return value as number;
}
function stickerFontFamily(value: unknown): BoardFontFamily {
  if (!isBoardFontFamily(value)) throw new BoardCommandError('Недопустимый шрифт стикера. Доступны «Стандартный» и «Caveat».');
  return value;
}
function crop(value: unknown): CropRect | null {
  if (value === null) return null;
  const input = objectValue(value, 'Обрезка');
  const result = {
    x: number(input.x, 'crop.x', 0, 1),
    y: number(input.y, 'crop.y', 0, 1),
    width: number(input.width, 'crop.width', 0.001, 1),
    height: number(input.height, 'crop.height', 0.001, 1),
  };
  if (result.x + result.width > 1.000001 || result.y + result.height > 1.000001) throw new BoardCommandError('Обрезка выходит за границы изображения.');
  return result;
}

export function executeBoardCommand(store: RoomStore, identity: Identity, raw: unknown): void {
  const command = objectValue(raw, 'Команда') as Command;
  switch (command.type) {
    case 'layer:create': {
      gmOnly(identity);
      store.createLayer(text(command.name, 'Название слоя', 80), command.audience === undefined ? 'all-players' : audience(command.audience));
      return;
    }
    case 'layer:update': {
      gmOnly(identity);
      const id = text(command.id, 'ID слоя', 64);
      if (!store.getLayer(id)) throw new BoardCommandError('Слой не найден.');
      const changes = objectValue(command.changes, 'Изменения слоя');
      const allowed = new Set(['name', 'visible', 'locked', 'audience']);
      if (Object.keys(changes).some((key) => !allowed.has(key))) throw new BoardCommandError('Слой содержит неизвестные поля.');
      const patch = {
        ...(owns(changes, 'name') ? { name: text(changes.name, 'Название слоя', 80) } : {}),
        ...(owns(changes, 'visible') ? { visible: boolean(changes.visible, 'visible') } : {}),
        ...(owns(changes, 'locked') ? { locked: boolean(changes.locked, 'locked') } : {}),
        ...(owns(changes, 'audience') ? { audience: audience(changes.audience) } : {}),
      };
      if (Object.keys(patch).length === 0) throw new BoardCommandError('Нет изменений слоя.');
      store.updateLayer(id, patch);
      return;
    }
    case 'layer:reorder': {
      gmOnly(identity);
      if (!Array.isArray(command.ids) || command.ids.some((id) => typeof id !== 'string')) throw new BoardCommandError('Некорректный порядок слоёв.');
      const ids = command.ids as string[];
      const existing = store.getLayers().map((layer) => layer.id);
      if (ids.length !== existing.length || new Set(ids).size !== ids.length || ids.some((id) => !existing.includes(id))) {
        throw new BoardCommandError('Порядок должен включать каждый слой ровно один раз.');
      }
      store.reorderLayers(ids);
      return;
    }
    case 'layer:delete': {
      gmOnly(identity);
      const id = text(command.id, 'ID слоя', 64);
      const layer = store.getLayer(id);
      if (!layer) throw new BoardCommandError('Слой не найден.');
      if (layer.locked) throw new BoardCommandError('Слой заблокирован. Сначала разблокируйте его.');
      if (store.getLayers().length <= 1) throw new BoardCommandError('В комнате должен остаться хотя бы один слой.');
      const count = store.countObjectsInLayer(id);
      const targetLayerId = command.targetLayerId === undefined ? undefined : text(command.targetLayerId, 'Целевой слой', 64);
      const deleteObjects = command.deleteObjects === true;
      if (targetLayerId && targetLayerId === id) throw new BoardCommandError('Выберите другой слой.');
      if (count > 0 && !targetLayerId && !deleteObjects) throw new BoardCommandError('Переместите объекты в другой слой или подтвердите их удаление.');
      if (targetLayerId) {
        const target = store.getLayer(targetLayerId);
        if (!target) throw new BoardCommandError('Целевой слой не найден.');
        if (target.locked) throw new BoardCommandError('Целевой слой заблокирован.');
      }
      store.deleteLayer(id, targetLayerId, deleteObjects);
      return;
    }
    case 'object:create': {
      gmOnly(identity);
      const assetId = text(command.assetId, 'ID ресурса', 64);
      const layerId = command.layerId === undefined ? store.getLayers()[0]?.id : text(command.layerId, 'ID слоя', 64);
      const asset = store.getAsset(assetId);
      const layer = layerId ? store.getLayer(layerId) : undefined;
      if (!asset) throw new BoardCommandError('Изображение не найдено.');
      if (!layer) throw new BoardCommandError('Слой не найден.');
      if (layer.locked) throw new BoardCommandError('Слой заблокирован.');
      const scale = Math.min(1, 320 / asset.width, 240 / asset.height);
      const object: BoardImage = {
        id: randomUUID(), assetId, layerId: layer.id,
        x: command.x === undefined ? 0 : number(command.x, 'x', -10_000_000, 10_000_000),
        y: command.y === undefined ? 0 : number(command.y, 'y', -10_000_000, 10_000_000),
        width: Math.max(1, Math.round(asset.width * scale)), height: Math.max(1, Math.round(asset.height * scale)),
        orderIndex: store.nextObjectOrder(layer.id), flipX: false, flipY: false, crop: null, allowPlayerMove: false, freeStretch: false,
      };
      store.createObject(object);
      return;
    }
    case 'object:update': {
      const id = text(command.id, 'ID объекта', 64);
      const object = store.getObject(id);
      if (!object) throw new BoardCommandError('Объект не найден.');
      const sourceLayer = store.getLayer(object.layerId);
      if (!sourceLayer) throw new BoardCommandError('Слой объекта не найден.');
      if (sourceLayer.locked) throw new BoardCommandError('Слой заблокирован.');
      const changes = objectValue(command.changes, 'Изменения объекта');
      const allKeys = new Set(['x', 'y', 'width', 'height', 'layerId', 'flipX', 'flipY', 'crop', 'allowPlayerMove', 'freeStretch', 'orderIndex']);
      if (Object.keys(changes).length === 0 || Object.keys(changes).some((key) => !allKeys.has(key))) throw new BoardCommandError('Объект содержит недопустимые поля.');
      if (identity.role === 'player') {
        if (!object.allowPlayerMove || sourceLayer.audience !== 'all-players' || !sourceLayer.visible) throw new BoardCommandError('Вам нельзя перемещать этот объект.');
        if (Object.keys(changes).some((key) => key !== 'x' && key !== 'y')) throw new BoardCommandError('Игрокам разрешено только перемещение объекта.');
      }
      const patch: Record<string, unknown> = {};
      if (owns(changes, 'x')) patch.x = number(changes.x, 'x', -10_000_000, 10_000_000);
      if (owns(changes, 'y')) patch.y = number(changes.y, 'y', -10_000_000, 10_000_000);
      if (owns(changes, 'flipX')) patch.flipX = boolean(changes.flipX, 'flipX');
      if (owns(changes, 'flipY')) patch.flipY = boolean(changes.flipY, 'flipY');
      if (owns(changes, 'crop')) patch.crop = crop(changes.crop);
      if (owns(changes, 'allowPlayerMove')) patch.allowPlayerMove = boolean(changes.allowPlayerMove, 'allowPlayerMove');
      const freeStretch = owns(changes, 'freeStretch') ? boolean(changes.freeStretch, 'freeStretch') : object.freeStretch;
      if (owns(changes, 'freeStretch')) patch.freeStretch = freeStretch;
      const width = owns(changes, 'width') ? number(changes.width, 'width', 1, 100_000) : object.width;
      const height = owns(changes, 'height') ? number(changes.height, 'height', 1, 100_000) : object.height;
      if (owns(changes, 'width') || owns(changes, 'height')) {
        if (freeStretch) {
          if (owns(changes, 'width')) patch.width = width;
          if (owns(changes, 'height')) patch.height = height;
        } else {
          const asset = store.getAsset(object.assetId);
          if (!asset) throw new BoardCommandError('Исходное изображение не найдено.');
          if (owns(changes, 'height') && !owns(changes, 'width')) {
            patch.width = number(Math.round(height * asset.width / asset.height), 'width', 1, 100_000);
            patch.height = height;
          } else {
            patch.width = width;
            patch.height = number(Math.round(width * asset.height / asset.width), 'height', 1, 100_000);
          }
        }
      } else if (owns(changes, 'freeStretch') && !freeStretch) {
        const asset = store.getAsset(object.assetId);
        if (!asset) throw new BoardCommandError('Исходное изображение не найдено.');
        patch.height = number(Math.round(object.width * asset.height / asset.width), 'height', 1, 100_000);
      }
      if (owns(changes, 'orderIndex')) patch.orderIndex = number(changes.orderIndex, 'orderIndex', 0, 1_000_000);
      if (owns(changes, 'layerId')) {
        const target = store.getLayer(text(changes.layerId, 'ID слоя', 64));
        if (!target) throw new BoardCommandError('Целевой слой не найден.');
        if (target.locked) throw new BoardCommandError('Целевой слой заблокирован.');
        patch.layerId = target.id;
        if (!owns(changes, 'orderIndex')) patch.orderIndex = store.nextObjectOrder(target.id);
      }
      store.updateObject(id, patch);
      return;
    }
    case 'object:delete': {
      gmOnly(identity);
      const object = store.getObject(text(command.id, 'ID объекта', 64));
      if (!object) throw new BoardCommandError('Объект не найден.');
      if (store.getLayer(object.layerId)?.locked) throw new BoardCommandError('Слой заблокирован.');
      store.deleteObject(object.id);
      return;
    }
    case 'object:duplicate': {
      gmOnly(identity);
      const source = store.getObject(text(command.id, 'ID объекта', 64));
      if (!source) throw new BoardCommandError('Объект не найден.');
      if (store.getLayer(source.layerId)?.locked) throw new BoardCommandError('Слой заблокирован.');
      store.createObject({ ...source, id: randomUUID(), x: source.x + 24, y: source.y + 24, orderIndex: store.nextObjectOrder(source.layerId) });
      return;
    }
    case 'object:order': {
      gmOnly(identity);
      const object = store.getObject(text(command.id, 'ID объекта', 64));
      if (!object) throw new BoardCommandError('Объект не найден.');
      if (store.getLayer(object.layerId)?.locked) throw new BoardCommandError('Слой заблокирован.');
      if (command.direction !== 'front' && command.direction !== 'back') throw new BoardCommandError('Недопустимое направление.');
      store.reorderObject(object.id, command.direction);
      return;
    }
    case 'note-marker:create': {
      gmOnly(identity);
      const noteId = text(command.noteId, 'ID заметки', 64);
      const layerId = text(command.layerId, 'ID слоя', 64);
      const note = store.getNote(noteId);
      if (!note) throw new BoardCommandError('Заметка не найдена.');
      if (note.noteType !== 'board') throw new BoardCommandError('Личные заметки не размещаются на доске.');
      const layer = store.getLayer(layerId);
      if (!layer) throw new BoardCommandError('Слой не найден.');
      if (layer.locked) throw new BoardCommandError('Слой заблокирован.');
      store.createNoteMarker({ id: randomUUID(), noteId, layerId, x: number(command.x, 'x', -10_000_000, 10_000_000), y: number(command.y, 'y', -10_000_000, 10_000_000) });
      return;
    }
    case 'note-marker:update': {
      gmOnly(identity);
      const id = text(command.id, 'ID метки', 64);
      const marker = store.getNoteMarker(id);
      if (!marker) throw new BoardCommandError('Метка не найдена.');
      const source = store.getLayer(marker.layerId);
      if (!source || source.locked) throw new BoardCommandError('Слой заблокирован.');
      const changes = objectValue(command.changes, 'Изменения метки');
      const allowed = new Set(['x', 'y', 'layerId', 'width', 'height']);
      if (!Object.keys(changes).length || Object.keys(changes).some((key) => !allowed.has(key))) throw new BoardCommandError('Недопустимые изменения метки.');
      const requestedWidth = owns(changes, 'width') ? number(changes.width, 'width', 1, MAX_MARKER_SIZE) : marker.width;
      const requestedHeight = owns(changes, 'height') ? number(changes.height, 'height', 1, MAX_MARKER_SIZE) : marker.height;
      let width = requestedWidth;
      let height = requestedHeight;
      if (marker.type === 'image') {
        const assetWidth = marker.assetWidth || 1;
        const assetHeight = marker.assetHeight || 1;
        const ratio = assetWidth / assetHeight;
        if (owns(changes, 'width') && !owns(changes, 'height')) height = Math.round(width / ratio);
        else if (owns(changes, 'height') && !owns(changes, 'width')) width = Math.round(height * ratio);
        else { height = Math.round(width / ratio); width = Math.round(height * ratio); }
        if (width < MIN_IMAGE_MARKER_SIZE) { width = MIN_IMAGE_MARKER_SIZE; height = Math.round(width / ratio); }
        if (height < MIN_IMAGE_MARKER_SIZE) { height = MIN_IMAGE_MARKER_SIZE; width = Math.round(height * ratio); }
        if (width > MAX_MARKER_SIZE || height > MAX_MARKER_SIZE) throw new BoardCommandError('Размер метки слишком велик.');
      } else {
        if (width < MIN_TEXT_MARKER_WIDTH) throw new BoardCommandError('Минимальная ширина текстовой метки — 64.');
        if (height < MIN_TEXT_MARKER_HEIGHT) throw new BoardCommandError('Минимальная высота текстовой метки — 34.');
      }
      const resize = owns(changes, 'width') || owns(changes, 'height');
      store.updateNoteMarker(id, {
        ...(owns(changes, 'x') ? { x: number(changes.x, 'x', -10_000_000, 10_000_000) } : {}),
        ...(owns(changes, 'y') ? { y: number(changes.y, 'y', -10_000_000, 10_000_000) } : {}),
        ...(resize ? { width: Math.round(width), height: Math.round(height) } : {}),
        ...(owns(changes, 'layerId') ? (() => {
          const target = store.getLayer(text(changes.layerId, 'Целевой слой', 64));
          if (!target) throw new BoardCommandError('Целевой слой не найден.');
          if (target.locked) throw new BoardCommandError('Целевой слой заблокирован.');
          return { layerId: target.id };
        })() : {}),
      });
      return;
    }
    case 'note-marker:delete': {
      gmOnly(identity);
      const marker = store.getNoteMarker(text(command.id, 'ID метки', 64));
      if (!marker) throw new BoardCommandError('Метка не найдена.');
      if (store.getLayer(marker.layerId)?.locked) throw new BoardCommandError('Слой заблокирован.');
      store.deleteNoteMarker(marker.id);
      return;
    }
    case 'sticker:create': {
      let layer = identity.role === 'gm'
        ? store.getLayer(text(command.layerId, 'ID слоя', 64))
        : store.getLayers().find((candidate) => candidate.audience === 'all-players' && candidate.visible && !candidate.locked);
      if (!layer && identity.role === 'player') layer = store.createLayer('Стикеры игроков', 'all-players');
      if (!layer) throw new BoardCommandError('Слой не найден.');
      if (layer.locked || (identity.role === 'player' && (layer.audience !== 'all-players' || !layer.visible))) throw new BoardCommandError('Слой недоступен для создания стикера.');
      store.createSticker({
        id: randomUUID(), creatorId: identity.participantId, layerId: layer.id,
        text: text(command.text, 'Текст стикера', 1000),
        x: number(command.x, 'x', -10_000_000, 10_000_000), y: number(command.y, 'y', -10_000_000, 10_000_000),
        width: command.width === undefined ? 240 : number(command.width, 'width', 120, 600),
        height: command.height === undefined ? 140 : number(command.height, 'height', 80, 800),
        bgColor: command.bgColor === undefined ? 'butter' : stickerBackground(command.bgColor),
        textColor: command.textColor === undefined ? 'black' : stickerTextColor(command.textColor),
        fontSize: command.fontSize === undefined ? 18 : stickerFontSize(command.fontSize),
        fontFamily: command.fontFamily === undefined ? DEFAULT_BOARD_FONT : stickerFontFamily(command.fontFamily),
      });
      return;
    }
    case 'sticker:update': {
      const id = text(command.id, 'ID стикера', 64);
      const sticker = store.getSticker(id);
      if (!sticker) throw new BoardCommandError('Стикер не найден.');
      const source = store.getLayer(sticker.layerId);
      if (!source || source.locked) throw new BoardCommandError('Слой заблокирован.');
      if (identity.role !== 'gm' && sticker.creatorId !== identity.participantId) throw new BoardCommandError('Можно редактировать только свой стикер.');
      if (identity.role === 'player' && (source.audience !== 'all-players' || !source.visible)) throw new BoardCommandError('Стикер недоступен.');
      const changes = objectValue(command.changes, 'Изменения стикера');
      const allowed = new Set(['text', 'x', 'y', 'width', 'height', 'bgColor', 'textColor', 'fontSize', 'fontFamily', 'layerId']);
      if (!Object.keys(changes).length || Object.keys(changes).some((key) => !allowed.has(key))) throw new BoardCommandError('Недопустимые изменения стикера.');
      const patch = {
        ...(owns(changes, 'text') ? { text: text(changes.text, 'Текст стикера', 1000) } : {}),
        ...(owns(changes, 'x') ? { x: number(changes.x, 'x', -10_000_000, 10_000_000) } : {}),
        ...(owns(changes, 'y') ? { y: number(changes.y, 'y', -10_000_000, 10_000_000) } : {}),
        ...(owns(changes, 'width') ? { width: number(changes.width, 'width', 120, 600) } : {}),
        ...(owns(changes, 'height') ? { height: number(changes.height, 'height', 80, 800) } : {}),
        ...(owns(changes, 'bgColor') ? { bgColor: stickerBackground(changes.bgColor) } : {}),
        ...(owns(changes, 'textColor') ? { textColor: stickerTextColor(changes.textColor) } : {}),
        ...(owns(changes, 'fontSize') ? { fontSize: stickerFontSize(changes.fontSize) } : {}),
        ...(owns(changes, 'fontFamily') ? { fontFamily: stickerFontFamily(changes.fontFamily) } : {}),
        ...(owns(changes, 'layerId') ? (() => {
          const target = store.getLayer(text(changes.layerId, 'Целевой слой', 64));
          if (!target) throw new BoardCommandError('Целевой слой не найден.');
          if (target.locked || (identity.role === 'player' && (target.audience !== 'all-players' || !target.visible))) throw new BoardCommandError('Целевой слой недоступен для редактирования.');
          return { layerId: target.id };
        })() : {}),
      };
      store.updateSticker(id, patch);
      return;
    }
    case 'sticker:delete': {
      const sticker = store.getSticker(text(command.id, 'ID стикера', 64));
      if (!sticker) throw new BoardCommandError('Стикер не найден.');
      const layer = store.getLayer(sticker.layerId);
      if (!layer || layer.locked) throw new BoardCommandError('Слой заблокирован.');
      if (identity.role !== 'gm' && sticker.creatorId !== identity.participantId) throw new BoardCommandError('Можно удалить только свой стикер.');
      store.deleteSticker(sticker.id);
      return;
    }
    case 'sticker:duplicate': {
      const source = store.getSticker(text(command.id, 'ID стикера', 64));
      if (!source) throw new BoardCommandError('Стикер не найден.');
      const layer = store.getLayer(source.layerId);
      if (!layer || layer.locked) throw new BoardCommandError('Слой заблокирован.');
      if (identity.role !== 'gm' && source.creatorId !== identity.participantId) throw new BoardCommandError('Нельзя дублировать чужой стикер.');
      store.createSticker({ ...source, id: randomUUID(), x: source.x + 24, y: source.y + 24 });
      return;
    }
    default:
      throw new BoardCommandError('Неизвестная команда доски.');
  }
}
