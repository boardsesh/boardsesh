import { getPublicBackendHttpUrl } from '@/app/lib/backend-url';

/**
 * The share cards the backend draws for everything that is not a climb
 * (`/og/playlist`, `/og/profile`, `/og/setter`, `/og/session`, `/og/place`).
 * See "The share-card family" in docs/og-climb.md.
 */
export type OgFamilySurface = 'playlist' | 'profile' | 'setter' | 'session' | 'place';

/**
 * Absolute URL of a family card on the backend origin, or `null` when this
 * deployment has no public backend origin to point at.
 *
 * The same origin `buildOgBoardRenderUrl` uses for the climb card. `version`
 * is the data token: the backend ignores it, and it exists so a chat app that
 * caches previews by URL asks again once the content has changed.
 *
 * Every parameter is a public id or slug. Never pass a capability (`?wall=`,
 * `?invite=`) here: an og:image URL is published in the page's HTML.
 */
export function buildOgFamilyImageUrl(
  surface: OgFamilySurface,
  params: Record<string, string>,
  version: string,
): string | null {
  const origin = getPublicBackendHttpUrl();
  if (!origin) return null;
  const query = new URLSearchParams(params);
  query.set('v', version);
  return `${origin}/og/${surface}?${query}`;
}

/**
 * A short token that changes whenever any of `parts` changes.
 *
 * For cards whose content has no single timestamp to version on (a setter's
 * send total, a playlist's grade band, a gym's board list). Not a security
 * boundary, only a cache-buster, so a fast non-cryptographic hash is enough and
 * keeps this module free of `node:crypto`.
 */
export function buildOgContentVersion(...parts: unknown[]): string {
  const text = JSON.stringify(parts);
  // cyrb53: 53 bits from two 32-bit FNV-style lanes.
  let first = 0xdeadbeef;
  let second = 0x41c6ce57;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    first = Math.imul(first ^ code, 2654435761);
    second = Math.imul(second ^ code, 1597334677);
  }
  first = Math.imul(first ^ (first >>> 16), 2246822507) ^ Math.imul(second ^ (second >>> 13), 3266489909);
  second = Math.imul(second ^ (second >>> 16), 2246822507) ^ Math.imul(first ^ (first >>> 13), 3266489909);
  return (4294967296 * (2097151 & second) + (first >>> 0)).toString(36);
}

/**
 * Daily feed groups (`daily:<user>:<day>`) are not sessions. The backend's
 * session card refuses them (their rules live in `sessionDetail`), so their
 * pages keep the web route's card rather than advertising a 404.
 */
export function isDailySessionId(sessionId: string): boolean {
  return sessionId.startsWith('daily:');
}
