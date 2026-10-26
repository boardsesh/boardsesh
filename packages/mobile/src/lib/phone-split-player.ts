import type { Climb } from '@boardsesh/shared-schema';
import type { PlayDrawerOpenTarget } from '../components/play-drawer/play-drawer-types';
import type { RoutePlayerSnapshot } from '../components/play-drawer/route-player-handoff';

/**
 * Where the player lives while the phone split (iPhone Duo open in landscape) or
 * the iPad pane is up. Pure, so the drawer host's rules unit-test without
 * navigation.
 *
 * - `paneMounted`: a pane is on screen in the tab content, so its selection is
 *   worth keeping.
 * - `tapsOpenPane`: a climb tap drives that pane instead of the `/play` route.
 *   In the split, only while the tabs are what the climber sees: a root page
 *   pushed over them (a profile, a setter page) hides the pane, so a tap there
 *   opens `/play` instead of changing a pane nobody can see.
 *
 * The iPad answer is the old one: `tabletPane` and not on the wall tab, for both.
 */
export function resolvePlayerSurface({
  tabletPane,
  phoneSplit,
  onWallTab,
  tabsUncovered,
}: {
  tabletPane: boolean;
  phoneSplit: boolean;
  onWallTab: boolean;
  tabsUncovered: boolean;
}): { paneMounted: boolean; tapsOpenPane: boolean } {
  return {
    paneMounted: (tabletPane || phoneSplit) && !onWallTab,
    tapsOpenPane: (tabletPane || (phoneSplit && tabsUncovered)) && !onWallTab,
  };
}

/**
 * What to do with a `/play` route that was up when the split appeared: close it
 * so the pane takes over, wait while it has work open (a tick being typed, a
 * sheet up), or nothing (the split went away again, or the route already closed).
 */
export function resolveSplitRouteClose({
  phoneSplit,
  routeOnTop,
  routeBusy,
}: {
  phoneSplit: boolean;
  routeOnTop: boolean;
  routeBusy: boolean;
}): 'close' | 'wait' | 'none' {
  if (!phoneSplit || !routeOnTop) return 'none';
  return routeBusy ? 'wait' : 'close';
}

/**
 * The pane target that keeps the climb the route was showing: its live preview,
 * after any swipes, as a look rather than a fresh pick (`claimFirstApply` never
 * claims, so nothing lights or commits). Null when the route shows the queue's
 * current climb, which the pane shows by itself.
 */
export function buildCarriedPaneTarget(
  snapshot: RoutePlayerSnapshot | null,
  nonce: number,
): PlayDrawerOpenTarget | null {
  const preview = snapshot?.preview;
  if (!preview?.item.climb) return null;
  return {
    // The queue's climb is the wide shape; the preview item already passed for a
    // schema climb when the route opened it (same cast as PreSessionView).
    climb: preview.item.climb as Climb,
    options: {
      previewQueueItem: preview.item,
      previewIsWallClimb: preview.isWallClimb,
      playlistSuggestionSource: preview.suggestionSource,
    },
    nonce,
    claimFirstApply: () => false,
  };
}
