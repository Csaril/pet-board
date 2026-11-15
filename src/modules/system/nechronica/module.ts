/**
 * Public metadata facade for Nechronica.
 *
 * No UI or server implementation is imported here. Stage 5 keeps the Nechronica
 * mechanics as a placeholder, but its client chunk and server module are real
 * lazy entrypoints.
 */
import { findSystemMetadata } from '../../manifest.js';

export const nechronicaSystemModule = findSystemMetadata('nechronica', '1.0.0')!;

export const nechronicaSheetSchema = {
  version: nechronicaSystemModule.sheetSchemaVersion,
} as const;
