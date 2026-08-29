import type {
  BoardRouteParameters,
  ParsedBoardRouteParametersWithUuid,
  ParsedBoardRouteParameters,
  BoardRouteParametersWithUuid,
  SearchRequestPagination,
  ClimbUuid,
  BoardDetails,
  BoardRouteIdentity,
  BoardName,
  HoldsFilter,
  HoldFilterEntry,
  HoldFilterType,
  HoldFilterMode,
  ZoneMatchMode,
} from '@/app/lib/types';
import {
  generateSlugFromText,
  generateDescriptionSlug,
  generateLayoutSlug,
  generateSizeSlug,
  generateSetSlug,
  extractUuidFromClimbSegment as extractUuidFromSlug,
  tryBuildReadableClimbViewPath,
  tryBuildReadableClimbListPath,
} from '@boardsesh/play-view/readable-url-utils';
import { isNumericId } from './board-route-paths';
import type { PopularBoardConfig } from '@boardsesh/shared-schema';
import { MOONBOARD_LAYOUTS } from '@/app/lib/moonboard-config';
import { normalizeMinAscentsFilter, normalizeMinRatingFilter } from '@/app/lib/climb-quality-filter-options';
import { detectLocale } from '@/app/lib/i18n/detect-locale';
import { PAGE_LIMIT } from './climb-list-constants';

export const DEFAULT_ZONE_MODE: ZoneMatchMode = 'allHolds';

// ---------- Shared URL query param helpers ----------

/**
 * Parse a URL query param as a boolean.
 * Accepts '1'/'true' as true, '0'/'false' as false.
 */
export function parseQueryParamBoolean(params: URLSearchParams, key: string): boolean | undefined {
  const val = params.get(key);
  if (val === '1' || val === 'true') return true;
  if (val === '0' || val === 'false') return false;
  return undefined;
}

/**
 * Parse a URL query param as a finite integer.
 */
export function parseQueryParamInt(params: URLSearchParams, key: string): number | undefined {
  const val = params.get(key);
  if (val === null) return undefined;
  const num = parseInt(val, 10);
  return Number.isFinite(num) ? num : undefined;
}

// Random-sort seed: digits only, bounded to 32 chars (matches the GraphQL zod
// contract). Anything else — including a crafted URL — collapses to the empty
// default, so the DB falls back to its constant salt rather than salting md5
// with arbitrary text.
function normalizeSortSeed(raw: string | null): string {
  return raw && /^\d{1,32}$/.test(raw) ? raw : DEFAULT_SEARCH_PARAMS.sortSeed || '';
}

// ---------- Board route params ----------

export function parseBoardRouteParams<T extends BoardRouteParameters>(
  params: T,
): T extends BoardRouteParametersWithUuid ? ParsedBoardRouteParametersWithUuid : ParsedBoardRouteParameters {
  const { board_name, layout_id, size_id, set_ids, angle, climb_uuid } = params;

  const parsedParams = {
    board_name,
    layout_id: Number(layout_id),
    size_id: Number(size_id),
    set_ids: decodeURIComponent(set_ids)
      .split(',')
      .map((str) => Number(str)),
    angle: Number(angle),
  };

  if (climb_uuid) {
    // TypeScript knows climb_uuid is present, so return the correct type
    return {
      ...parsedParams,
      climb_uuid,
    } as T extends BoardRouteParametersWithUuid ? ParsedBoardRouteParametersWithUuid : never;
  }

  // Return parsedParams as ParsedBoardRouteParameters when climb_uuid is absent
  return parsedParams as T extends BoardRouteParametersWithUuid ? never : ParsedBoardRouteParameters;
}

