// Typed helpers for reading expo-router's focused-route segments.
//
// `useSegments()` returns a route-typed tuple (e.g. `['(tabs)', 'climbs']`).
// Casting it to `string[]` to probe an index silently discards that typing and
// would let a wrong index slip through if the route tree changes. These helpers
// instead accept the segments as a `readonly string[]` — the tuple widens to it
// safely — and centralise the "which surface am I on" checks so callers never
// index raw segment positions.

type Segments = readonly string[];

const TABS_GROUP = '(tabs)';
const CLIMBS_TAB = 'climbs';
const PLAYER_ROUTE = 'play';
const PROFILE_TAB = 'profile';
const OUTLINE_CANVAS_ROUTE = 'outline-canvas';

/** True when the focused route lives inside the bottom-tab navigator. */
export function isTabsRoute(segments: Segments): boolean {
  return segments[0] === TABS_GROUP;
}

/**
 * True when the native bottom tab CHROME (the tab bar) is present and STABLE — on any
 * route inside the tabs (including pushed sub-routes, which keep the tab bar), OR under
 * the player route (`/play`).
 *
 * The player is a `transparentModal` (app/_layout.tsx): the tabs screen stays LIVE
 * behind it, so UIKit never snapshots the presenting view controller. That lets the
 * tab-bar metrics stay put across the player's open/close instead of churning.
 *
 * Drives the tab-bar height/padding in `useBottomChromeMetrics`. NOTE: this is the
 * *tab bar* gate, not the accessory gate — the bottom accessory mounts only on a
 * top-level tab page (see `isAccessorySurfaceRoute`), which is a stricter surface.
 */
export function isTabsChromeRoute(segments: Segments): boolean {
  return segments[0] === TABS_GROUP || segments[0] === PLAYER_ROUTE;
}

/** True when the focused route is the Climbs tab (or one of its sub-routes). */
export function isClimbsTabRoute(segments: Segments): boolean {
  return segments[0] === TABS_GROUP && segments[1] === CLIMBS_TAB;
}

/**
 * True only on a tab's own top-level page — its index (`/(tabs)/home`,
 * `/(tabs)/climbs`, …), never a pushed sub-route inside that tab (session detail,
 * settings, climb filters, the climb redirector). A tab index is the only route
 * that's ≤ 2 segments deep under `(tabs)` (`['(tabs)']` or `['(tabs)', '<tab>']`);
 * every sub-route is `['(tabs)', '<tab>', …]` (≥ 3). The current-climb accessory
 * bar shows only on these top-level tab surfaces.
 */
export function isTopLevelTabRoute(segments: Segments): boolean {
  return segments[0] === TABS_GROUP && segments.length <= 2;
}

/**
 * True when the full-screen now-playing player route (`/play`) is focused.
 *
 * The player is a self-contained surface with its own queue UI. On iOS the native
 * bottom accessory is deliberately kept mounted under the transparent player (see
 * `isAccessorySurfaceRoute`) and stays occluded behind it, so nothing doubles and the
 * tab-bar height doesn't churn.
 */
export function isPlayerRoute(segments: Segments): boolean {
  return segments[0] === PLAYER_ROUTE;
}

/**
 * True on the surfaces where the current-climb bottom accessory should be MOUNTED:
 * a top-level tab page, OR under the player (`/play`).
 *
 * The player is a `transparentModal` over the live tabs, so the accessory stays
 * mounted-but-occluded under it; unmounting there would churn the native tab-bar
 * height and shove the docked Climbs search field (see `isTabsChromeRoute`). Pushed
 * tab sub-routes and other root pushes/modals are NOT accessory surfaces — the bar
 * is hidden there.
 */
export function isAccessorySurfaceRoute(segments: Segments): boolean {
  return isTopLevelTabRoute(segments) || isPlayerRoute(segments);
}

/**
 * The focused tab's route segment (e.g. `'climbs'`), or `null` when the focused
 * route is not inside the tab navigator. Segment 0 is the `(tabs)` group, so the
 * tab name is segment 1. Used by the iPad sidebar to highlight the active row
 * without indexing the route-typed tuple directly.
 */
export function tabsActiveSegment(segments: Segments): string | null {
  return isTabsRoute(segments) ? (segments[1] ?? null) : null;
}

/**
 * True on the admin hold-outline canvas (`/(tabs)/profile/outline-canvas`).
 *
 * The editor is a full-bleed drawing surface: on a regular-width iPad the shell
 * suppresses BOTH trailing panes for it (the detail/play pane and the wall
 * column) so the board gets the whole content area, the same redundancy rule the
 * "On the Wall" destination uses. The sidebar stays — this is a wider canvas, not
 * a modal.
 */
export function isOutlineEditorRoute(segments: Segments): boolean {
  return segments[0] === TABS_GROUP && segments[1] === PROFILE_TAB && segments[2] === OUTLINE_CANVAS_ROUTE;
}
