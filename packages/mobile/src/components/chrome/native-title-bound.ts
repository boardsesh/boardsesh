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
