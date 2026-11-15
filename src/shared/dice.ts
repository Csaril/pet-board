export type RandomInt = (min: number, max: number) => number;

/** System-independent free dice. */
export function rollFreeDice(count: number, sides: number, randomInt: RandomInt): { dice: number[]; total: number } {
  if (!Number.isInteger(count) || count < 1 || count > 20) throw new Error('Количество кубиков должно быть от 1 до 20.');
  if (![4, 6, 8, 10, 12, 20, 100].includes(sides)) throw new Error('Неподдерживаемый тип кубика.');
  const dice = Array.from({ length: count }, () => {
    const value = randomInt(1, sides + 1);
    if (!Number.isInteger(value) || value < 1 || value > sides) throw new Error('Генератор вернул значение вне диапазона кубика.');
    return value;
  });
  return { dice, total: dice.reduce((sum, value) => sum + value, 0) };
}