export const searchParamsToUrlParams = (input: SearchRequestPagination): URLSearchParams => {
  // Coalesce any missing/undefined fields to their defaults. Stored recent searches
  // (IndexedDB) and partial filter updates can leak undefined values into this path,
  // which would otherwise crash on `.toString()`. See BOARDSESH-30, BOARDSESH-2Z,
  // BOARDSESH-31, BOARDSESH-33, BOARDSESH-34, BOARDSESH-38 (all collapsed under #2067).
  // The `input ?? {}` first line also defends against a hypothetical caller passing
  // null/undefined — every field is then individually coalesced below.
  const safeInput = (input ?? {}) as Partial<SearchRequestPagination>;
  const gradeAccuracy = safeInput.gradeAccuracy ?? DEFAULT_SEARCH_PARAMS.gradeAccuracy;
  const maxGrade = safeInput.maxGrade ?? DEFAULT_SEARCH_PARAMS.maxGrade;
  const minGrade = safeInput.minGrade ?? DEFAULT_SEARCH_PARAMS.minGrade;
  const minAscents = normalizeMinAscentsFilter(safeInput.minAscents ?? DEFAULT_SEARCH_PARAMS.minAscents);
  const minRating = normalizeMinRatingFilter(safeInput.minRating ?? DEFAULT_SEARCH_PARAMS.minRating);
  const sortBy = safeInput.sortBy ?? DEFAULT_SEARCH_PARAMS.sortBy;
  const sortOrder = safeInput.sortOrder ?? DEFAULT_SEARCH_PARAMS.sortOrder;
  const sortSeed = safeInput.sortSeed ?? DEFAULT_SEARCH_PARAMS.sortSeed;
  const name = safeInput.name ?? DEFAULT_SEARCH_PARAMS.name;
  const onlyBenchmarks = safeInput.onlyBenchmarks ?? DEFAULT_SEARCH_PARAMS.onlyBenchmarks;
  const onlyTallClimbs = safeInput.onlyTallClimbs ?? DEFAULT_SEARCH_PARAMS.onlyTallClimbs;
  const onlyWideClimbs = safeInput.onlyWideClimbs ?? DEFAULT_SEARCH_PARAMS.onlyWideClimbs;
  const onlyWithBetaVideos = safeInput.onlyWithBetaVideos ?? DEFAULT_SEARCH_PARAMS.onlyWithBetaVideos;
  const settername = safeInput.settername ?? DEFAULT_SEARCH_PARAMS.settername;
  const setternameSuggestion = safeInput.setternameSuggestion ?? DEFAULT_SEARCH_PARAMS.setternameSuggestion;
  const holdsFilter = safeInput.holdsFilter ?? DEFAULT_SEARCH_PARAMS.holdsFilter;
  const hideAttempted = safeInput.hideAttempted ?? DEFAULT_SEARCH_PARAMS.hideAttempted;
  const hideCompleted = safeInput.hideCompleted ?? DEFAULT_SEARCH_PARAMS.hideCompleted;
  const showOnlyAttempted = safeInput.showOnlyAttempted ?? DEFAULT_SEARCH_PARAMS.showOnlyAttempted;
  const showOnlyCompleted = safeInput.showOnlyCompleted ?? DEFAULT_SEARCH_PARAMS.showOnlyCompleted;
  const onlyDrafts = safeInput.onlyDrafts ?? DEFAULT_SEARCH_PARAMS.onlyDrafts;
  const projectsOnly = safeInput.projectsOnly ?? DEFAULT_SEARCH_PARAMS.projectsOnly;
  const boulders = safeInput.boulders ?? DEFAULT_SEARCH_PARAMS.boulders;
  const routes = safeInput.routes ?? DEFAULT_SEARCH_PARAMS.routes;
  const zoneBox = safeInput.zoneBox ?? DEFAULT_SEARCH_PARAMS.zoneBox;
  const zoneMode = safeInput.zoneMode === 'anyHold' ? 'anyHold' : DEFAULT_SEARCH_PARAMS.zoneMode;
  const page = safeInput.page ?? DEFAULT_SEARCH_PARAMS.page;
  const pageSize = safeInput.pageSize ?? DEFAULT_SEARCH_PARAMS.pageSize;

  const params: Record<string, string> = {};

  // Only add parameters that differ from defaults. `!= null` guards defend against legacy
  // persisted state where the type says `number` but the value is `undefined`.
  if (gradeAccuracy != null && gradeAccuracy !== DEFAULT_SEARCH_PARAMS.gradeAccuracy) {
    params.gradeAccuracy = gradeAccuracy.toString();
  }
  if (maxGrade != null && maxGrade !== DEFAULT_SEARCH_PARAMS.maxGrade) {
    params.maxGrade = maxGrade.toString();
  }
  if (minGrade != null && minGrade !== DEFAULT_SEARCH_PARAMS.minGrade) {
    params.minGrade = minGrade.toString();
  }
  if (minAscents != null && minAscents !== DEFAULT_SEARCH_PARAMS.minAscents) {
    params.minAscents = minAscents.toString();
  }
  if (minRating != null && minRating !== DEFAULT_SEARCH_PARAMS.minRating) {
    params.minRating = minRating.toString();
  }
  if (sortBy !== DEFAULT_SEARCH_PARAMS.sortBy) {
    params.sortBy = sortBy;
  }
  if (sortOrder !== DEFAULT_SEARCH_PARAMS.sortOrder) {
    params.sortOrder = sortOrder;
  }
  if (sortSeed && sortSeed !== DEFAULT_SEARCH_PARAMS.sortSeed) {
    params.sortSeed = sortSeed;
  }
  if (name && name !== DEFAULT_SEARCH_PARAMS.name) {
    params.name = name;
  }
  if (onlyBenchmarks !== DEFAULT_SEARCH_PARAMS.onlyBenchmarks) {
    params.onlyBenchmarks = onlyBenchmarks.toString();
  }
  if (onlyTallClimbs !== DEFAULT_SEARCH_PARAMS.onlyTallClimbs) {
    params.onlyTallClimbs = onlyTallClimbs.toString();
  }
  if (onlyWideClimbs !== DEFAULT_SEARCH_PARAMS.onlyWideClimbs) {
    params.onlyWideClimbs = onlyWideClimbs.toString();
  }
  if (onlyWithBetaVideos !== DEFAULT_SEARCH_PARAMS.onlyWithBetaVideos) {
    params.onlyWithBetaVideos = onlyWithBetaVideos.toString();
  }
  if (settername && settername.length > 0) {
    params.settername = settername.join(',');
  }
  if (setternameSuggestion && setternameSuggestion !== DEFAULT_SEARCH_PARAMS.setternameSuggestion) {
    params.setternameSuggestion = setternameSuggestion;
  }
  if (page != null && page !== DEFAULT_SEARCH_PARAMS.page) {
    params.page = page.toString();
  }
  if (pageSize != null && pageSize !== DEFAULT_SEARCH_PARAMS.pageSize) {
    params.pageSize = pageSize.toString();
  }
  if (hideAttempted !== DEFAULT_SEARCH_PARAMS.hideAttempted) {
    params.hideAttempted = hideAttempted.toString();
  }
  if (hideCompleted !== DEFAULT_SEARCH_PARAMS.hideCompleted) {
    params.hideCompleted = hideCompleted.toString();
  }
  if (showOnlyAttempted !== DEFAULT_SEARCH_PARAMS.showOnlyAttempted) {
    params.showOnlyAttempted = showOnlyAttempted.toString();
  }
  if (showOnlyCompleted !== DEFAULT_SEARCH_PARAMS.showOnlyCompleted) {
    params.showOnlyCompleted = showOnlyCompleted.toString();
  }
  if (onlyDrafts !== DEFAULT_SEARCH_PARAMS.onlyDrafts) {
    params.onlyDrafts = onlyDrafts.toString();
  }
  if (projectsOnly !== DEFAULT_SEARCH_PARAMS.projectsOnly) {
    params.projectsOnly = projectsOnly.toString();
  }
  if (boulders !== DEFAULT_SEARCH_PARAMS.boulders) {
    params.boulders = boulders.toString();
  }
  if (routes !== DEFAULT_SEARCH_PARAMS.routes) {
    params.routes = routes.toString();
  }
  if (
    zoneBox &&
    zoneBox.edgeLeft != null &&
    zoneBox.edgeRight != null &&
    zoneBox.edgeBottom != null &&
    zoneBox.edgeTop != null
  ) {
    params.zoneEdgeLeft = zoneBox.edgeLeft.toString();
    params.zoneEdgeRight = zoneBox.edgeRight.toString();
    params.zoneEdgeBottom = zoneBox.edgeBottom.toString();
    params.zoneEdgeTop = zoneBox.edgeTop.toString();
    if (zoneMode !== DEFAULT_SEARCH_PARAMS.zoneMode) {
      params.zoneMode = zoneMode;
    }
  }

  // Add holds filter entries only if they exist.
  // Per-hold value is a comma-joined list of `{TYPE}:{include|exclude}` triples,
  // e.g. `STARTING:include,FOOT:exclude`. ANY is just one of the types.
  if (holdsFilter && Object.keys(holdsFilter).length > 0) {
    Object.entries(holdsFilter).forEach(([holdId, entry]) => {
      const parts = Object.entries(entry)
        .filter(([, mode]) => mode === 'include' || mode === 'exclude')
        .map(([type, mode]) => `${type}:${mode}`);
      if (parts.length > 0) {
        params[`hold_${holdId}`] = parts.join(',');
      }
    });
  }

  return new URLSearchParams(params);
};
export const DEFAULT_SEARCH_PARAMS: SearchRequestPagination = {
  gradeAccuracy: 0,
  maxGrade: 0,
  minGrade: 0,
  minRating: 0,
  minAscents: 0,
  sortBy: 'ascents',
  sortOrder: 'desc',
  sortSeed: '',
  name: '',
  onlyBenchmarks: false,
  onlyTallClimbs: false,
  onlyWideClimbs: false,
  onlyWithBetaVideos: false,
  settername: [],
  setternameSuggestion: '',
  holdsFilter: {},
  hideAttempted: false,
  hideCompleted: false,
  showOnlyAttempted: false,
  showOnlyCompleted: false,
  onlyDrafts: false,
  projectsOnly: false,
  // Boulders inverts the usual "default false, serialise on true" convention:
  // boulders defaults to true so the dominant case (search for boulders only)
  // produces a clean URL with no `boulders=` param. See parse logic below.
  boulders: true,
  routes: false,
  zoneBox: null,
  zoneMode: DEFAULT_ZONE_MODE,
  page: 0,
  pageSize: PAGE_LIMIT,
};

