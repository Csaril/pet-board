import type { SheetCharacteristicKey } from '../../../shared/board.js';

/**
 * Persisted PbtA sheet shape. The client and the server module share this
 * compact schema, but the core never imports it.
 */
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
  return typeof value === 'string' && pbtaSheetSchema.characteristics.some((entry) => entry.key === value);
}
