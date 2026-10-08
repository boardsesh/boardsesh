import type { TextStyle, ViewStyle } from 'react-native';
import { borderRadius } from '../theme/tokens';

/**
 * One look for the small count badges on icon buttons (the tick count on the
 * play drawer's log button, the queue count on glass icon buttons).
 *
 * The count is set in `caption2` (11pt), the smallest size HIG Typography allows
 * on iOS and M3's labelSmall on Android; it used to be a hand-set 10pt. The box
 * is a FLOOR, not a fixed size, so the pill grows with Dynamic Type / the OS
 * font scale instead of clipping the digits, and the scale stops at 1.3x so a
 * badge never outgrows the 44pt button it sits on.
 */
export const COUNT_BADGE_MAX_FONT_SCALE = 1.3;

/** The badge's smallest size: one digit of 11pt text with room around it. */
export const COUNT_BADGE_MIN_SIZE = 18;

export const countBadgeBox = {
  minWidth: COUNT_BADGE_MIN_SIZE,
  minHeight: COUNT_BADGE_MIN_SIZE,
  borderRadius: borderRadius.full,
  paddingHorizontal: 4,
  alignItems: 'center',
  justifyContent: 'center',
} as const satisfies ViewStyle;

/** Weight only: the size and line height come from the `caption2` variant. */
export const countBadgeText = {
  fontWeight: '600',
} as const satisfies TextStyle;
