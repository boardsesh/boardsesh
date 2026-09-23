import type { BoardName, SearchGymsInput } from '@boardsesh/shared-schema';
import { CATALOGUE_BOARD_TYPES } from '@boardsesh/board-constants';
import { buildAngleOptions, buildLayoutOptions, buildSizeOptions } from './filter-options';
import type { GymBoardFilter } from './filter-state';

/**
 * The query-param names. Exported because they are a contract two surfaces and a
 * test suite share, not a detail: `?boardType=` already ships in live URLs and
 * cannot be renamed, and the three new ones are singular for the same reason —
 * `?layout=8` reads as one wall, which is what it filters on.
 */
export const GYM_FILTER_PARAMS = {
  boardType: 'boardType',
  layout: 'layout',
  size: 'size',
  angle: 'angle',
  /**
   * The gym-level predicate, enumerated rather than a boolean `?multiBoard=true`:
   * `boards=2plus` says what it means in a URL someone pastes to a friend, and it
   * leaves room for another gym-level value without minting a second param.
   */
  boards: 'boards',
} as const;

/** The only value `?boards=` takes today. Anything else is dropped. */
const MULTI_BOARD_TYPE_VALUE = '2plus';

/** Next.js' `searchParams` shape: a repeated param arrives as an array. */
export type GymFilterSearchParams = Record<string, string | string[] | undefined>;

/**
 * Most ids any one param will carry before we stop reading it.
 *
 * Generous against every real selection — the widest tier in the catalogue is
 * MoonBoard's seven layouts, and Kilter's longest angle list is fifteen — and
 * tight against a crafted URL. Applied BEFORE the membership checks below, so a
 * `?angle=` repeated five hundred times costs a slice rather than five hundred
 * walks of the catalogue.
 */
const MAX_IDS_PER_PARAM = 20;

function allValues(raw: string | string[] | undefined): string[] {
  if (Array.isArray(raw)) return raw;
  return raw === undefined ? [] : [raw];
}

/**
 * Strict integers only.
 *
 * Deliberately not a `Number.isFinite` check: `Number('1.5')` is finite, and
 * `ub.layout_id IN (1.5)` is legal SQL that matches nothing while minting a
 * fresh cache entry for every decimal someone types. Same reasoning rejects
 * `'1e3'`, `'+8'`, `'08'` and surrounding whitespace — comparing against the
 * canonical decimal spelling means one id has exactly one URL.
 */
function parseStrictInts(raw: string | string[] | undefined): number[] {
  const parsed: number[] = [];
  for (const value of allValues(raw).slice(0, MAX_IDS_PER_PARAM)) {
    const candidate = Number(value);
    if (!Number.isInteger(candidate) || String(candidate) !== value) continue;
    parsed.push(candidate);
  }
  return parsed;
}

/** Dedupe + ascending sort: one selection must always spell one URL, and so one cache key. */
function normaliseIds(ids: number[]): number[] | undefined {
  if (ids.length === 0) return undefined;
  return [...new Set(ids)].sort((left, right) => left - right);
}

/**
 * Read the board filter off a request.
 *
 * Everything is validated against the catalogue rather than forwarded: an id
 * that names no layout, an angle that board cannot be set to, a board type
 * nobody has ever built. All of them are DROPPED, never rejected — a stale
 * bookmark or a hand-edited URL renders its clean, wider result instead of an
 * error page, which is the convention the rest of the directory already follows.
 *
 * The tiers are read in order and each gates the next, because that is the only
 * order in which the catalogue can answer. `lockedBoardTypes` is how a facet
 * route joins in: on `/gyms/kilter` the board type comes from the path, which
 * counts as "exactly one" and unlocks the layout tier with no query param at all.
 */
