import type { PbtARollInput, RandomInt } from './roll.js';
import { calculatePbtARoll } from './roll.js';

export const pbtaSystemModule = {
  id: 'pbta-2d6',
  version: '1.0.0',
  name: 'PbtA',
  roll(input: PbtARollInput, randomInt: RandomInt) {
    return calculatePbtARoll(input, randomInt);
  },
};

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
