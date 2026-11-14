/**
 * Nechronica system module.
 *
 * Stage 1 intentionally contains no game mechanics: the sheet and roll UI are
 * placeholders. Keeping the module independent from PbtA guarantees that the
 * two systems can evolve and store their data separately.
 */
export const nechronicaSystemModule = {
  id: 'nechronica',
  version: '1.0.0',
  name: 'Nechronica',
  sheetSchemaVersion: 1,
  capabilities: { battleMap: true },
};

export const nechronicaSheetSchema = {
  version: nechronicaSystemModule.sheetSchemaVersion,
} as const;
