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

/**
 * Board types that have NO `/[board_name]/[layout]/[size]/[sets]/[angle]/...`
 * surface on www.
 *
 * Only `spray` so far. The deep board route addresses a CATALOGUE board — a
 * board model anyone can look up by layout, size and hold sets — and a spray
 * wall is not one: its layout and size are created at runtime for one climber's
 * wall, and it is reached by its own board slug at `/b/{slug}/...` like any
 * other user board. So `/spray/1/1/1/40/list` names a board that does not exist
 * as a board model, and the route 404s rather than 500ing its way through a
 * catalogue lookup that has nothing to find.
 *
 * Whether www grows a public spray-wall surface at all is SW-16's (#5449)
 * decision; until then this is the whole of the answer.
 */
const BOARDS_WITHOUT_DEEP_ROUTE = new Set<string>(['spray']);

/**
 * Whether a board type is addressable through the deep
 * `/[board_name]/[layout_id]/[size_id]/[set_ids]/[angle]` route.
 * See {@link BOARDS_WITHOUT_DEEP_ROUTE}.
 */
export function boardHasDeepConfigRoute(boardName: string): boolean {
  return !BOARDS_WITHOUT_DEEP_ROUTE.has(boardName);
}

/**
 * True when a board-route segment is a legacy numeric ID (`1`, `10`) rather
 * than a name slug (`original`, `12x12-square`). Canonical definition lives
 * here (edge-safe — no `server-only`, no DB import); `url-utils.ts` re-exports it
 * for the rest of the app.
 */
export function isNumericId(value: string): boolean {
  return /^\d+$/.test(value);
}