// Parse `hold_*` URL params into the new HoldsFilter shape.
//
// Modern format: `hold_{id}={TYPE}:{include|exclude}[,{TYPE}:{mode}]*`,
// e.g. `hold_142=STARTING:include,FOOT:exclude`.
//
// Legacy format (single value, pre-#1841): `hold_{id}={STATE}`, where STATE is
// a HoldState enum value. We map `ANY` → `{ANY: include}`, `NOT` → `{ANY: exclude}`,
// and `STARTING|HAND|FINISH|FOOT` → `{STATE: include}`. This shim exists so
// shared/bookmarked URLs from before the redesign keep working.
//
// TODO(#1841 follow-up): once recent searches and shared links have aged out,
// remove the legacy fallback in `parseSingleEntry`.
const HOLD_FILTER_TYPES = new Set<HoldFilterType>(['STARTING', 'HAND', 'FINISH', 'FOOT', 'ANY']);

function parseSingleEntry(raw: string): HoldFilterEntry {
  const entry: HoldFilterEntry = {};
  for (const part of raw.split(',')) {
    if (!part) continue;
    const [typeRaw, modeRaw] = part.split(':');
    if (modeRaw === 'include' || modeRaw === 'exclude') {
      if (HOLD_FILTER_TYPES.has(typeRaw as HoldFilterType)) {
        entry[typeRaw as HoldFilterType] = modeRaw as HoldFilterMode;
      }
      continue;
    }
    // Legacy single-value form
    if (typeRaw === 'NOT') {
      entry.ANY = 'exclude';
    } else if (HOLD_FILTER_TYPES.has(typeRaw as HoldFilterType)) {
      entry[typeRaw as HoldFilterType] = 'include';
    }
  }
  return entry;
}

function parseHoldsFilterFromUrl(urlParams: URLSearchParams): HoldsFilter {
  const result: HoldsFilter = {};
  for (const [key, value] of urlParams.entries()) {
    if (!key.startsWith('hold_')) continue;
    // Hold ids in board_climb_holds are non-negative integers — 0 included, since
    // Woods numbers its holds from 0 — so reject only negatives, NaN and floats.
    // Floats like `hold_1.5` would silently miss every climb in the SQL
    // `LIKE '%p1.5r%'` lookup. Digits-only rather than a bare `>= 0` test, because
    // `Number('')` is 0 and would let a lone `hold_` through as hold 0.
    const holdKey = key.slice('hold_'.length);
    const holdId = Number(holdKey);
    if (!/^\d+$/.test(holdKey) || !Number.isSafeInteger(holdId)) continue;
    const entry = parseSingleEntry(value);
    if (Object.keys(entry).length > 0) {
      result[holdId] = entry;
    }
  }
  return result;
}

const parseZoneMode = (raw: string | undefined | null): ZoneMatchMode => (raw === 'anyHold' ? 'anyHold' : 'allHolds');

