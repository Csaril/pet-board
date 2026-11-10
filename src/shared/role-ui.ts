/**
 * Visibility rule for elements marked with the `gm-only` class.
 *
 * Most GM controls must follow the role: visible for the GM, hidden for
 * players. Floating panels that the GM opens and closes manually must keep
 * their local visibility instead, so a shared room-state broadcast can never
 * open or close them.
 */
export type AppRole = 'gm' | 'player';

export interface GmOnlyElementState {
  /** The element's visibility is controlled only by local user actions. */
  manual: boolean;
  /** Current local hidden state; only used for manually controlled elements. */
  hidden: boolean;
}

export function shouldHideGmOnlyElement(role: AppRole, state: GmOnlyElementState): boolean {
  if (role !== 'gm') return true;
  return state.manual ? state.hidden : false;
}
