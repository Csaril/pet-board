/**
 * Public metadata facade for PbtA.
 *
 * This module intentionally contains no server or client UI implementation.
 * The actual code lives in `client.ts` and in `server/modules/pbta-2d6/server.ts`
 * and is loaded lazily by the exact `pbta-2d6@1.0.0` key.
 */
import { findSystemMetadata } from '../../manifest.js';

export { pbtaSheetSchema, defaultPbtACharacteristics, isPbtACharacteristicKey } from './schema.js';

export const pbtaSystemModule = findSystemMetadata('pbta-2d6', '1.0.0')!;
