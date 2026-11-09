import { randomUUID } from 'node:crypto';
import type { BoardImage, CropRect, LayerAudience } from '../src/shared/board.js';
import type { Identity } from './store.js';
import { RoomStore } from './store.js';

export class BoardCommandError extends Error {}

type Command = Record<string, unknown> & { type?: string; requestId?: unknown };
const owns = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

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
        orderIndex: store.nextObjectOrder(layer.id), flipX: false, flipY: false, crop: null, allowPlayerMove: false,
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
      const allKeys = new Set(['x', 'y', 'width', 'height', 'layerId', 'flipX', 'flipY', 'crop', 'allowPlayerMove', 'orderIndex']);
      if (Object.keys(changes).length === 0 || Object.keys(changes).some((key) => !allKeys.has(key))) throw new BoardCommandError('Объект содержит недопустимые поля.');
      if (identity.role === 'player') {
        if (!object.allowPlayerMove || sourceLayer.audience !== 'all-players' || !sourceLayer.visible) throw new BoardCommandError('Вам нельзя перемещать этот объект.');
        if (Object.keys(changes).some((key) => key !== 'x' && key !== 'y')) throw new BoardCommandError('Игрокам разрешено только перемещение объекта.');
      }
      const patch: Record<string, unknown> = {};
      if (owns(changes, 'x')) patch.x = number(changes.x, 'x', -10_000_000, 10_000_000);
      if (owns(changes, 'y')) patch.y = number(changes.y, 'y', -10_000_000, 10_000_000);
      if (owns(changes, 'width')) patch.width = number(changes.width, 'width', 1, 100_000);
      if (owns(changes, 'height')) patch.height = number(changes.height, 'height', 1, 100_000);
      if (owns(changes, 'flipX')) patch.flipX = boolean(changes.flipX, 'flipX');
      if (owns(changes, 'flipY')) patch.flipY = boolean(changes.flipY, 'flipY');
      if (owns(changes, 'crop')) patch.crop = crop(changes.crop);
      if (owns(changes, 'allowPlayerMove')) patch.allowPlayerMove = boolean(changes.allowPlayerMove, 'allowPlayerMove');
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
    default:
      throw new BoardCommandError('Неизвестная команда доски.');
  }
}
