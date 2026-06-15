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

/** True when the focused route lives inside the bottom-tab navigator. */
export function isTabsRoute(segments: Segments): boolean {
  return segments[0] === TABS_GROUP;
}

/** True when the focused route is the Climbs tab (or one of its sub-routes). */
export function isClimbsTabRoute(segments: Segments): boolean {
  return segments[0] === TABS_GROUP && segments[1] === CLIMBS_TAB;
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
