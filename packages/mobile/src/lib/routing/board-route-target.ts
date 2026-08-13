// What a canonical board URL asked for, and how the entry routes' params turn
// into one. Deliberately free of React, Expo Router and GraphQL so the URL logic
// is unit-testable on its own — `use-board-route-target.ts` is the half that
// needs the app.

import { buildBoardPath } from '@boardsesh/board-config';
import {
  extractUuidFromClimbSegment,
  parseBoardListPath,
  parseClimbRoutePath,
  type ParsedBoardConfigPath,
} from '@boardsesh/play-view/readable-url-utils';

/** What a canonical URL asked for: a board, and optionally a climb on it. */
export type BoardRouteTarget =
  | { kind: 'list'; board: ParsedBoardConfigPath }
  | { kind: 'climb'; board: ParsedBoardConfigPath; climbUuid: string }
  /** `/b/{slug}/…` — the board is a server entity, resolved by slug. */
  | { kind: 'slug-list'; slug: string; angle: number | null }
  | { kind: 'slug-climb'; slug: string; angle: number | null; climbUuid: string };

/** The five board-config segments, as Expo Router hands them to a route. */
export type BoardRouteSegmentParams = {
  boardName?: string;
  layoutId?: string;
  sizeId?: string;
  setIds?: string;
  angle?: string;
};

const integerSegmentRegex = /^-?\d+$/;

// The tuple routes receive the board as five separate params, but the parsers in
// `@boardsesh/play-view` take a whole path — so the builders below rebuild the
// path the route was reached by and parse that, instead of growing a second
// parser that can drift from the one the web app shares. Expo Router hands over
// *decoded* params, so each segment is re-encoded: a stray `/`, `?` or `#` in a
// param must not be read back as route structure. The comma in `set_ids`
// survives because the parser decodes each segment before splitting it.
function toRoutePath(segments: string[]): string {
  return `/${segments.map(encodeURIComponent).join('/')}`;
}

function tupleRoutePath(params: BoardRouteSegmentParams, rest: string[]): string | null {
  const { boardName, layoutId, sizeId, setIds, angle } = params;
  if (!boardName || !layoutId || !sizeId || !setIds || !angle) return null;
  return toRoutePath([boardName, layoutId, sizeId, setIds, angle, ...rest]);
}

/** `/{board}/{layout}/{size}/{sets}/{angle}/list` → target, `null` when the URL is broken. */
export function buildBoardListTarget(params: BoardRouteSegmentParams): BoardRouteTarget | null {
  const path = tupleRoutePath(params, ['list']);
  if (!path) return null;
  const board = parseBoardListPath(path);
  return board ? { kind: 'list', board } : null;
}

/** `/{board}/…/{angle}/{view|play}/{climbSegment}` → target. */
export function buildBoardClimbTarget(
  params: BoardRouteSegmentParams,
  surface: 'view' | 'play',
  climbSegment: string | undefined,
): BoardRouteTarget | null {
  if (!climbSegment) return null;
  const path = tupleRoutePath(params, [surface, climbSegment]);
  if (!path) return null;
  const parsed = parseClimbRoutePath(path);
  if (!parsed) return null;
  const { boardName, layoutId, sizeId, setIds, angle, climbUuid } = parsed;
  return { kind: 'climb', board: { boardName, layoutId, sizeId, setIds, angle }, climbUuid };
}

/**
 * The angle segment of a `/b/{slug}/…` URL. A `null` angle means the URL carried
 * none and the board's own stored angle wins; a *malformed* angle is a broken
 * URL, so it fails the whole target rather than silently falling back.
 */
function parseSlugAngle(angle: string | undefined): { angle: number | null } | null {
  if (angle === undefined || angle === '') return { angle: null };
  if (!integerSegmentRegex.test(angle)) return null;
  const parsed = Number(angle);
  // The digits have to survive a round trip: `toBoardPath` serialises this back
  // into a path, and anything past the safe-integer range comes out in
  // exponential form (`1e+22`), which `parseNamedBoardPath` then rejects and
  // silently replaces with the board's own stored angle. That is the exact
  // quiet fallback this parser exists to prevent.
  if (!Number.isSafeInteger(parsed)) return null;
  return { angle: parsed };
}

function isUsableSlug(slug: string | undefined): slug is string {
  return !!slug && !slug.includes('/');
}

/** `/b/{slug}` and `/b/{slug}/{angle}/list` → target. */
export function buildSlugListTarget(slug: string | undefined, angle?: string): BoardRouteTarget | null {
  if (!isUsableSlug(slug)) return null;
  const parsedAngle = parseSlugAngle(angle);
  if (!parsedAngle) return null;
  return { kind: 'slug-list', slug, angle: parsedAngle.angle };
}

/** `/b/{slug}/{angle}/{view|play}/{climbSegment}` → target. */
export function buildSlugClimbTarget(
  slug: string | undefined,
  angle: string | undefined,
  climbSegment: string | undefined,
): BoardRouteTarget | null {
  if (!isUsableSlug(slug) || !climbSegment) return null;
  const parsedAngle = parseSlugAngle(angle);
  if (!parsedAngle) return null;
  // `crimpy-thing-<uuid>` or a bare uuid — the same extractor the tuple parser
  // uses, so both URL forms accept exactly the same climb segments. A segment
  // with no uuid in it passes through unchanged and the climb query is what
  // decides it doesn't exist.
  return { kind: 'slug-climb', slug, angle: parsedAngle.angle, climbUuid: extractUuidFromClimbSegment(climbSegment) };
}

/** The board path `resolveBoardForSession` understands, for either URL form. */
export function toBoardPath(target: BoardRouteTarget): string {
  if (target.kind === 'list' || target.kind === 'climb') {
    const { boardName, layoutId, sizeId, setIds, angle } = target.board;
    return buildBoardPath(boardName, layoutId, sizeId, setIds, angle);
  }
  return target.angle == null ? `/b/${target.slug}` : `/b/${target.slug}/${target.angle}`;
}
