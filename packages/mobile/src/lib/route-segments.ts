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

/** True when the focused route lives inside the bottom-tab navigator. */
export function isTabsRoute(segments: Segments): boolean {
  return segments[0] === TABS_GROUP;
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
