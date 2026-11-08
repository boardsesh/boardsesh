import { describe, it, expect } from 'vitest';
import {
  TAB_BAR_HIDE_SCROLL_THRESHOLD,
  decideTabBarVisibility,
  hideOnScrollGateOpen,
  resolveHideOnScrollTabBar,
  type TabBarScrollSource,
} from '../tab-bar-visibility';

const OPEN = { focused: true, enabled: true } as const;

/** Feeds offsets through the rule the way one list would, from a fresh source. */
function scrollThrough(offsets: number[], startHidden = false) {
  let hidden = startHidden;
  let source: TabBarScrollSource | null = null;
  for (const offset of offsets) {
    const decision = decideTabBarVisibility({ ...OPEN, hidden, source, offset });
    hidden = decision.hidden;
    source = decision.source;
  }
  return { hidden, source };
}

describe('decideTabBarVisibility', () => {
  it('hides after 24dp of downward travel, not before', () => {
    expect(scrollThrough([100, 100 + TAB_BAR_HIDE_SCROLL_THRESHOLD - 1]).hidden).toBe(false);
    expect(scrollThrough([100, 100 + TAB_BAR_HIDE_SCROLL_THRESHOLD]).hidden).toBe(true);
  });

  it('adds up small steps in one direction', () => {
    expect(scrollThrough([100, 108, 116, 124]).hidden).toBe(true);
  });

  it('starts over when the direction changes', () => {
    // 20 down, 10 up, 20 down: never 24 in a row.
    expect(scrollThrough([100, 120, 110, 130]).hidden).toBe(false);
  });

  it('shows after 24dp of upward travel', () => {
    expect(scrollThrough([300, 300 - TAB_BAR_HIDE_SCROLL_THRESHOLD + 1], true).hidden).toBe(true);
    expect(scrollThrough([300, 300 - TAB_BAR_HIDE_SCROLL_THRESHOLD], true).hidden).toBe(false);
  });

  it('shows at the top, whatever the travel', () => {
    expect(scrollThrough([10, 0], true).hidden).toBe(false);
    expect(scrollThrough([0], true).hidden).toBe(false);
  });

  it("only records a list's first event, so a sub-tab switch never reads as a jump", () => {
    // Progress was scrolled to 40; Logbook mounts at 900. Its first event is
    // not a 860dp drop.
    const first = decideTabBarVisibility({ ...OPEN, hidden: false, source: null, offset: 900 });
    expect(first.hidden).toBe(false);
    expect(first.source).toEqual({ lastOffset: 900, travel: 0 });
    // A shown bar stays shown, a hidden one stays hidden.
    expect(decideTabBarVisibility({ ...OPEN, hidden: true, source: null, offset: 900 }).hidden).toBe(true);
  });

  it('ignores events from a screen that is not focused (resident Android tabs)', () => {
    const source = { lastOffset: 100, travel: 20 };
    const decision = decideTabBarVisibility({ hidden: false, source, offset: 400, focused: false, enabled: true });
    expect(decision.hidden).toBe(false);
    // Only the offset is kept, so focusing it later starts from where it is.
    expect(decision.source).toEqual({ lastOffset: 400, travel: 0 });
  });

  it('never hides with the gate closed', () => {
    const source = { lastOffset: 100, travel: 0 };
    expect(decideTabBarVisibility({ hidden: false, source, offset: 500, focused: true, enabled: false }).hidden).toBe(
      false,
    );
  });
});

describe('resolveHideOnScrollTabBar', () => {
  it('is on for Android phones with the flag on', () => {
    expect(resolveHideOnScrollTabBar({ platformOS: 'android', isTablet: false, flagEnabled: true })).toBe(true);
  });

  it('pins the bar with the flag off', () => {
    expect(resolveHideOnScrollTabBar({ platformOS: 'android', isTablet: false, flagEnabled: false })).toBe(false);
  });

  it('is off on tablets, iOS and the web', () => {
    expect(resolveHideOnScrollTabBar({ platformOS: 'android', isTablet: true, flagEnabled: true })).toBe(false);
    expect(resolveHideOnScrollTabBar({ platformOS: 'ios', isTablet: false, flagEnabled: true })).toBe(false);
    expect(resolveHideOnScrollTabBar({ platformOS: 'web', isTablet: false, flagEnabled: true })).toBe(false);
  });
});

describe('hideOnScrollGateOpen', () => {
  const open = {
    barOverlaysContent: true,
    topLevelTab: true,
    accessoryHiddenRoute: false,
    assistiveTechnology: false,
    keyboardOpen: false,
  };

  it('opens on an overlaid tab root', () => {
    expect(hideOnScrollGateOpen(open)).toBe(true);
  });

  it('pins the bar while TalkBack or another assistive service is on', () => {
    expect(hideOnScrollGateOpen({ ...open, assistiveTechnology: true })).toBe(false);
  });

  it('pins the bar with the keyboard open, on filter boards, sub-routes and in-flow bars', () => {
    expect(hideOnScrollGateOpen({ ...open, keyboardOpen: true })).toBe(false);
    expect(hideOnScrollGateOpen({ ...open, accessoryHiddenRoute: true })).toBe(false);
    expect(hideOnScrollGateOpen({ ...open, topLevelTab: false })).toBe(false);
    // Flag off, tablet or iOS: the metrics never overlay, so the gate stays shut.
    expect(hideOnScrollGateOpen({ ...open, barOverlaysContent: false })).toBe(false);
  });
});
