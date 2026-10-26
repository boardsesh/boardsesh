import type { Climb } from '@boardsesh/shared-schema';
import type { PlayDrawerOpenTarget } from '../components/play-drawer/play-drawer-types';
import type { RoutePlayerSnapshot } from '../components/play-drawer/route-player-handoff';

/**
 * Where the player lives while the phone split (iPhone Duo open in landscape) or
 * the JS tablet shell's pane is up. Pure, so the drawer host's rules unit-test
 * without navigation. The native iPad has neither: every tap opens `/play`.
 *
 * - `paneMounted`: a pane is on screen in the tab content, so its selection is
 *   worth keeping.
 * - `tapsOpenPane`: a climb tap drives that pane instead of the `/play` route.
 *   In the split, only while the climber can see the player there: a root page
 *   pushed over the tabs (a profile, a setter page) hides the pane, and a screen
 *   can fill the pane with its own content (the workout preview while one is
 *   built), so a tap then opens `/play` instead of changing an unseen player.
 *
 * The tablet shell's answer is `tabletPane` and not on the wall tab, for both.
 */
export function resolvePlayerSurface({
  tabletPane,
  phoneSplit,
  onWallTab,
  tabsUncovered,
  paneTaken = false,
}: {
  tabletPane: boolean;
  phoneSplit: boolean;
  onWallTab: boolean;
  tabsUncovered: boolean;
  /** A screen's own content fills the split's pane (`usePhoneSplitPaneTaken`). */
  paneTaken?: boolean;
}): { paneMounted: boolean; tapsOpenPane: boolean } {
  return {
    paneMounted: (tabletPane || phoneSplit) && !onWallTab,
    tapsOpenPane: (tabletPane || (phoneSplit && tabsUncovered && !paneTaken)) && !onWallTab,
  };
}

/**
 * What to do with a `/play` route that was up when the split appeared: close it
 * so the pane takes over, wait while it has work open (a tick being typed, a
 * sheet up), or nothing. Nothing when the split went away again, the route
 * already closed, or the route sits on a page pushed over the tabs (a profile):
 * closing it there would show that page, not the pane, so the player stays up.
 */
export function resolveSplitRouteClose({
  phoneSplit,
  routeOnTop,
  routeOverTabs,
  routeBusy,
}: {
  phoneSplit: boolean;
  routeOnTop: boolean;
  /** The route directly under `/play` is the tabs. */
  routeOverTabs: boolean;
  routeBusy: boolean;
}): 'close' | 'wait' | 'none' {
  if (!phoneSplit || !routeOnTop || !routeOverTabs) return 'none';
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
