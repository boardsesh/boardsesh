/**
 * The pure rules behind the Android nav bar's hide-on-scroll: when a scroll
 * hides or shows it, where it may hide at all, and what closes the gate. No
 * React Native or Reanimated imports, so the bottom-chrome metrics and their
 * tests can read it. The shared value and the per-list memory live in
 * `tab-bar-visibility-store.ts`.
 */

/** Scroll travel in one direction, in dp, that hides or shows the bar. */
export const TAB_BAR_HIDE_SCROLL_THRESHOLD = 24;

/** What one list remembers between its scroll events. */
export type TabBarScrollSource = {
  /** The list's last reported offset. */
  lastOffset: number;
  /** Travel since the direction last changed: positive down, negative up. */
  travel: number;
};

export type TabBarScrollInput = {
  /** Whether the bar is hidden now. */
  hidden: boolean;
  /** This list's memory, or null when it has not scrolled since the last reset. */
  source: TabBarScrollSource | null;
  /** The offset this event reports. */
  offset: number;
  /** Whether the list's screen is the focused one. */
  focused: boolean;
  /** Whether hiding is allowed at all right now (the controller's gate). */
  enabled: boolean;
};

export type TabBarScrollDecision = {
  hidden: boolean;
  source: TabBarScrollSource;
};

/**
 * The pure rule. A list's first event after a reset only records where it is,
 * so switching Profile sub-tabs, or a list remounting at another offset, never
 * reads as a jump. Android keeps blurred tabs resident, so a list on a tab the
 * climber left can still report (a settling fling, a data reload): those events
 * only record their offset. Reaching the top always shows the bar.
 */
export function decideTabBarVisibility({
  hidden,
  source,
  offset,
  focused,
  enabled,
}: TabBarScrollInput): TabBarScrollDecision {
  const resting: TabBarScrollSource = { lastOffset: offset, travel: 0 };
  if (!focused || !enabled) return { hidden, source: resting };
  if (offset <= 0) return { hidden: false, source: resting };
  if (source === null) return { hidden, source: resting };
  const delta = offset - source.lastOffset;
  if (delta === 0) return { hidden, source };
  const sameDirection = source.travel !== 0 && Math.sign(delta) === Math.sign(source.travel);
  const travel = sameDirection ? source.travel + delta : delta;
  if (!hidden && travel >= TAB_BAR_HIDE_SCROLL_THRESHOLD) return { hidden: true, source: resting };
  if (hidden && travel <= -TAB_BAR_HIDE_SCROLL_THRESHOLD) return { hidden: false, source: resting };
  return { hidden, source: { lastOffset: offset, travel } };
}

export type HideOnScrollPlatformInput = {
  platformOS: string;
  isTablet: boolean;
  /** The `tab-bar-hide-on-scroll-kill` switch is NOT on. */
  flagEnabled: boolean;
};

/**
 * Where the bar overlays tab roots and may hide: Android phones with the flag on.
 * Not keyed on the UI variant: an Android dev or screenshot build can run Liquid
 * Glass and still draws this JS bar. Tablets keep their rail or in-flow bar.
 */
export function resolveHideOnScrollTabBar({ platformOS, isTablet, flagEnabled }: HideOnScrollPlatformInput): boolean {
  return platformOS === 'android' && !isTablet && flagEnabled;
}

export type HideOnScrollGateInput = {
  /** The JS bar overlays this route (`jsBarOverlaysContent` from the metrics). */
  barOverlaysContent: boolean;
  /** A tab's own top-level page, not a pushed sub-route or the player. */
  topLevelTab: boolean;
  /** A filter board that keeps its controls where the bar draws. */
  accessoryHiddenRoute: boolean;
  /** TalkBack, Switch Access or another service is on. */
  assistiveTechnology: boolean;
  keyboardOpen: boolean;
};

/** Whether scrolling may hide the bar right now. Any "no" pins it shown. */
export function hideOnScrollGateOpen({
  barOverlaysContent,
  topLevelTab,
  accessoryHiddenRoute,
  assistiveTechnology,
  keyboardOpen,
}: HideOnScrollGateInput): boolean {
  return barOverlaysContent && topLevelTab && !accessoryHiddenRoute && !assistiveTechnology && !keyboardOpen;
}
