import { describe, it, expect } from 'vitest';
import {
  isTabsRoute,
  isClimbsTabRoute,
  isTopLevelTabRoute,
  isAccessorySurfaceRoute,
  isAccessoryHostRoute,
  isTabsChromeRoute,
} from '../route-segments';

describe('isTabsRoute', () => {
  it('is true anywhere inside the tab navigator', () => {
    expect(isTabsRoute(['(tabs)'])).toBe(true);
    expect(isTabsRoute(['(tabs)', 'climbs'])).toBe(true);
    expect(isTabsRoute(['(tabs)', 'profile'])).toBe(true);
  });

  it('is false outside the tab navigator', () => {
    expect(isTabsRoute(['auth'])).toBe(false);
    expect(isTabsRoute(['(modal)', 'session'])).toBe(false);
    expect(isTabsRoute([])).toBe(false);
  });
});

describe('isClimbsTabRoute', () => {
  it('is true on the Climbs tab and its sub-routes', () => {
    expect(isClimbsTabRoute(['(tabs)', 'climbs'])).toBe(true);
    expect(isClimbsTabRoute(['(tabs)', 'climbs', 'create'])).toBe(true);
  });

  it('is false on other tabs or outside the tabs group', () => {
    expect(isClimbsTabRoute(['(tabs)', 'boards'])).toBe(false);
    expect(isClimbsTabRoute(['(tabs)'])).toBe(false);
    expect(isClimbsTabRoute(['auth'])).toBe(false);
    expect(isClimbsTabRoute([])).toBe(false);
  });
});

describe('isTopLevelTabRoute', () => {
  it('is true on a tab index (≤ 2 segments deep under (tabs))', () => {
    expect(isTopLevelTabRoute(['(tabs)'])).toBe(true);
    expect(isTopLevelTabRoute(['(tabs)', 'home'])).toBe(true);
    expect(isTopLevelTabRoute(['(tabs)', 'climbs'])).toBe(true);
    expect(isTopLevelTabRoute(['(tabs)', 'profile'])).toBe(true);
  });

  it('is false on a pushed sub-route inside a tab (≥ 3 segments)', () => {
    expect(isTopLevelTabRoute(['(tabs)', 'climbs', 'create'])).toBe(false);
    expect(isTopLevelTabRoute(['(tabs)', 'climbs', '[climbUuid]'])).toBe(false);
    expect(isTopLevelTabRoute(['(tabs)', 'home', 'session', '[sessionId]'])).toBe(false);
    expect(isTopLevelTabRoute(['(tabs)', 'profile', 'more'])).toBe(false);
  });

  it('is false outside the tabs group', () => {
    expect(isTopLevelTabRoute(['play'])).toBe(false);
    expect(isTopLevelTabRoute(['gyms'])).toBe(false);
    expect(isTopLevelTabRoute(['auth', 'login'])).toBe(false);
    expect(isTopLevelTabRoute([])).toBe(false);
  });

  it('is false on the create-board / edit-board screens (regression test for #3298)', () => {
    // `boards` is a root Stack.Screen (app/_layout.tsx), not nested under `(tabs)`,
    // so its create/edit screens must never be treated as a top-level tab page.
    // Before #3253's allow-list rewrite, the accessory bar's route gate was a
    // deny-list (auth/gyms/player only) that let it fall through and show here,
    // overlapping BoardForm's pinned submit button (#3298).
    expect(isTopLevelTabRoute(['boards', 'create'])).toBe(false);
    expect(isTopLevelTabRoute(['boards', 'edit'])).toBe(false);
  });
});

// The JS queue toolbar's PRESENTATION gate. Deliberately narrower than
// isAccessoryHostRoute (the native host's MOUNT gate) — these cases stay put as the
// pin that #5055's fix moved the mount gate and left this one alone.
describe('isAccessorySurfaceRoute', () => {
  it('is true on a top-level tab page and under the player', () => {
    expect(isAccessorySurfaceRoute(['(tabs)', 'home'])).toBe(true);
    expect(isAccessorySurfaceRoute(['(tabs)', 'climbs'])).toBe(true);
    // Kept mounted (occluded) under the transparent player to avoid tab-bar churn.
    expect(isAccessorySurfaceRoute(['play'])).toBe(true);
  });

  it('is false on tab sub-routes and other root surfaces', () => {
    expect(isAccessorySurfaceRoute(['(tabs)', 'climbs', 'create'])).toBe(false);
    expect(isAccessorySurfaceRoute(['(tabs)', 'home', 'session', '[sessionId]'])).toBe(false);
    expect(isAccessorySurfaceRoute(['gyms'])).toBe(false);
    expect(isAccessorySurfaceRoute(['auth', 'login'])).toBe(false);
    expect(isAccessorySurfaceRoute([])).toBe(false);
  });

  it('is false on the create-board / edit-board screens (regression test for #3298)', () => {
    // Pins the JS PersistentQueueBar's mount gate off the create/edit board
    // screens — see the isTopLevelTabRoute case above for the full context.
    expect(isAccessorySurfaceRoute(['boards', 'create'])).toBe(false);
    expect(isAccessorySurfaceRoute(['boards', 'edit'])).toBe(false);
  });
});

describe('isAccessoryHostRoute', () => {
  // Where the native NativeTabs.BottomAccessory host must stay MOUNTED. Detaching it
  // while the iOS 26 tab bar is on screen leaves the docked role="search" Climbs item
  // on a stale frame, unhittable until a force-quit (#5055).
  it('is true anywhere the tab bar is on screen, pushed sub-routes included', () => {
    expect(isAccessoryHostRoute(['(tabs)', 'climbs'])).toBe(true);
    expect(isAccessoryHostRoute(['(tabs)', 'discover', '[playlist_uuid]'])).toBe(true);
    expect(isAccessoryHostRoute(['(tabs)', 'home', 'session', '[sessionId]'])).toBe(true);
    expect(isAccessoryHostRoute(['(tabs)', 'climbs', 'holds'])).toBe(true);
    // Kept mounted (occluded) under the transparent player, same as before.
    expect(isAccessoryHostRoute(['play'])).toBe(true);
  });

  it('is false on root pushes and modals, where the tab bar leaves too', () => {
    expect(isAccessoryHostRoute(['boards', 'create'])).toBe(false);
    expect(isAccessoryHostRoute(['auth', 'login'])).toBe(false);
    expect(isAccessoryHostRoute(['gyms'])).toBe(false);
    expect(isAccessoryHostRoute(['share-beta'])).toBe(false);
    expect(isAccessoryHostRoute([])).toBe(false);
  });

  it('agrees with isTabsChromeRoute on every route (the accessory lives in the bar)', () => {
    // The identity IS the contract: the host mounts exactly when the bar is up. A future
    // narrowing of one without the other is what re-breaks #5055, so pin them together.
    const routes: ReadonlyArray<readonly string[]> = [
      [],
      ['(tabs)'],
      ['(tabs)', 'home'],
      ['(tabs)', 'climbs'],
      ['(tabs)', 'climbs', 'create'],
      ['(tabs)', 'discover', '[playlist_uuid]'],
      ['(tabs)', 'discover', 'smart', '[type]'],
      ['(tabs)', 'profile', 'session', '[sessionId]'],
      ['play'],
      ['boards', 'create'],
      ['boards', 'edit'],
      ['auth', 'login'],
      ['gyms'],
      ['onboarding'],
    ];
    for (const segments of routes) {
      expect(isAccessoryHostRoute(segments)).toBe(isTabsChromeRoute(segments));
    }
  });
});
