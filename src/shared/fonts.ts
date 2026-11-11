import type { BoardFontFamily } from './board.js';

export const DEFAULT_BOARD_FONT: BoardFontFamily = 'default';
export const BOARD_FONT_OPTIONS: ReadonlyArray<{ value: BoardFontFamily; label: string }> = [
  { value: 'default', label: 'Стандартный' },
  { value: 'caveat', label: 'Caveat' },
];

export const CAVEAT_FONT_FAMILY = 'Caveat, "Comic Sans MS", cursive';
export const DEFAULT_FONT_FAMILY = 'system-ui, sans-serif';

export function isBoardFontFamily(value: unknown): value is BoardFontFamily {
  return value === 'default' || value === 'caveat';
}

/** CSS value used by HTML controls. An empty string means "inherit the interface font". */
export function cssFontFamily(font: BoardFontFamily | null | undefined): string {
  return font === 'caveat' ? CAVEAT_FONT_FAMILY : '';
}

/** Font stack handed to Konva, which cannot inherit CSS. */
export function canvasFontFamily(font: BoardFontFamily | null | undefined): string {
  return font === 'caveat' ? CAVEAT_FONT_FAMILY : DEFAULT_FONT_FAMILY;
}

export function boardFontClass(font: BoardFontFamily | null | undefined): string {
  return font === 'caveat' ? 'font-caveat' : '';
}
