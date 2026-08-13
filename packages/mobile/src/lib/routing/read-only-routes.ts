// Which canonical board URLs a signed-out visitor is allowed to land on, and
// what a `?next=` value has to look like before the app will follow it.
//
// The web front door on `www.boardsesh.com` links every climb page into
// `app.boardsesh.com` at the same path. Until now those arrivals hit the auth
// gate and lost the climb they came for; the allow-set below is the exact set of
// URL shapes the gate stands aside for. Everything here is pure — no React, no
// `window`, no platform — so the shape rules and the open-redirect rules are
// unit-testable on their own, and the native bundle leaves the whole file out
// (only `anonymous-auth-gate.web.ts` imports it).
//
// Matching is deliberately SHAPE-only: it never resolves a slug or a board
// config against the catalogue. A well-formed URL whose board no longer exists
// should reach that route's own not-found, not a login wall.

import { stripLocalePrefix } from './strip-locale-prefix';

/**
 * Longest `?next=` we will carry, comfortably above any board URL we emit.
 *
 * Measured against the WHOLE value, query and fragment included — unlike the
 * shape matcher below, which drops that tail before matching. That asymmetry is
 * deliberate: this cap is on the string we would hand the router, so its full
 * length is what matters, and a `next` padded out with query junk is one we
 * would rather refuse than truncate.
 */
export const MAX_RETURN_HREF_LENGTH = 512;

/** An angle segment: `40`, `-15`. */
const ANGLE = /^-?\d+$/;

/** The two climb surfaces both URL trees share. */
const CLIMB_SURFACES = new Set(['view', 'play']);

/** Anything with a URI scheme in front of it (`https:`, `javascript:`, `JaVaScRiPt:`). */
const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/**
 * Control characters, space and DEL — checked by code point rather than a regex
 * literal so the source carries no invisible characters. A leading tab or
 * newline otherwise sneaks past the leading-slash rule, because the browser
 * trims it back off before navigating.
 */
function hasControlOrSpace(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.charCodeAt(index);
    if (codePoint <= 0x20 || codePoint === 0x7f) return true;
  }
  return false;
}

/** The path with its query/hash tail and locale prefix removed, split into segments. */
function pathSegments(path: string): string[] {
  const withoutTail = path.split(/[?#]/, 1)[0] ?? '';
  const normalised = stripLocalePrefix(withoutTail) ?? withoutTail;
  return normalised.split('/').filter(Boolean);
}

/**
 * Is `path` one of the read-only board URLs the app serves to a signed-out
 * visitor? Locale-prefixed forms (`/es/kilter/…`, `/fr/b/{slug}/…`) count — web
 * keeps the locale in the path, and those links are the whole reason this
 * exists.
 *
 * `/auth/*` is excluded by shape *and* by an explicit guard, because a `next`
 * naming an auth route is how this feature would turn into a redirect loop.
 */
export function isReadOnlyAnonymousPath(path: string): boolean {
  const segments = pathSegments(path);

  // `/b/{slug}` and its angle-scoped children.
  if (segments[0] === 'b') {
    if (segments.length === 2) return true;
    if (segments.length === 4) return ANGLE.test(segments[2]) && segments[3] === 'list';
    if (segments.length === 5) return ANGLE.test(segments[2]) && CLIMB_SURFACES.has(segments[3]);
    return false;
  }

  // The config-tuple tree: `/{board}/{layout}/{size}/{sets}/{angle}/…`.
  if (segments[0] === undefined || segments[0] === 'auth') return false;
  if (segments.length === 6) return ANGLE.test(segments[4]) && segments[5] === 'list';
  if (segments.length === 7) return ANGLE.test(segments[4]) && CLIMB_SURFACES.has(segments[5]);
  return false;
}

/**
 * Is `value` an app-relative path we can hand to the router?
 *
 * This is the open-redirect contract: anything that is not unambiguously a
 * same-origin path is refused. Backslashes go too — browsers normalise `\` to
 * `/`, so `/\evil.example` is protocol-relative in practice.
 */
export function isSafeReturnPath(value: string | null | undefined): value is string {
  if (!value) return false;
  if (value.length > MAX_RETURN_HREF_LENGTH) return false;
  if (hasControlOrSpace(value)) return false;
  if (SCHEME.test(value)) return false;
  if (!value.startsWith('/')) return false;
  if (value.startsWith('//')) return false;
  if (value.includes('\\')) return false;
  return true;
}
