import type { RandomInt } from '../../../shared/dice.js';

export type SituationalModifier = -1 | 0 | 1;
export type RollCategory = 'failure' | 'success' | 'triumph';
export type CriticalResult = 'critical-failure' | 'critical-success' | null;
export { rollFreeDice } from '../../../shared/dice.js';
export type { RandomInt } from '../../../shared/dice.js';

export interface PbtARollInput {
  characteristicBonus: number;
  situationalModifier: SituationalModifier;
  disadvantage: boolean;
}

export interface PbtARollResult {
  dice: number[];
  keptDice: number[];
  discardedDie: number | null;
  characteristicBonus: number;
  situationalModifier: SituationalModifier;
  total: number;
  category: RollCategory;
  critical: CriticalResult;
}

export function calculatePbtARoll(input: PbtARollInput, randomInt: RandomInt): PbtARollResult {
  if (!Number.isSafeInteger(input.characteristicBonus) || Math.abs(input.characteristicBonus) > 1000) throw new Error('Некорректный бонус характеристики.');
  if (input.situationalModifier !== -1 && input.situationalModifier !== 0 && input.situationalModifier !== 1) throw new Error('Некорректный ситуационный модификатор.');
  const count = input.disadvantage ? 3 : 2;
  const dice = Array.from({ length: count }, () => {
    const value = randomInt(1, 7);
    if (!Number.isInteger(value) || value < 1 || value > 6) throw new Error('Генератор вернул значение вне диапазона d6.');
    return value;
  });
  const ordered = [...dice].sort((a, b) => a - b);
  const keptDice = input.disadvantage ? ordered.slice(0, 2) : dice;
  const discardedDie = input.disadvantage ? ordered[2]! : null;
  const total = keptDice.reduce((sum, value) => sum + value, 0) + input.characteristicBonus + input.situationalModifier;
  const category: RollCategory = total <= 6 ? 'failure' : total <= 9 ? 'success' : 'triumph';
  const critical: CriticalResult = keptDice.every((value) => value === 1) ? 'critical-failure' : keptDice.every((value) => value === 6) ? 'critical-success' : null;
  return { dice, keptDice, discardedDie, characteristicBonus: input.characteristicBonus, situationalModifier: input.situationalModifier, total, category, critical };
}
