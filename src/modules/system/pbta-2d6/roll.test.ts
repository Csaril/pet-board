import assert from 'node:assert/strict';
import test from 'node:test';
import { createPbtARollCommand } from './module.js';
import { calculatePbtARoll, rollFreeDice } from './roll.js';

const randomFrom = (values: number[]) => {
  let index = 0;
  return (min: number, max: number) => {
    assert.equal(min, 1); assert.ok(values[index]! < max);
    return values[index++]!;
  };
};

test('PbtA categories use the total including negative modifiers', () => {
  assert.equal(calculatePbtARoll({ characteristicBonus: 0, situationalModifier: 0, disadvantage: false }, randomFrom([3, 3])).category, 'failure');
  assert.equal(calculatePbtARoll({ characteristicBonus: 1, situationalModifier: 0, disadvantage: false }, randomFrom([3, 3])).category, 'success');
  assert.equal(calculatePbtARoll({ characteristicBonus: 3, situationalModifier: 0, disadvantage: false }, randomFrom([3, 4])).category, 'triumph');
  assert.equal(calculatePbtARoll({ characteristicBonus: -20, situationalModifier: -1, disadvantage: false }, randomFrom([1, 1])).total, -19);
});

test('disadvantage keeps the lowest two dice and preserves modifiers for critical checks', () => {
  const result = calculatePbtARoll({ characteristicBonus: 2, situationalModifier: 1, disadvantage: true }, randomFrom([2, 3, 5]));
  assert.deepEqual(result.keptDice, [2, 3]); assert.equal(result.discardedDie, 5); assert.equal(result.total, 8);
  assert.equal(calculatePbtARoll({ characteristicBonus: 0, situationalModifier: 0, disadvantage: true }, randomFrom([1, 1, 6])).critical, 'critical-failure');
  assert.equal(calculatePbtARoll({ characteristicBonus: 0, situationalModifier: 0, disadvantage: true }, randomFrom([6, 6, 6])).critical, 'critical-success');
});

test('natural doubles are reported as critical outcomes independent of total', () => {
  assert.equal(calculatePbtARoll({ characteristicBonus: -10, situationalModifier: 0, disadvantage: false }, randomFrom([1, 1])).critical, 'critical-failure');
  assert.equal(calculatePbtARoll({ characteristicBonus: 10, situationalModifier: 0, disadvantage: false }, randomFrom([6, 6])).critical, 'critical-success');
});

test('exact category boundaries and independent situational modifiers are respected', () => {
  const roll = (dice: number[], bonus: number, modifier: -1 | 0 | 1, disadvantage = false) =>
    calculatePbtARoll({ characteristicBonus: bonus, situationalModifier: modifier, disadvantage }, randomFrom(dice));
  assert.equal(roll([2, 4], 0, 0).total, 6);
  assert.equal(roll([3, 4], 0, 0).total, 7);
  assert.equal(roll([4, 5], 0, 0).total, 9);
  assert.equal(roll([4, 6], 0, 0).total, 10);
  assert.equal(roll([3, 4], 0, 1).total, 8);
  assert.equal(roll([3, 4], 0, -1).total, 6);
  assert.equal(roll([2, 3, 5], 4, 1, true).total, 10);
  assert.equal(roll([2, 3, 5], 4, -1, true).total, 8);
});

test('future character sheets can prepare a server roll command from an arbitrary characteristic', () => {
  assert.deepEqual(createPbtARollCommand({ name: 'Resolve', bonus: -2, characterId: 'char-1', ownerId: 'player-1' }, { situationalModifier: 1, disadvantage: true }), {
    type: 'dice:pbta', characteristicName: 'Resolve', characteristicBonus: -2, characterId: 'char-1', characterOwnerId: 'player-1', actorId: 'player-1', situationalModifier: 1, disadvantage: true,
  });
});

test('free rolls validate supported dice and return separate values and total', () => {
  assert.deepEqual(rollFreeDice(3, 8, randomFrom([1, 4, 8])), { dice: [1, 4, 8], total: 13 });
  assert.throws(() => rollFreeDice(21, 6, randomFrom([])));
  assert.throws(() => rollFreeDice(1, 7, randomFrom([])));
});
