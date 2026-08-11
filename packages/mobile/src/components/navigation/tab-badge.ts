/**
 * Record-tab badge state, carried on React Navigation's `tabBarBadge` screen
 * option.
 *
 * `tabBarBadge` is typed `string | number` (display text on the stock bar), but
 * `MaterialTabBar` draws the badge as a colour DOT with no text — the value is
 * never rendered, it only selects the dot colour. That makes the option the one
 * per-screen channel available for the state, at the cost of an implicit
 * producer/consumer contract, so both ends go through this module:
 *
 * - producer: the Record `Tabs.Screen` in `app/(tabs)/_layout.tsx`
 * - consumer: `isLiveTabBadge` in `MaterialTabBar.tsx`
 *
 * Record is the only screen that sets a badge. If another screen ever needs one,
 * give it a value from here (or extend the union) rather than a bare string — a
 * badge value that isn't `TAB_BADGE_LIVE` renders in the standard colour, and a
 * numeric count would render as a plain dot because this bar draws no badge text.
 */

/** A live party session is running. */
export const TAB_BADGE_LIVE = 'live';

/** A board is connected over Bluetooth, no live session. */
export const TAB_BADGE_CONNECTED = 'connected';

export type TabBadgeState = typeof TAB_BADGE_LIVE | typeof TAB_BADGE_CONNECTED;

/** The single place the live badge value is compared. Any other badge value
 *  (including a future count) keeps the standard connected colour. */
export function isLiveTabBadge(badge: unknown): boolean {
  return badge === TAB_BADGE_LIVE;
}
