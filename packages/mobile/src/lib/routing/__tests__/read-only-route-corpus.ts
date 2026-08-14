// The route corpus every anonymous-gate suite runs against.
//
// Not a suite itself (the mobile vitest `include` is `src/**/*.test.{ts,tsx}`),
// just the two lists. Keeping them in one place is what makes "the native fork
// is inert" and "the web fork relaxes exactly these" the same claim measured
// against the same paths — a path added here is immediately asserted by the
// predicate suite, both fork suites and both AuthProvider gate suites.

const CLIMB_UUID = '0A1B2C3D4E5F60718293A4B5C6D7E8F9';

/** A climb segment as the web front door writes it: slug tail plus uuid. */
const CLIMB_SEGMENT = `crimpy-thing-${CLIMB_UUID}`;

const TUPLE = '/kilter/original/12x12-square/screw_bolt';

/** Every URL shape a signed-out visitor may land on. */
export const READ_ONLY_PATHS: readonly string[] = [
  // `/b/{slug}` — the named-board tree.
  '/b/the-gym',
  '/b/the-gym/40/list',
  `/b/the-gym/40/view/${CLIMB_SEGMENT}`,
  `/b/the-gym/40/play/${CLIMB_UUID}`,
  // The canonical config-tuple tree, in both the named-slug and numeric-id forms
  // the web app emits.
  `${TUPLE}/40/list`,
  '/kilter/1/10/1,20/40/list',
  `${TUPLE}/40/view/${CLIMB_SEGMENT}`,
  `${TUPLE}/40/play/${CLIMB_UUID}`,
  // A negative angle is a real board angle, not a malformed segment.
  `${TUPLE}/-15/list`,
  // Locale-prefixed shares. Expo has no `[locale]` segment, so these match no
  // route and land on `+not-found`, which strips the prefix and re-redirects —
  // but the gate runs first, so it has to relax both forms or every non-English
  // share link still hits a bare login wall.
  `/es${TUPLE}/40/view/${CLIMB_SEGMENT}`,
  `/fr${TUPLE}/40/view/${CLIMB_SEGMENT}`,
  `/de/b/the-gym/40/view/${CLIMB_SEGMENT}`,
];

/** Everything else: still behind the login gate, on every platform. */
export const GATED_PATHS: readonly string[] = [
  '/',
  '/(tabs)/home',
  '/(tabs)/profile',
  '/auth/login',
  '/auth/register',
  '/boards',
  '/join/abc',
  '/users/123',
  '/play',
  `/climbs/${CLIMB_UUID}`,
  // Right shape, wrong angle segment — a broken URL, not a read-only one.
  `${TUPLE}/notanangle/list`,
  // A board surface that is not read-only.
  `${TUPLE}/40/edit`,
  // Prefixes that carry no destination of their own.
  '/b',
  '/es',
  // Right segment count, routing syntax where a board identifier belongs. The
  // group folder never appears in a browser URL and the relative segment is one
  // the browser would have normalised away — neither is a path this gate could
  // have produced, so neither is one it will follow back.
  '/(tabs)/profile/a/b/40/list',
  '/b/..',
];

export { CLIMB_UUID, CLIMB_SEGMENT, TUPLE };
