// Build a stable PostHog $screen name from Expo Router segments. Drops route
// group markers like "(tabs)" (organizational, not real path segments) and keeps
// dynamic placeholders like "[climbUuid]" verbatim, so every climb collapses to a
// single "/climbs/[climbUuid]" screen instead of one screen per uuid. Returns "/"
// for an empty/root location.
export function normalizeScreenPath(segments: readonly string[]): string {
  const parts = segments.filter((segment) => !(segment.startsWith('(') && segment.endsWith(')')));
  if (parts.length === 0) return '/';
  return `/${parts.join('/')}`;
}
