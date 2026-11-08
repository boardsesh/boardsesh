import { describe, it, expect, vi, beforeEach } from 'vitest';

const timing = vi.hoisted(() => ({ calls: 0 }));

// The progress driver is the store's Reanimated half; a plain object stands in
// for the shared value, and `withTiming` returns its target so the value reads
// as where the slide ends.
vi.mock('react-native-reanimated', () => ({
  makeMutable: (value: number) => ({ value }),
  withTiming: (target: number) => {
    timing.calls += 1;
    return target;
  },
  Easing: { bezier: () => () => 0 },
}));

import {
  configureTabBarVisibility,
  getTabBarHidden,
  reportTabBarScroll,
  resetTabBarVisibility,
  resetTabBarVisibilityForTests,
  type TabBarScrollSourceSlot,
} from '../tab-bar-visibility-store';
import { tabBarHiddenProgress } from '../tab-bar-hide-progress';

const newSlot = (): TabBarScrollSourceSlot => ({ current: null });

/** One list scrolling through `offsets`. */
function scroll(slot: TabBarScrollSourceSlot, offsets: number[], focused = true) {
  for (const offset of offsets) reportTabBarScroll(slot, offset, focused);
}

describe('tab-bar visibility store', () => {
  beforeEach(() => {
    resetTabBarVisibilityForTests();
    tabBarHiddenProgress.value = 0;
    timing.calls = 0;
    configureTabBarVisibility({ enabled: true, reduceMotion: false });
  });

  it('slides the bar away on a scroll down and back on a scroll up', () => {
    const list = newSlot();
    scroll(list, [50, 80]);
    expect(getTabBarHidden()).toBe(true);
    expect(tabBarHiddenProgress.value).toBe(1);
    scroll(list, [40]);
    expect(getTabBarHidden()).toBe(false);
    expect(tabBarHiddenProgress.value).toBe(0);
  });

  it('writes the shared value only when the answer flips', () => {
    scroll(newSlot(), [50, 80, 120, 200, 300]);
    expect(timing.calls).toBe(1);
  });

  it('swaps instantly under Reduce Motion', () => {
    configureTabBarVisibility({ enabled: true, reduceMotion: true });
    scroll(newSlot(), [50, 80]);
    expect(tabBarHiddenProgress.value).toBe(1);
    expect(timing.calls).toBe(0);
  });

  it('ignores a background tab still scrolling', () => {
    scroll(newSlot(), [0, 400, 800], false);
    expect(getTabBarHidden()).toBe(false);
  });

  it('keeps each list its own offset, so a Profile sub-tab switch does not jump', () => {
    const progress = newSlot();
    const logbook = newSlot();
    scroll(progress, [20, 30]);
    // Logbook first reports far down the page: recorded, not a drop.
    scroll(logbook, [900]);
    expect(getTabBarHidden()).toBe(false);
    scroll(logbook, [930]);
    expect(getTabBarHidden()).toBe(true);
  });

  it('shows the bar on a route change, at once, and forgets every offset', () => {
    const list = newSlot();
    scroll(list, [50, 80]);
    timing.calls = 0;
    resetTabBarVisibility();
    expect(getTabBarHidden()).toBe(false);
    // No slide: the bar snaps in flow on a push, so the chrome snaps with it.
    expect(timing.calls).toBe(0);
    expect(tabBarHiddenProgress.value).toBe(0);
    // The old offset no longer counts: 80 -> 90 after the reset is a first event.
    scroll(list, [90]);
    expect(getTabBarHidden()).toBe(false);
  });

  it('pins the bar shown while the gate is closed (assistive tech, keyboard, flag off)', () => {
    const list = newSlot();
    scroll(list, [50, 80]);
    expect(getTabBarHidden()).toBe(true);
    configureTabBarVisibility({ enabled: false, reduceMotion: false });
    expect(getTabBarHidden()).toBe(false);
    expect(tabBarHiddenProgress.value).toBe(0);
    scroll(list, [200, 400]);
    expect(getTabBarHidden()).toBe(false);
  });
});
