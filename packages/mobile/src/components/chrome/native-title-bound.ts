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
/** A custom glass island's slot, plus UIKit's padding inside its glass on each side. */
const CUSTOM_SLOT_WIDTH = 38;
const CUSTOM_ISLAND_PADDING = 2 * spacing[1];

/**
 * What one side of the bar holds. `nativeItems` counts every item in the native
 * group, a custom view that shares its glass included (the glass bulb);
 * `titleItems` how many of those are title-only; `customSlots` the slots of a
 * custom glass island on its own (the avatar and +, in a horizontal bar).
 */
export type NativeBarSide = { nativeItems?: number; titleItems?: number; customSlots?: number };

/** The width one side's items take, edge to edge of their glass. */
export function nativeBarSideWidth({ nativeItems = 0, titleItems = 0, customSlots = 0 }: NativeBarSide): number {
  const native =
    nativeItems > 0
      ? NATIVE_BAR_ITEM_WIDTH + (nativeItems - 1) * NATIVE_BAR_ITEM_STEP + titleItems * NATIVE_TITLE_ITEM_ALLOWANCE
      : 0;
  const custom = customSlots > 0 ? customSlots * CUSTOM_SLOT_WIDTH + CUSTOM_ISLAND_PADDING : 0;
  return native + custom + (native > 0 && custom > 0 ? TITLE_VIEW_SPACING : 0);
}

/**
 * `nativeTitleMaxWidth` for a bar of native items. Each side gives up its
 * safe-area inset, the bar margin, its items' width and UIKit's title-view
 * clearance. Climbs on an iPhone 17 Pro (402pt), with the glass avatar and +
 * leading and history and ⋯ trailing, leaves 161pt; an adjustable angle beside
 * history takes it down to 92pt.
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

/**
 * The narrowest the on-the-wall capsule may get: its compact form (no avatar,
 * `HeaderStatusCapsule` drops it under 100pt) with about six letters of the
 * climb and the grade. Below this it would read as a grade with no name, so the
 * chrome moves the angle into the list menu to make room.
 */
export const CENTER_CONTENT_MIN_WIDTH = 96;

/**
 * Where a trailing native item sits, `positionFromEnd` items in from the
 * trailing edge (0 is the last one): its glyph's 44pt box, from the frame's
 * left. For the showcase recorder, which cannot measure a UIKit item.
 */
export function nativeTrailingItemLeft(frameWidth: number, insetRight: number, positionFromEnd: number): number {
  return frameWidth - insetRight - TOOLBAR_SIDE_MARGIN - NATIVE_BAR_ITEM_WIDTH - positionFromEnd * NATIVE_BAR_ITEM_STEP;
}