export const urlParamsToSearchParams = (urlParams: URLSearchParams): SearchRequestPagination => {
  const holdsFilter = parseHoldsFilterFromUrl(urlParams);
  const zoneBox = parseZoneBoxFromQuery(urlParams);

  return {
    ...DEFAULT_SEARCH_PARAMS,
    gradeAccuracy: Number(urlParams.get('gradeAccuracy') ?? DEFAULT_SEARCH_PARAMS.gradeAccuracy),
    maxGrade: Number(urlParams.get('maxGrade') ?? DEFAULT_SEARCH_PARAMS.maxGrade),
    minAscents: normalizeMinAscentsFilter(Number(urlParams.get('minAscents') ?? DEFAULT_SEARCH_PARAMS.minAscents)),
    minGrade: Number(urlParams.get('minGrade') ?? DEFAULT_SEARCH_PARAMS.minGrade),
    minRating: normalizeMinRatingFilter(Number(urlParams.get('minRating') ?? DEFAULT_SEARCH_PARAMS.minRating)),
    sortBy: (urlParams.get('sortBy') ?? DEFAULT_SEARCH_PARAMS.sortBy) as SearchRequestPagination['sortBy'],
    sortOrder: (urlParams.get('sortOrder') ?? DEFAULT_SEARCH_PARAMS.sortOrder) as 'asc' | 'desc',
    // Digits-only, matching the GraphQL zod contract — the SSR path passes this
    // straight to the DB md5 salt, so drop anything a crafted URL puts here.
    sortSeed: normalizeSortSeed(urlParams.get('sortSeed')),
    name: urlParams.get('name') ?? DEFAULT_SEARCH_PARAMS.name,
    onlyBenchmarks: urlParams.get('onlyBenchmarks') === 'true',
    onlyTallClimbs: urlParams.get('onlyTallClimbs') === 'true',
    onlyWideClimbs: urlParams.get('onlyWideClimbs') === 'true',
    onlyWithBetaVideos: urlParams.get('onlyWithBetaVideos') === 'true',
    settername:
      urlParams
        .get('settername')
        ?.split(',')
        .filter((s) => s.length > 0) ?? DEFAULT_SEARCH_PARAMS.settername,
    setternameSuggestion: urlParams.get('setternameSuggestion') ?? DEFAULT_SEARCH_PARAMS.setternameSuggestion,
    holdsFilter,
    hideAttempted: urlParams.get('hideAttempted') === 'true',
    hideCompleted: urlParams.get('hideCompleted') === 'true',
    showOnlyAttempted: urlParams.get('showOnlyAttempted') === 'true',
    showOnlyCompleted: urlParams.get('showOnlyCompleted') === 'true',
    onlyDrafts: urlParams.get('onlyDrafts') === 'true',
    projectsOnly: urlParams.get('projectsOnly') === 'true',
    // boulders inverts the "default false, serialise on true" convention used
    // by every other switch here — only the explicit "false" string flips it
    // off. See DEFAULT_SEARCH_PARAMS for the rationale.
    boulders: urlParams.get('boulders') !== 'false',
    routes: urlParams.get('routes') === 'true',
    zoneBox,
    zoneMode: zoneBox ? parseZoneMode(urlParams.get('zoneMode')) : DEFAULT_SEARCH_PARAMS.zoneMode,
    page: Number(urlParams.get('page') ?? DEFAULT_SEARCH_PARAMS.page),
    pageSize: Number(urlParams.get('pageSize') ?? DEFAULT_SEARCH_PARAMS.pageSize),
  };
};

const parseZoneBoxFromQuery = (urlParams: URLSearchParams) => {
  const edgeLeft = parseQueryParamInt(urlParams, 'zoneEdgeLeft');
  const edgeRight = parseQueryParamInt(urlParams, 'zoneEdgeRight');
  const edgeBottom = parseQueryParamInt(urlParams, 'zoneEdgeBottom');
  const edgeTop = parseQueryParamInt(urlParams, 'zoneEdgeTop');
  if (edgeLeft === undefined || edgeRight === undefined || edgeBottom === undefined || edgeTop === undefined) {
    return null;
  }
  // Reject inverted/empty boxes — a stale or hand-edited URL like
  // zoneEdgeLeft=100&zoneEdgeRight=50 would otherwise hit the SQL filter
  // and silently return zero results.
  if (edgeRight <= edgeLeft || edgeTop <= edgeBottom) {
    return null;
  }
  return { edgeLeft, edgeRight, edgeBottom, edgeTop };
};

export const parsedRouteSearchParamsToSearchParams = (urlParams: SearchRequestPagination): SearchRequestPagination => {
  // Handle settername which may come as a string from URL but needs to be an array
  let settername = DEFAULT_SEARCH_PARAMS.settername;
  if (urlParams.settername) {
    // Type assertion needed because Next.js may pass this as a string from URL params
    const setternameValue = urlParams.settername as unknown;
    if (typeof setternameValue === 'string') {
      // If it's a string, split by comma
      settername = setternameValue.split(',').filter((s: string) => s.length > 0);
    } else if (Array.isArray(setternameValue)) {
      // If it's already an array, use it
      settername = setternameValue;
    }
  }

  const zoneBox = parseZoneBoxFromRouteRecord(urlParams as unknown as Record<string, unknown>);

  return {
    ...DEFAULT_SEARCH_PARAMS,
    ...urlParams,
    settername,
    gradeAccuracy: Number(urlParams.gradeAccuracy ?? DEFAULT_SEARCH_PARAMS.gradeAccuracy),
    maxGrade: Number(urlParams.maxGrade ?? DEFAULT_SEARCH_PARAMS.maxGrade),
    minAscents: normalizeMinAscentsFilter(Number(urlParams.minAscents ?? DEFAULT_SEARCH_PARAMS.minAscents)),
    minGrade: Number(urlParams.minGrade ?? DEFAULT_SEARCH_PARAMS.minGrade),
    minRating: normalizeMinRatingFilter(Number(urlParams.minRating ?? DEFAULT_SEARCH_PARAMS.minRating)),
    page: Number(urlParams.page ?? DEFAULT_SEARCH_PARAMS.page),
    pageSize: Number(urlParams.pageSize ?? DEFAULT_SEARCH_PARAMS.pageSize),
    // Next.js route search params come as strings, so coerce to boolean
    onlyTallClimbs: String(urlParams.onlyTallClimbs) === 'true',
    onlyWideClimbs: String(urlParams.onlyWideClimbs) === 'true',
    onlyWithBetaVideos: String(urlParams.onlyWithBetaVideos) === 'true',
    // The zone filter is serialised as four separate query params; the typed
    // SearchRequestPagination shape doesn't capture that, so read off the raw
    // route record. Without this, SSR list pages hit the GraphQL search with
    // no zone filter and the first paint shows unfiltered results until the
    // client takes over.
    zoneBox,
    zoneMode: zoneBox
      ? parseZoneMode(readQueryString(urlParams as unknown as Record<string, unknown>, 'zoneMode'))
      : DEFAULT_SEARCH_PARAMS.zoneMode,
  };
};

