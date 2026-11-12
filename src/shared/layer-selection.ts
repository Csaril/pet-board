/**
 * Pointer-hit rules for board items (images, stickers and note markers).
 *
 * The board renders every visible layer in its normal order, but the GM edits
 * only the layer selected in the layers panel. Items on other layers stay
 * visible and keep their z-index; they simply stop participating in hit
 * testing, so a frame on a higher layer cannot swallow clicks aimed at the
 * active layer below it.
 *
 * Players keep the pre-existing behaviour: the active layer is a local GM
 * setting and is not used to restrict player interactions.
 */
export type BoardRole = 'gm' | 'player' | undefined;

/**
 * Whether an item on `layerId` may receive pointer events for the given role.
 * Locking is deliberately not part of this rule: locked and active layers are
 * independent, and a locked active layer still exposes its items for selection
 * so the GM can see the lock state. Editing is blocked separately.
 */
export function isLayerPickable(role: BoardRole, layerId: string, activeLayerId: string | undefined): boolean {
  if (role !== 'gm') return true;
  return Boolean(activeLayerId) && layerId === activeLayerId;
}
