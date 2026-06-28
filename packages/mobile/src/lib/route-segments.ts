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
const GYMS_ROUTE = 'gyms';
const AUTH_GROUP = 'auth';
const PLAYER_ROUTE = 'play';
const BOARDS_ROUTE = 'boards';

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

/**
 * True anywhere inside the boards stack (`/boards/*` — the picker `index`, the
 * `create` / `edit` builder, and `manage`). This stack is presented as a modal
 * over the tabs, so the root-mounted persistent climb bar would float on top of
 * it — directly over the builder's pinned create button. The climb toolbar has
 * nothing to act on while you're choosing or building a board, so it's
 * suppressed across the whole stack.
 */
export function isBoardsRoute(segments: Segments): boolean {
  return segments[0] === BOARDS_ROUTE;
}