const readQueryString = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = record[key];
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
};

const parseZoneBoxFromRouteRecord = (record: Record<string, unknown>) => {
  const params = new URLSearchParams();
  const left = readQueryString(record, 'zoneEdgeLeft');
  const right = readQueryString(record, 'zoneEdgeRight');
  const bottom = readQueryString(record, 'zoneEdgeBottom');
  const top = readQueryString(record, 'zoneEdgeTop');
  if (left === undefined || right === undefined || bottom === undefined || top === undefined) {
    return null;
  }
  params.set('zoneEdgeLeft', left);
  params.set('zoneEdgeRight', right);
  params.set('zoneEdgeBottom', bottom);
  params.set('zoneEdgeTop', top);
  return parseZoneBoxFromQuery(params);
};

export const constructClimbViewUrl = (
  { board_name, layout_id, angle, size_id, set_ids }: ParsedBoardRouteParameters,
  climb_uuid: ClimbUuid,
  climbName?: string,
) => {
  const baseUrl = `/${board_name}/${layout_id}/${size_id}/${set_ids.join(',')}/${angle}/view/`;
  if (climbName && climbName.trim()) {
    const slug = generateSlugFromText(climbName.trim());
    if (slug) {
      return `${baseUrl}${slug}-${climb_uuid}`;
    }
  }
  return `${baseUrl}${climb_uuid}`;
};

/**
 * Name-based, so it emits the *bare* size slug even for a size that shares one
 * with another on the same layout (Kilter "12 x 12 without kickboard" — see
 * `resolveSizeSlug` in @boardsesh/play-view). Such a link still resolves, just
 * to the first match, which for a shadowed size is the wrong physical board.
 *
 * Prefer `tryConstructSlugViewUrl` wherever the numeric ids are in hand; it
 * takes them and emits the qualified slug, and `getSizeBySlug` resolves both
 * forms. This stays as the fallback for a board the static tables don't carry,
 * where names are all a caller has.
 */
export const constructClimbViewUrlWithSlugs = (
  board_name: string,
  layoutName: string,
  sizeName: string,
  sizeDescription: string | undefined,
  setNames: string[],
  angle: number,
  climb_uuid: ClimbUuid,
  climbName?: string,
) => {
  const layoutSlug = generateLayoutSlug(layoutName);
  const sizeSlug = generateSizeSlug(sizeName, sizeDescription);
  const setSlug = generateSetSlug(setNames);

  const baseUrl = `/${board_name}/${layoutSlug}/${sizeSlug}/${setSlug}/${angle}/view/`;
  if (climbName && climbName.trim()) {
    const climbSlug = generateSlugFromText(climbName.trim());
    if (climbSlug) {
      return `${baseUrl}${climbSlug}-${climb_uuid}`;
    }
  }
  return `${baseUrl}${climb_uuid}`;
};

export const constructClimbInfoUrl = ({ board_name }: BoardDetails, climb_uuid: ClimbUuid): string | null => {
  // Kilter board app URL is no longer accessible
  if (board_name === 'kilter') {
    return null;
  }
  return `https://${board_name}boardapp${board_name === 'tension' ? '2' : ''}.com/climbs/${climb_uuid}`;
};

/**
 * Name-based, so it emits the *bare* size slug even for a size that shares one
 * with another on the same layout (Kilter "12 x 12 without kickboard" — see
 * `resolveSizeSlug` in @boardsesh/play-view). Such a link still resolves, just
 * to the first match, which for a shadowed size is the wrong physical board.
 *
 * Prefer `tryConstructSlugListUrl` wherever the numeric ids are in hand; it
 * takes them and emits the qualified slug, and `getSizeBySlug` resolves both
 * forms. This stays as the fallback for a board the static tables don't carry,
 * where names are all a caller has.
 */
export const constructClimbListWithSlugs = (
  board_name: string,
  layoutName: string,
  sizeName: string,
  sizeDescription: string | undefined,
  setNames: string[],
  angle: number,
) => {
  const layoutSlug = generateLayoutSlug(layoutName);
  const sizeSlug = generateSizeSlug(sizeName, sizeDescription);
  const setSlug = generateSetSlug(setNames);
  return `/${board_name}/${layoutSlug}/${sizeSlug}/${setSlug}/${angle}/list`;
};

/**
 * The canonical board-URL slug vocabulary lives in `@boardsesh/play-view` so
 * web and the Expo app (app.boardsesh.com) emit byte-identical URLs — a shared
 * link has to keep working when it crosses hosts. Re-exported here because the
 * rest of the web app imports these from `url-utils`.
 */
export {
  generateSlugFromText,
  generateDescriptionSlug,
  generateLayoutSlug,
  generateSizeSlug,
  generateSetSlug,
  extractUuidFromSlug,
};

/**
 * Resolves a MoonBoard layout slug (from a URL) back to the layout id/name.
 *
 * MoonBoard URLs are generated by `generateLayoutSlug(layout.name)`, which
 * strips the `moonboard` prefix via BOARD_NAME_PREFIX_REGEX — so "MoonBoard
 * 2016" becomes `2016`, "MoonBoard Masters 2017" becomes `masters-2017`, etc.
 * The resolver therefore has to match slugs generated that way, not just the
 * object keys of MOONBOARD_LAYOUTS.
 *
 * The key-based matches are kept for backwards compatibility with any
 * existing links that still use the full `moonboard-2016` form.
 */
export const getMoonBoardLayoutBySlug = (slug: string): { id: number; name: string } | null => {
  const normalizedSlug = slug.replace(/-/g, '').toLowerCase();
  for (const [key, layout] of Object.entries(MOONBOARD_LAYOUTS)) {
    if (
      key === slug ||
      key.replace(/-/g, '').toLowerCase() === normalizedSlug ||
      generateLayoutSlug(layout.name) === slug
    ) {
      return { id: layout.id, name: layout.name };
    }
  }
  return null;
};

export const isUuidOnly = (slugOrUuid: string): boolean => {
  // Check if it's exactly 32 hex characters (UUID format in the database)
  const uuidRegex = /^[0-9A-F]{32}$/i;
  return uuidRegex.test(slugOrUuid);
};

