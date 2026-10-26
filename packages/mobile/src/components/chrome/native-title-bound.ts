import { TOOLBAR_SIDE_MARGIN } from '../../theme/layout';
import { spacing } from '../../theme/tokens';

/** Widest the custom title gets, so a wide frame never shows a banner-length pill. */
export const CENTER_CONTENT_MAX_WIDTH = 280;

/** Clearance UIKit keeps between a title view and the bar-item groups beside it. */
const TITLE_VIEW_SPACING = 12;

/**
 * The widest a custom title view (the on-the-wall capsule) may be between the
 * native bar's two action groups.
 *
 * UIKit centres a title view that fits between the groups and slides one that
 * doesn't sideways until it clears both: in the #6367 feedback screenshot a
 * 188pt capsule sat at x124→312 instead of centred at 107→295. So the bound is
 * the room between the groups, not twice the wider one. Each side gives up its
 * safe-area inset, the bar margin, its group, the group background's padding on
 * both of the group's sides, and UIKit's title-view clearance. A slot a group
 * drops (the angle on a fixed-angle wall) goes to the title.
 */
export function nativeTitleMaxWidth(
  frameWidth: number,
  insets: { left: number; right: number },
  groups: { leading: number; trailing: number },
): number {
  // UIKit's padding inside a grouped bar-item background, on each side of the group.
  const groupBackgroundPadding = spacing[1];
  const freeWidth =
    frameWidth -
    (insets.left + groups.leading) -
    (insets.right + groups.trailing) -
    2 * (TOOLBAR_SIDE_MARGIN + 2 * groupBackgroundPadding) -
    2 * TITLE_VIEW_SPACING;
  return Math.min(CENTER_CONTENT_MAX_WIDTH, Math.max(0, freeWidth));
}

/**
 * Native UIKit bar items (`root-bar-items.ts`) are wider than the custom
 * capsules' 38pt slots. Measured on an iPhone 17 Pro (iOS 26): one item's glass
 * is 44pt; two items sharing a background span 101pt; two separate items sit
 * 12pt apart (100pt). So each item past the first adds 57pt either way.
 */
export const NATIVE_BAR_ITEM_WIDTH = 44;
const NATIVE_BAR_ITEM_STEP = 57;
/**
 * A title-only item ("40°") is wider than a glyph: about 32pt of semibold
 * digits plus UIKit's padding. The allowance rounds that up.
 */
const NATIVE_TITLE_ITEM_ALLOWANCE = 12;

/** What one side of the bar holds: every item, and how many of them are title-only. */
export type NativeBarSide = { items: number; titleItems?: number };

/** The width one side's native items take, edge to edge of their glass. */
export function nativeBarSideWidth({ items, titleItems = 0 }: NativeBarSide): number {
  if (items <= 0) return 0;
  return NATIVE_BAR_ITEM_WIDTH + (items - 1) * NATIVE_BAR_ITEM_STEP + titleItems * NATIVE_TITLE_ITEM_ALLOWANCE;
}

/**
 * `nativeTitleMaxWidth` for native bar items. Each side gives up its safe-area
 * inset, the bar margin, its items' measured width and UIKit's title-view
 * clearance; UIKit draws the items' glass, so no group padding is added. On an
 * iPhone 17 Pro (402pt) with two items a side this leaves 144pt, so the
 * on-the-wall capsule ellipsizes instead of running under history.
 */
export function nativeItemsTitleMaxWidth(
  frameWidth: number,
  insets: { left: number; right: number },
  sides: { leading: NativeBarSide; trailing: NativeBarSide },
): number {
  const freeWidth =
    frameWidth -
    (insets.left + nativeBarSideWidth(sides.leading)) -
    (insets.right + nativeBarSideWidth(sides.trailing)) -
    2 * TOOLBAR_SIDE_MARGIN -
    2 * TITLE_VIEW_SPACING;
  return Math.min(CENTER_CONTENT_MAX_WIDTH, Math.max(0, freeWidth));
}
