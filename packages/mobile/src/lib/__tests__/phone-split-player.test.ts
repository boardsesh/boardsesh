import { describe, expect, it } from 'vitest';
import type { ClimbQueueItem } from '@boardsesh/queue';
import {
  buildCarriedPaneTarget,
  resolveAppStackState,
  resolvePlayerSurface,
  resolveSplitRouteClose,
} from '../phone-split-player';

function queueItem(climbUuid: string): ClimbQueueItem {
  return {
    uuid: `queue-${climbUuid}`,
    climb: {
      uuid: climbUuid,
      name: climbUuid,
      frames: 'p1r12',
      setter_username: 'setter',
      angle: 40,
      ascensionist_count: 0,
      difficulty: 'V3',
      quality_average: '3.0',
      stars: 3,
      difficulty_error: '0.3',
      benchmark_difficulty: null,
    },
  };
}

describe('resolvePlayerSurface', () => {
  it('follows the tablet pane on a JS-shell tablet, off under the Wall display', () => {
    for (const tabsUncovered of [true, false]) {
      expect(
        resolvePlayerSurface({ tabletPane: true, phoneSplit: false, wallDisplayOpen: false, tabsUncovered }),
      ).toEqual({
        paneMounted: true,
        tapsOpenPane: true,
      });
      expect(
        resolvePlayerSurface({ tabletPane: true, phoneSplit: false, wallDisplayOpen: true, tabsUncovered }),
      ).toEqual({
        paneMounted: false,
        tapsOpenPane: false,
      });
      expect(
        resolvePlayerSurface({ tabletPane: false, phoneSplit: false, wallDisplayOpen: false, tabsUncovered }),
      ).toEqual({
        paneMounted: false,
        tapsOpenPane: false,
      });
    }
  });

  it('sends split taps to the pane while the tabs are on screen', () => {
    expect(
      resolvePlayerSurface({ tabletPane: false, phoneSplit: true, wallDisplayOpen: false, tabsUncovered: true }),
    ).toEqual({ paneMounted: true, tapsOpenPane: true });
  });

  it("sends split taps to /play while a screen's own content fills the pane", () => {
    expect(
      resolvePlayerSurface({
        tabletPane: false,
        phoneSplit: true,
        wallDisplayOpen: false,
        tabsUncovered: true,
        paneTaken: true,
      }),
    ).toEqual({ paneMounted: true, tapsOpenPane: false });
    // Never on iPad, where nothing takes the pane.
    expect(
      resolvePlayerSurface({
        tabletPane: true,
        phoneSplit: false,
        wallDisplayOpen: false,
        tabsUncovered: true,
        paneTaken: true,
      }),
    ).toEqual({ paneMounted: true, tapsOpenPane: true });
  });

  it('sends split taps to /play from a page over the tabs, keeping the pane underneath', () => {
    expect(
      resolvePlayerSurface({ tabletPane: false, phoneSplit: true, wallDisplayOpen: false, tabsUncovered: false }),
    ).toEqual({ paneMounted: true, tapsOpenPane: false });
  });
});

describe('resolveSplitRouteClose', () => {
  const overTabs = { phoneSplit: true, routeOnTop: true, routeOverTabs: true };

  it('closes an idle route the split now replaces', () => {
    expect(resolveSplitRouteClose({ ...overTabs, routeBusy: false })).toBe('close');
  });

  it('waits while the route has work open', () => {
    expect(resolveSplitRouteClose({ ...overTabs, routeBusy: true })).toBe('wait');
  });

  it('does nothing once the split is gone or the route already closed', () => {
    expect(resolveSplitRouteClose({ ...overTabs, phoneSplit: false, routeBusy: false })).toBe('none');
    expect(resolveSplitRouteClose({ ...overTabs, routeOnTop: false, routeBusy: true })).toBe('none');
  });

  it('leaves the player up over a page pushed over the tabs, which a close would reveal instead of the pane', () => {
    expect(resolveSplitRouteClose({ ...overTabs, routeOverTabs: false, routeBusy: false })).toBe('none');
  });
});

describe('resolveAppStackState', () => {
  const appStack = {
    key: 'app-stack',
    index: 1,
    routes: [{ name: '(tabs)' }, { name: 'play' }],
  };

  it("steps through expo-router's __root wrapper to the app's Stack", () => {
    // The shape `navigationRef.getRootState()` returns on a device (ExpoRoot's Content).
    const deviceRoot = { key: 'expo-root', index: 0, routes: [{ name: '__root', state: appStack }] };
    expect(resolveAppStackState(deviceRoot)).toBe(appStack);
  });

  it('is null while the app Stack under __root has not mounted', () => {
    expect(resolveAppStackState({ key: 'expo-root', index: 0, routes: [{ name: '__root' }] })).toBeNull();
    expect(resolveAppStackState(undefined)).toBeNull();
  });

  it('returns a root that is already the app Stack', () => {
    expect(resolveAppStackState(appStack)).toBe(appStack);
  });
});

describe('buildCarriedPaneTarget', () => {
  it("carries the route's live preview as a look", () => {
    const item = queueItem('swiped');
    const target = buildCarriedPaneTarget(
      { climbUuid: 'swiped', offsetY: 0, preview: { item, suggestionSource: null, isWallClimb: true } },
      7,
    );
    expect(target?.climb.uuid).toBe('swiped');
    expect(target?.nonce).toBe(7);
    expect(target?.options).toEqual({
      previewQueueItem: item,
      previewIsWallClimb: true,
      playlistSuggestionSource: null,
    });
    expect(target?.claimFirstApply?.()).toBe(false);
  });

  it('carries nothing when the route shows the current climb or is gone', () => {
    expect(buildCarriedPaneTarget({ climbUuid: 'current', offsetY: 40, preview: null }, 1)).toBeNull();
    expect(buildCarriedPaneTarget(null, 1)).toBeNull();
  });
});