// Helper to determine if a parameter is numeric (old format) or slug (new
// format). Canonical definition lives in board-route-paths.ts so edge-safe
// callers can use it without pulling this module into the edge bundle;
// re-exported here for the rest of the app.
export { isNumericId };

const decodeRouteSegment = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

/**
 * Detect whether a board route is using the legacy fully-numeric format.
 * Mixed routes like `/grasshopper/2020/grandmaster-12-x-12/...` must stay on the slug path.
 */
export const hasOnlyNumericBoardRouteSegments = (
  params: Pick<BoardRouteParameters, 'layout_id' | 'size_id' | 'set_ids'>,
): boolean => {
  const decodedSetIds = decodeRouteSegment(params.set_ids);

  return (
    isNumericId(params.layout_id) &&
    isNumericId(params.size_id) &&
    decodedSetIds.split(',').every((id) => isNumericId(id.trim()))
  );
};

/**
 * The board `[angle]` layout wraps every child route (list, view, play, …) and
 * 308-redirects legacy numeric URLs to their slug list URL. But the `/view` and
 * `/play` child routes run their OWN numeric→slug redirect that preserves the
 * climb uuid; if the layout redirected them to the bare list first, a shared
 * legacy climb link would land on the list page (with a generic OG card) instead
 * of the climb. The layout can't see the child segment from its route params, so
 * it consults the request pathname (forwarded by middleware) and defers to the
 * child for these climb-scoped routes.
 */
export const layoutOwnsNumericSlugRedirect = (pathname: string): boolean => {
  return !pathname.includes('/view/') && !pathname.includes('/play/');
};

/**
 * Try to construct a slug-based view URL. Returns null if resolution fails.
 *
 * Delegates to the shared builder rather than `constructClimbViewUrlWithSlugs`
 * because it has the size *id*: that is what lets it emit the qualified size
 * slug for a size that shares a base slug with another on the same layout (see
 * `resolveSizeSlug`). The name-based builder can't, so a link from here is
 * exact where one built from names alone would be ambiguous.
 */
export const tryConstructSlugViewUrl = (
  board_name: string,
  layout_id: number,
  size_id: number,
  set_ids: number[],
  angle: number,
  climb_uuid: string,
  climbName?: string,
): string | null =>
  tryBuildReadableClimbViewPath({
    boardName: board_name,
    layoutId: layout_id,
    sizeId: size_id,
    setIds: set_ids.join(','),
    angle,
    climbUuid: climb_uuid,
    climbName,
  });

/** Try to construct a slug-based list URL. Returns null if resolution fails. */
export const tryConstructSlugListUrl = (
  board_name: string,
  layout_id: number,
  size_id: number,
  set_ids: number[],
  angle: number,
): string | null =>
  tryBuildReadableClimbListPath({
    boardName: board_name,
    layoutId: layout_id,
    sizeId: size_id,
    setIds: set_ids.join(','),
    angle,
  });

/**
 * The climbs-list URL for a popular board config, id-aware first.
 *
 * A popular-config row carries both the numeric ids and the display names, and
 * the ids must win: slugging from the names collapses a shadowed size (Kilter
 * 12x12 without kickboard) onto the bare slug's first match — the other
 * physical board. The name-based form covers a row the static tables don't
 * resolve, and the numeric form is the last resort that always exists. One
 * definition, because this decision used to live as four hand-copied blocks
 * whose priority had drifted to names-first.
 */
export const popularConfigListUrl = (config: PopularBoardConfig, angle: number): string =>
  tryConstructSlugListUrl(config.boardType, config.layoutId, config.sizeId, config.setIds, angle) ??
  (config.layoutName && config.sizeName && config.setNames.length > 0
    ? constructClimbListWithSlugs(
        config.boardType,
        config.layoutName,
        config.sizeName,
        config.sizeDescription ?? undefined,
        config.setNames,
        angle,
      )
    : `/${config.boardType}/${config.layoutId}/${config.sizeId}/${config.setIds.join(',')}/${angle}/list`);

/**
 * Extracts the base board configuration path from a full pathname.
 * This removes dynamic segments that can change during a session:
 * - /view/[climb_slug] - viewing climb details
 * - /list, /create - different views
 * - /{angle} - the board angle is adjustable during a session
 *
 * The base path represents the physical board setup: /{board}/{layout}/{size}/{sets}
 *
 * This is used to determine session continuity - the WebSocket connection
 * should persist when navigating between climbs, views, or angles on the
 * same physical board configuration.
 *
 * The standalone `/play/[climb_uuid]` route was removed and replaced by the
 * play-view drawer; the `/play/` strip below is defensive cleanup for any
 * stale pathname that might still flow through here (e.g. persisted session
 * board paths) and otherwise wouldn't match.
 *
 * @example
 * getBaseBoardPath('/kilter/original/12x12/default/45/view/abc-123')
 * // => '/kilter/original/12x12/default'
 *
 * @example
 * getBaseBoardPath('/kilter/original/12x12/default/45/list')
 * // => '/kilter/original/12x12/default'
 *
 * @example
 * getBaseBoardPath('/kilter/original/12x12/default/50')
 * // => '/kilter/original/12x12/default'
 */
