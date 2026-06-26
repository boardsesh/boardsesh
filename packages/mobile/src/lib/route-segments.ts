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
const RECORD_TAB = 'record';
const HOME_TAB = 'home';
const PROFILE_TAB = 'profile';
const DISCOVER_TAB = 'discover';
const GYMS_ROUTE = 'gyms';
const AUTH_GROUP = 'auth';
const PLAYER_ROUTE = 'play';

// Tabs where the user is browsing rather than working a board: the feed,
// their profile, and playlist discovery. The persistent now-playing bar is
// demoted/hidden here when it's only a local queue (nothing lit). Telemetry:
// these surfaces drive ~2:1 the navigation of the board tabs but only ~17% of
// accessory-bar opens, so a queue-only bar there is mostly noise.
const SOCIAL_TABS: ReadonlySet<string> = new Set([HOME_TAB, PROFILE_TAB, DISCOVER_TAB]);
// Tabs where the user is actively discovering/controlling climbs on the board,
// so the active-climb shortcut earns its place even when nothing is lit yet.
const BOARD_CONTROL_TABS: ReadonlySet<string> = new Set([CLIMBS_TAB, RECORD_TAB]);

/** True when the focused route lives inside the bottom-tab navigator. */
export function isTabsRoute(segments: Segments): boolean {
  return segments[0] === TABS_GROUP;
}

/**
 * True when the native bottom tab chrome (tab bar + `NativeTabs.BottomAccessory` +
 * the search field) should stay mounted and STABLE — inside the tabs, OR under the
 * player route (`/play`).
 *
 * The player is a `transparentModal` (app/_layout.tsx): the tabs screen stays LIVE
 * behind it, so UIKit never snapshots the presenting view controller. That lets the
 * accessory + tab-bar metrics stay put across the player's open/close instead of
 * churning — keeping the host mounted under a transparent modal is snapshot-free
 * (no doubled climb name) AND avoids the native tab-bar height change that would
 * otherwise shove the docked Climbs search field.
 *
 * Used by `useInsideTabs` (the accessory host mount gate) and `useBottomChromeMetrics`
 * (the underlying-screen layout). Other root surfaces (boards / share-beta /
 * onboarding) are NOT included — they're opaque pushes/modals that should still
 * unmount the accessory.
 */
export function isTabsChromeRoute(segments: Segments): boolean {
  return segments[0] === TABS_GROUP || segments[0] === PLAYER_ROUTE;
}

/**
 * True when the focused route is the sign-in / sign-up flow (`/auth/*`). The user
 * isn't signed in there, so the persistent climb accessory has nothing to act on
 * and shouldn't float over the login screen.
 */
export function isAuthRoute(segments: Segments): boolean {
  return segments[0] === AUTH_GROUP;
}

/** True when the focused route is the Climbs tab (or one of its sub-routes). */
export function isClimbsTabRoute(segments: Segments): boolean {
  return segments[0] === TABS_GROUP && segments[1] === CLIMBS_TAB;
}

/**
 * True on the social/browsing tabs (home / profile / discover), keyed on the tab
 * root so sub-routes (e.g. a playlist detail) inherit the classification. Used to
 * hide the queue-only ("up next") accessory bar where it reads as a directive
 * rather than a board-control shortcut.
 */
export function isSocialSurface(segments: Segments): boolean {
  return segments[0] === TABS_GROUP && SOCIAL_TABS.has(segments[1] ?? '');
}

/**
 * True on the board-control tabs (climbs / record), where the active-climb
 * shortcut is heavily used and is kept even when nothing is lit yet.
 */
export function isBoardControlSurface(segments: Segments): boolean {
  return segments[0] === TABS_GROUP && BOARD_CONTROL_TABS.has(segments[1] ?? '');
}

/**
 * True when the focused route is the gym-discovery map screen (`/gyms`). The
 * map owns the whole screen there, so the persistent climb accessory is hidden
 * to keep it from overlapping the map + bottom sheet.
 */
export function isGymDiscoveryRoute(segments: Segments): boolean {
  return segments[0] === GYMS_ROUTE;
}

/**
 * True when the full-screen now-playing player route (`/play`) is focused. The
 * player is a self-contained surface with its own queue UI, so the persistent
 * climb accessory / queue bar must not float over it.
 *
 * On iOS the native bottom accessory is deliberately kept mounted under the
 * transparent player (see `isTabsChromeRoute`) and stays occluded behind it, so
 * the JS bar is already suppressed there via `nativeAccessoryMounted`. Android
 * has no native accessory, so the JS bar needs this explicit gate or it shows
 * over the player.
 */
export function isPlayerRoute(segments: Segments): boolean {
  return segments[0] === PLAYER_ROUTE;
}
