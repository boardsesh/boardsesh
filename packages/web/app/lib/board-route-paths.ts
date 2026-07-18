import { SUPPORTED_BOARDS } from '@boardsesh/shared-schema';
import { SUPPORTED_LOCALES, DEFAULT_LOCALE } from '@boardsesh/i18n';

const BOARD_NAMES = new Set(SUPPORTED_BOARDS);
// Path-prefixed locales only — the default (en-US) is served at the root with
// no prefix. Board routes under a localized prefix (`/es/kilter/...`,
// `/fr/b/...`) must classify identically to their unprefixed equivalents; the
// locale-cookie middleware actively redirects to these URLs, so stripping the
// prefix here is what keeps peer-broadcast analytics firing on localized board
// routes.
const PATH_LOCALES = new Set<string>(SUPPORTED_LOCALES.filter((locale) => locale !== DEFAULT_LOCALE));

function getPathSegments(pathname: string): string[] {
  const segments = pathname.split('?')[0].split('/').filter(Boolean);
  if (segments.length > 0 && PATH_LOCALES.has(segments[0])) {
    return segments.slice(1);
  }
  return segments;
}

/**
 * Locale-stripped path segments for a board route. Exposed so the Expo-web
 * rollout redirect map (edge middleware) can decompose a board URL into its
 * board-config parts without re-implementing the `/es/…`, `/fr/…` prefix
 * handling that classification already gets right.
 */
export function getBoardRouteSegments(pathname: string): string[] {
  return getPathSegments(pathname);
}

export function isBoardRoutePath(pathname: string | null | undefined): boolean {
  if (!pathname) return false;

  const [firstSegment] = getPathSegments(pathname);
  if (firstSegment === 'b') return true;
  return firstSegment !== undefined && BOARD_NAMES.has(firstSegment as (typeof SUPPORTED_BOARDS)[number]);
}

export function isBoardListPath(pathname: string | null | undefined): boolean {
  if (!pathname || !isBoardRoutePath(pathname)) return false;

  const segments = getPathSegments(pathname);

  if (segments[0] === 'b') {
    return segments.length === 4 && segments[3] === 'list';
  }

  return segments.length === 6 && segments[5] === 'list';
}

/**
 * True when a board-route segment is a legacy numeric ID (`1`, `10`) rather
 * than a name slug (`original`, `12x12-square`). Canonical definition lives
 * here (edge-safe, importable from middleware); `url-utils.ts` re-exports it
 * for the rest of the app.
 */
export function isNumericId(value: string): boolean {
  return /^\d+$/.test(value);
}

export function isBoardCreatePath(pathname: string | null | undefined): boolean {
  if (!pathname || !isBoardRoutePath(pathname)) return false;

  const segments = getPathSegments(pathname);

  if (segments[0] === 'b') {
    return segments.length === 4 && segments[3] === 'create';
  }

  return segments.length === 6 && segments[5] === 'create';
}