export function getBaseBoardPath(pathname: string): string {
  // Handle /b/{slug}/{angle}/... URLs — base path is /b/{slug}
  const boardSlugMatch = pathname.match(/^(\/b\/[^/]+)/);
  if (boardSlugMatch) {
    return boardSlugMatch[1];
  }

  // URL structure: /{board}/{layout}/{size}/{sets}/{angle}[/view/slug|/list|/create]
  // (/play/ is gone — its redirect routes catch any in-flight URLs.)
  // We want to extract: /{board}/{layout}/{size}/{sets}

  // First, strip off trailing view segments if present
  let path = pathname;

  // Defensive: strip /play/[uuid] in case a stale URL slipped through
  // (e.g. persisted in session board path before the rename).
  const playMatch = path.match(/^(.+?)\/play\/[^/]+$/);
  if (playMatch) {
    path = playMatch[1];
  } else {
    // Match /view/[uuid] or /view/[slug-uuid]
    const viewMatch = path.match(/^(.+?)\/view\/[^/]+$/);
    if (viewMatch) {
      path = viewMatch[1];
    } else {
      const listMatch = path.match(/^(.+?)\/list$/);
      if (listMatch) {
        path = listMatch[1];
      } else {
        const createMatch = path.match(/^(.+?)\/create$/);
        if (createMatch) {
          path = createMatch[1];
        }
      }
    }
  }

  // Now strip off the angle (last segment, which is a number)
  // Path is now: /{board}/{layout}/{size}/{sets}/{angle}
  const angleMatch = path.match(/^(.+?)\/\d+$/);
  if (angleMatch) {
    return angleMatch[1];
  }

  return path;
}

/**
 * Extract the angle segment from a board route pathname. Returns null when the
 * path isn't a board route (home, /you, /playlists, etc.). Used to read the
 * user's live angle off the URL, since party-mode state holds a session-creation
 * angle that doesn't follow URL changes — see queue-bridge-context.
 *
 * Supports both URL shapes:
 *   /{board}/{layout}/{size}/{sets}/{angle}/...
 *   /b/{slug}/{angle}/...
 *
 * Locale-aware: `usePathname()` in Next.js returns the original pre-rewrite
 * path including a `/es/` or `/fr/` prefix for non-English users (middleware
 * rewrites internally but the hook sees the user-facing URL). Strip the
 * locale prefix before matching so Spanish/French speakers don't fall back
 * to the session-creation angle on every navigation — the 40°-revert bug
 * this fix exists to prevent. Reads `SUPPORTED_LOCALES` so adding a new
 * locale to i18n config is sufficient; no edit here required.
 */
export function extractAngleFromPathname(pathname: string): number | null {
  const { strippedPath } = detectLocale(pathname);

  // /b/{slug}/{angle}/... — angle is the third segment.
  const slugMatch = strippedPath.match(/^\/b\/[^/]+\/(-?\d+)(?:\/|$)/);
  if (slugMatch) {
    const angle = Number(slugMatch[1]);
    return Number.isFinite(angle) ? angle : null;
  }

  // /{board}/{layout}/{size}/{sets}/{angle}/... — angle is the fifth path
  // segment (six counting the leading empty string from split('/')).
  const fullMatch = strippedPath.match(/^\/[^/]+\/[^/]+\/[^/]+\/[^/]+\/(-?\d+)(?:\/|$)/);
  if (fullMatch) {
    const angle = Number(fullMatch[1]);
    return Number.isFinite(angle) ? angle : null;
  }

  return null;
}

/**
 * Replace the angle segment in a board route pathname with `newAngle`,
 * preserving the locale prefix when present and the rest of the path
 * (the /play/{uuid}, /view/{slug}, /list, /create, /playlists/{uuid}
 * suffix). Returns `null` if the pathname isn't a recognised board
 * route — callers should treat that as "don't navigate."
 *
 * **Positional, not pattern-matched.** Splitting the path and using
 * `findIndex(s => s === currentAngle.toString())` (the previous
 * implementation in angle-selector.tsx) would match the first segment
 * with the angle's string value — for `/kilter/1/10/1/40/list` with
 * `currentAngle=1` that hits the layout id, not the angle slot. This
 * helper indexes by the known position instead.
 */
export function replaceAngleInPathname(pathname: string, newAngle: number): string | null {
  const { strippedPath, locale, needsRewrite } = detectLocale(pathname);
  const localePrefix = needsRewrite ? `/${locale}` : '';
  const segments = strippedPath.split('/');
  // segments[0] is '' (leading slash), so the first real segment is at index 1.

  // /b/{slug}/{angle}/... — angle is at index 3.
  if (segments[1] === 'b' && segments.length >= 4 && /^-?\d+$/.test(segments[3])) {
    segments[3] = String(newAngle);
    return `${localePrefix}${segments.join('/')}`;
  }

  // /{board}/{layout}/{size}/{sets}/{angle}/... — angle is at index 5.
  if (segments.length >= 6 && /^-?\d+$/.test(segments[5])) {
    segments[5] = String(newAngle);
    return `${localePrefix}${segments.join('/')}`;
  }

  return null;
}

// ============================================
// Board Entity Slug URL Constructors
// ============================================

/**
 * Construct a board slug URL for the climb list.
 * /b/{board-slug}/{angle}/list
 */
export const constructBoardSlugUrl = (slug: string, angle: number, path?: string) =>
  `/b/${slug}/${angle}${path ? `/${path}` : ''}`;

/**
 * Construct a board slug URL for the climb list.
 * /b/{board-slug}/{angle}/list
 */
export const constructBoardSlugListUrl = (slug: string, angle: number) => constructBoardSlugUrl(slug, angle, 'list');

/**
 * Construct a board slug URL for the climb view.
 * /b/{board-slug}/{angle}/view/{climb_uuid}
 */
export const constructBoardSlugViewUrl = (slug: string, angle: number, climbUuid: string, climbName?: string) => {
  if (climbName && climbName.trim()) {
    const climbSlug = generateSlugFromText(climbName.trim());
    if (climbSlug) {
      return constructBoardSlugUrl(slug, angle, `view/${climbSlug}-${climbUuid}`);
    }
  }
  return constructBoardSlugUrl(slug, angle, `view/${climbUuid}`);
};

/**
 * Construct a board slug URL for the playlists library.
 * /b/{board-slug}/{angle}/playlists
 */
export const constructBoardSlugPlaylistsUrl = (slug: string, angle: number) =>
  constructBoardSlugUrl(slug, angle, 'playlists');

const getBoardSlugRouteContext = (pathname: string): { slug: string; angle: number } | null => {
  const match = pathname.match(/^\/b\/([^/]+)\/(-?\d+)(?:\/|$)/);
  if (!match) return null;

  const angle = Number(match[2]);
  if (Number.isNaN(angle)) return null;

  return { slug: match[1], angle };
};

