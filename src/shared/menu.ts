export interface MenuAnchor {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface MenuSize {
  width: number;
  height: number;
}

export interface ViewportSize {
  width: number;
  height: number;
}

export interface PopoverPlacement {
  left: number;
  top: number;
  side: 'top' | 'bottom';
  align: 'left' | 'right';
}

export interface PopoverOptions {
  gap?: number;
  margin?: number;
  align?: 'left' | 'right' | 'auto';
}

/**
 * Places a custom menu next to its trigger inside the viewport. The menu opens
 * below by default, flips above when there is not enough room, and is clamped
 * to the viewport margins on both axes.
 */
export function placePopover(
  anchor: MenuAnchor,
  size: MenuSize,
  viewport: ViewportSize,
  options: PopoverOptions = {},
): PopoverPlacement {
  const gap = Math.max(0, options.gap ?? 8);
  const margin = Math.max(0, options.margin ?? 12);
  const preferred = options.align ?? 'auto';
  const maxLeft = Math.max(margin, viewport.width - size.width - margin);

  let align: 'left' | 'right';
  if (preferred === 'right') align = 'right';
  else if (preferred === 'left') align = 'left';
  else align = anchor.left + size.width <= viewport.width - margin ? 'left' : 'right';

  let left = align === 'left' ? anchor.left : anchor.right - size.width;
  if (align === 'right' && left < margin) {
    // A right-aligned menu that no longer fits should still stay readable.
    align = 'left';
    left = anchor.left;
  }
  left = Math.min(Math.max(left, margin), maxLeft);

  const below = anchor.bottom + gap;
  const above = anchor.top - gap - size.height;
  let side: 'top' | 'bottom' = 'bottom';
  let top = below;
  if (below + size.height > viewport.height - margin && above >= margin) {
    side = 'top';
    top = above;
  } else if (below + size.height > viewport.height - margin) {
    top = Math.max(margin, viewport.height - size.height - margin);
  }

  return { left, top, side, align };
}

/**
 * Returns true when `menu` is `container` itself or lives inside it. Menus can
 * be nested when a topbar group with its own dropdown is moved into the "Ещё"
 * overflow menu: opening the nested menu must keep its ancestor open, otherwise
 * the browser renders it inside a `display: none` subtree.
 */
export function menuIsWithin(
  container: { contains(node: unknown): boolean } | null | undefined,
  menu: unknown,
): boolean {
  return Boolean(container && container.contains(menu));
}

/**
 * Decides how many trailing topbar groups must move into the "Ещё" menu.
 * Widths are measured without the "Ещё" trigger, while `available` is the
 * width left for the groups themselves (the trigger sits in a sibling tail).
 */
export function overflowGroupCount(groupWidths: number[], available: number, gap = 0): number {
  let used = 0;
  for (let index = 0; index < groupWidths.length; index += 1) {
    used += groupWidths[index]! + (index > 0 ? gap : 0);
    if (used > available) {
      // Move this group and every group after it.
      return groupWidths.length - index;
    }
  }
  return 0;
}
