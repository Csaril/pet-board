import type { SheetCharacteristicKey } from '../../../src/shared/board.js';
import type { SystemServerModule } from '../../system-contract.js';

/**
 * Nechronica server placeholder.
 *
 * It is a real lazy entrypoint with its own production file, but stage 5 does
 * not implement Nechronica mechanics. It owns no sheet fields, commands or
 * rolls, so PbtA-only operations are rejected by the core contract.
 */
export const systemServerModule: SystemServerModule = {
  id: 'nechronica',
  version: '1.0.0',
  advancedSheet: false,
  sheetDefaults() {
    return { characteristics: {} as Record<SheetCharacteristicKey, number>, fate: 0 };
  },
};