/**
 * Build the canonical config-tuple climb-view URL — `/{board}/{layout}/{size}/{sets}/{angle}/view/{slug-uuid}`.
 *
 * This is the tree the reposition treats as canonical (see `docs/web-reposition.md`),
 * so anything that must emit a crawlable, shareable climb link calls this
 * directly rather than `getContextAwareClimbViewUrl` — the latter keeps a
 * visitor inside `/b/{slug}` when they already are there, which is the right
 * call for in-app navigation and the wrong one for a link we want indexed.
 */
export const buildCanonicalClimbViewUrl = (
  boardDetails: BoardRouteIdentity,
  angle: number,
  climbUuid: string,
  climbName?: string,
): string => {
  // Ids first. Only the id-aware builder can emit the qualified size slug for a
  // size that shares its base slug with another on the same layout (Kilter
  // layout 1 sizes 10/27 — see `resolveSizeSlug`); the name-based builder below
  // would hand a sharer a URL that resolves to the *other* board. For every
  // other size the two agree byte for byte, so nothing else moves.
  const slugUrl = tryConstructSlugViewUrl(
    boardDetails.board_name,
    boardDetails.layout_id,
    boardDetails.size_id,
    boardDetails.set_ids,
    angle,
    climbUuid,
    climbName,
  );
  if (slugUrl) return slugUrl;

  // Names are the fallback for a board the static tables don't carry (a DB-only
  // layout), where the ids resolve to nothing to slugify.
  if (boardDetails.layout_name && boardDetails.size_name && boardDetails.set_names) {
    return constructClimbViewUrlWithSlugs(
      boardDetails.board_name,
      boardDetails.layout_name,
      boardDetails.size_name,
      boardDetails.size_description,
      boardDetails.set_names,
      angle,
      climbUuid,
      climbName,
    );
  }

  return constructClimbViewUrl(
    {
      board_name: boardDetails.board_name,
      layout_id: boardDetails.layout_id,
      size_id: boardDetails.size_id,
      set_ids: boardDetails.set_ids,
      angle,
    },
    climbUuid,
    climbName,
  );
};

/**
 * Build the canonical config-tuple climb-list URL — `/{board}/{layout}/{size}/{sets}/{angle}/list`.
 *
 * The list twin of `buildCanonicalClimbViewUrl`, and it exists for the same
 * reason: both `/list` front doors (the config-tuple tree and `/b/{slug}`) must
 * emit ONE canonical string for a board config, and the only way to prove that
 * is to have both call the same function. `/b/{slug}` names a board a user
 * owns, not a climb config — most configs have no `/b` URL and popular ones
 * have many — so the config-tuple tree is the consolidation target.
 */
export const buildCanonicalClimbListUrl = (boardDetails: BoardRouteIdentity, angle: number): string => {
  // Ids first, for the same shadowed-size reason as the view builder: only the
  // id-aware path emits the qualified size slug for a size that shares its base
  // slug with another on the same layout (Kilter layout 1 sizes 10/27).
  const slugUrl = tryConstructSlugListUrl(
    boardDetails.board_name,
    boardDetails.layout_id,
    boardDetails.size_id,
    boardDetails.set_ids,
    angle,
  );
  if (slugUrl) return slugUrl;

  if (boardDetails.layout_name && boardDetails.size_name && boardDetails.set_names) {
    return constructClimbListWithSlugs(
      boardDetails.board_name,
      boardDetails.layout_name,
      boardDetails.size_name,
      boardDetails.size_description,
      boardDetails.set_names,
      angle,
    );
  }

  return `/${boardDetails.board_name}/${boardDetails.layout_id}/${boardDetails.size_id}/${boardDetails.set_ids.join(',')}/${angle}/list`;
};

/**
 * Build a climb-view URL that preserves board-slug routing context when present.
 * - On /b/{slug}/{angle}/... routes, returns /b/{slug}/{angle}/view/{slug-uuid|uuid}
 * - Otherwise, falls back to canonical board URLs.
 */
export const getContextAwareClimbViewUrl = (
  pathname: string,
  boardDetails: BoardRouteIdentity,
  angle: number,
  climbUuid: string,
  climbName?: string,
): string => {
  const boardSlugRoute = getBoardSlugRouteContext(pathname);
  if (boardSlugRoute) {
    return constructBoardSlugViewUrl(boardSlugRoute.slug, boardSlugRoute.angle, climbUuid, climbName);
  }

  return buildCanonicalClimbViewUrl(boardDetails, angle, climbUuid, climbName);
};

/**
 * Extract the playlists base path from the current pathname.
 * - On a /b/{slug}/{angle}/... route → /b/{slug}/{angle}/playlists
 * - On an old-style /{board}/{layout}/{size}/{sets}/{angle}/... route → /{board}/{layout}/{size}/{sets}/{angle}/playlists
 * - Otherwise → /playlists
 */
export const getPlaylistsBasePath = (pathname: string): string => {
  // Board slug route: /b/{slug}/{angle}/...
  if (pathname.startsWith('/b/')) {
    const segments = pathname.split('/');
    if (segments.length >= 4) {
      return `/b/${segments[2]}/${segments[3]}/playlists`;
    }
  }

  // Old-style route: /{board_name}/{layout_id}/{size_id}/{set_ids}/{angle}/...
  const oldStyleMatch = pathname.match(/^\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)/);
  if (oldStyleMatch) {
    const [, boardName] = oldStyleMatch;
    const validBoardNames: readonly string[] = [
      'kilter',
      'tension',
      'moonboard',
      'decoy',
      'touchstone',
      'grasshopper',
    ] satisfies readonly BoardName[];
    if (validBoardNames.includes(boardName)) {
      return `/${oldStyleMatch.slice(1, 6).join('/')}/playlists`;
    }
  }

  return '/playlists';
};

/**
 * Build a context-aware URL for a specific playlist detail page.
 * Uses the current pathname to determine whether to use board-scoped or global URL.
 */
export const getContextAwarePlaylistUrl = (pathname: string, playlistUuid: string): string =>
  `${getPlaylistsBasePath(pathname)}/${playlistUuid}`;
