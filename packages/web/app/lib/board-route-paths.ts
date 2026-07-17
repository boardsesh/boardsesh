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

export function isBoardCreatePath(pathname: string | null | undefined): boolean {
  if (!pathname || !isBoardRoutePath(pathname)) return false;

  const segments = getPathSegments(pathname);

  if (segments[0] === 'b') {
    return segments.length === 4 && segments[3] === 'create';
  }

  return segments.length === 6 && segments[5] === 'create';
}