export function parseGymBoardFilter(
  params: GymFilterSearchParams,
  options: { lockedBoardTypes?: BoardName[] } = {},
): GymBoardFilter {
  const boardTypes =
    options.lockedBoardTypes ??
    ([
      ...new Set(
        allValues(params[GYM_FILTER_PARAMS.boardType])
          .slice(0, MAX_IDS_PER_PARAM)
          .map((value) => value.trim().toLowerCase()),
      ),
    ].filter((value) => CATALOGUE_BOARD_TYPES.includes(value)) as BoardName[]);

  const scoped: GymBoardFilter = { boardTypes: boardTypes.length > 0 ? [...boardTypes].sort() : undefined };

  // Layout: only legal under exactly one board type, and only for an id that
  // board actually has. `buildLayoutOptions` enforces the first and supplies the
  // second, so the URL and the rendered chips can never disagree about what is
  // selectable.
  const layoutOptions = buildLayoutOptions(scoped);
  const layoutIds = normaliseIds(
    parseStrictInts(params[GYM_FILTER_PARAMS.layout]).filter((id) => layoutOptions.some((option) => option.id === id)),
  );

  const withLayouts: GymBoardFilter = { ...scoped, layoutIds };

  const sizeOptions = buildSizeOptions(withLayouts);
  const sizeIds = normaliseIds(
    parseStrictInts(params[GYM_FILTER_PARAMS.size]).filter((id) =>
      sizeOptions.some((option) => option.sizeIds.includes(id)),
    ),
  );

  // Angle hangs off the board type, not the layout, so it is validated against
  // `scoped` — a two-layout selection still has legal angles.
  const angleOptions = buildAngleOptions(scoped);
  const angles = normaliseIds(
    parseStrictInts(params[GYM_FILTER_PARAMS.angle]).filter((angle) =>
      angleOptions.some((option) => option.angle === angle),
    ),
  );

  // Gym-level, so it hangs off no tier and nothing above it can invalidate it.
  const rawMultiBoard = params[GYM_FILTER_PARAMS.boards];
  const multiBoardValue = Array.isArray(rawMultiBoard) ? rawMultiBoard[0] : rawMultiBoard;
  const multiBoardTypeOnly = multiBoardValue === MULTI_BOARD_TYPE_VALUE ? true : undefined;

  return { ...withLayouts, sizeIds, angles, multiBoardTypeOnly };
}

/**
 * Append the board filter to a URL's params, in a fixed order.
 *
 * Fixed order and sorted ids together are what make one filter state one string:
 * one CDN entry, one `unstable_cache` key, one crawlable URL — rather than one
 * per accidental ordering.
 *
 * `omitBoardTypes` is for a facet route, where the board type lives in the path.
 * Emitting it as a param there would let `/gyms/kilter?boardType=tension` exist.
 */
export function appendGymBoardFilterParams(
  target: URLSearchParams,
  filter: GymBoardFilter,
  options: { omitBoardTypes?: boolean } = {},
): void {
  if (!options.omitBoardTypes) {
    for (const boardType of filter.boardTypes ?? []) {
      target.append(GYM_FILTER_PARAMS.boardType, boardType);
    }
  }
  for (const layoutId of filter.layoutIds ?? []) {
    target.append(GYM_FILTER_PARAMS.layout, String(layoutId));
  }
  for (const sizeId of filter.sizeIds ?? []) {
    target.append(GYM_FILTER_PARAMS.size, String(sizeId));
  }
  for (const angle of filter.angles ?? []) {
    target.append(GYM_FILTER_PARAMS.angle, String(angle));
  }
  if (filter.multiBoardTypeOnly) {
    target.set(GYM_FILTER_PARAMS.boards, MULTI_BOARD_TYPE_VALUE);
  }
}

/**
 * The `searchGyms` wire shape.
 *
 * Empty arrays are omitted rather than sent: the resolver's `boardMatchExists`
 * returns null when no board filter is set, and an empty array would flip that
 * into an `EXISTS` clause that changes the emitted SQL for every existing caller.
 */
export function toGymBoardFilterInput(
  filter: GymBoardFilter,
): Pick<SearchGymsInput, 'boardTypes' | 'layoutIds' | 'sizeIds' | 'angles' | 'multiBoardTypeOnly'> {
  return {
    ...((filter.boardTypes?.length ?? 0) > 0 ? { boardTypes: filter.boardTypes } : {}),
    ...((filter.layoutIds?.length ?? 0) > 0 ? { layoutIds: filter.layoutIds } : {}),
    ...((filter.sizeIds?.length ?? 0) > 0 ? { sizeIds: filter.sizeIds } : {}),
    ...((filter.angles?.length ?? 0) > 0 ? { angles: filter.angles } : {}),
    ...(filter.multiBoardTypeOnly ? { multiBoardTypeOnly: true } : {}),
  };
}
