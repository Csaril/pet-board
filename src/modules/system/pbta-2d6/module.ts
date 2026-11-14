import type { SheetCharacteristicKey } from '../../../shared/board.js';
import type { PbtARollInput, RandomInt } from './roll.js';
import { calculatePbtARoll } from './roll.js';

export const pbtaSystemModule = {
  id: 'pbta-2d6',
  version: '1.0.0',
  name: 'PbtA',
  sheetSchemaVersion: 1,
  capabilities: { battleMap: false },
  roll(input: PbtARollInput, randomInt: RandomInt) {
    return calculatePbtARoll(input, randomInt);
  },
};

export const pbtaSheetSchema = {
  version: 1,
  characteristics: [
    { key: 'might', name: 'Могущество' },
    { key: 'insight', name: 'Познание' },
    { key: 'glory', name: 'Величие' },
    { key: 'will', name: 'Воля' },
  ],
} as const satisfies {
  version: number;
  characteristics: ReadonlyArray<{ key: SheetCharacteristicKey; name: string }>;
};

export function defaultPbtACharacteristics(): Record<SheetCharacteristicKey, number> {
  return { might: 0, insight: 0, glory: 0, will: 0 };
}

export function isPbtACharacteristicKey(value: unknown): value is SheetCharacteristicKey {
  return pbtaSheetSchema.characteristics.some((characteristic) => characteristic.key === value);
}

export type PbtACharacteristic = { name: string; bonus: number; characterId?: string; ownerId?: string };

export function createPbtARollCommand(
  characteristic: PbtACharacteristic,
  options: Omit<PbtARollInput, 'characteristicBonus'>,
) {
  return {
    type: 'dice:pbta' as const,
    characteristicName: characteristic.name,
    characteristicBonus: characteristic.bonus,
    characterId: characteristic.characterId,
    characterOwnerId: characteristic.ownerId,
    actorId: characteristic.ownerId,
    situationalModifier: options.situationalModifier,
    disadvantage: options.disadvantage,
  };
}

export function rollForCharacteristic(
  characteristic: PbtACharacteristic,
  options: Omit<PbtARollInput, 'characteristicBonus'>,
  randomInt: RandomInt,
) {
  return pbtaSystemModule.roll({ ...options, characteristicBonus: characteristic.bonus }, randomInt);
}
