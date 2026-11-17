import type { RandomInt } from '../../../shared/dice.js';

/** Nechronica 1.2.0 supports only a single d10 with an arbitrary bonus. */
export const NECHRONICA_ROLL_SIDES = 10;
export const NECHRONICA_BONUS_LIMIT = 1_000_000_000;

export type NechronicaRollCategory = 'failure' | 'success';
export type NechronicaCritical = 'critical-failure' | 'critical-success' | null;

export interface NechronicaRollResult {
  /** Natural die value; always 1–10. */
  natural: number;
  bonus: number;
  /** Critical results ignore the bonus entirely. */
  bonusApplied: boolean;
  total: number;
  category: NechronicaRollCategory;
  critical: NechronicaCritical;
}

/**
 * Critical outcomes are decided by the natural die only. A natural 1 is
 * always displayed as 1 and a natural 10 as 10, even when a bonus exists.
 * Ordinary totals are never clamped: ≤5 is a failure and ≥6 is a success.
 */
export function calculateNechronicaRoll(bonus: number, randomInt: RandomInt): NechronicaRollResult {
  if (!Number.isSafeInteger(bonus) || Math.abs(bonus) > NECHRONICA_BONUS_LIMIT) {
    throw new Error('Некорректный бонус броска.');
  }
  const natural = randomInt(1, NECHRONICA_ROLL_SIDES + 1);
  if (!Number.isInteger(natural) || natural < 1 || natural > NECHRONICA_ROLL_SIDES) {
    throw new Error('Генератор вернул значение вне диапазона d10.');
  }
  if (natural === 1) {
    return { natural, bonus, bonusApplied: false, total: 1, category: 'failure', critical: 'critical-failure' };
  }
  if (natural === NECHRONICA_ROLL_SIDES) {
    return { natural, bonus, bonusApplied: false, total: NECHRONICA_ROLL_SIDES, category: 'success', critical: 'critical-success' };
  }
  const total = natural + bonus;
  return {
    natural,
    bonus,
    bonusApplied: true,
    total,
    category: total <= 5 ? 'failure' : 'success',
    critical: null,
  };
}
