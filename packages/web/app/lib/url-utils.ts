import {
  BoardRouteParameters,
  ParsedBoardRouteParametersWithUuid,
  ParsedBoardRouteParameters,
  BoardRouteParametersWithUuid,
  SearchRequestPagination,
  ClimbUuid,
  BoardDetails,
  BoardRouteIdentity,
  BoardName,
} from '@/app/lib/types';
import { BOARD_NAME_PREFIX_REGEX } from '@/app/lib/board-constants';
import { getBoardDetailsForBoard } from '@/app/lib/board-utils';
import { MOONBOARD_LAYOUTS } from '@/app/lib/moonboard-config';
import { PAGE_LIMIT } from '../components/board-page/constants';

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

export const searchParamsToUrlParams = ({
  gradeAccuracy = DEFAULT_SEARCH_PARAMS.gradeAccuracy,
  maxGrade = DEFAULT_SEARCH_PARAMS.maxGrade,
  minGrade = DEFAULT_SEARCH_PARAMS.minGrade,
  minAscents = DEFAULT_SEARCH_PARAMS.minAscents,
  minRating = DEFAULT_SEARCH_PARAMS.minRating,
  sortBy,
  sortOrder,
  name,
  onlyClassics,
  onlyTallClimbs,
  settername,
  setternameSuggestion,
  holdsFilter,
  hideAttempted,
  hideCompleted,
  showOnlyAttempted,
  showOnlyCompleted,
  onlyDrafts,
  projectsOnly,
  page,
  pageSize,
}: SearchRequestPagination): URLSearchParams => {
  const params: Record<string, string> = {};

  // Only add parameters that differ from defaults
  if (gradeAccuracy !== DEFAULT_SEARCH_PARAMS.gradeAccuracy) {
    params.gradeAccuracy = gradeAccuracy.toString();
  }
  if (maxGrade !== DEFAULT_SEARCH_PARAMS.maxGrade) {
    params.maxGrade = maxGrade.toString();
  }
  if (minGrade !== DEFAULT_SEARCH_PARAMS.minGrade) {
    params.minGrade = minGrade.toString();
  }
  if (minAscents !== DEFAULT_SEARCH_PARAMS.minAscents) {
    params.minAscents = minAscents.toString();
  }
  if (minRating !== DEFAULT_SEARCH_PARAMS.minRating) {
    params.minRating = minRating.toString();
  }
  if (sortBy !== DEFAULT_SEARCH_PARAMS.sortBy) {
    params.sortBy = sortBy;
  }
  if (sortOrder !== DEFAULT_SEARCH_PARAMS.sortOrder) {
    params.sortOrder = sortOrder;
  }
  if (name && name !== DEFAULT_SEARCH_PARAMS.name) {
    params.name = name;
  }
  if (onlyClassics !== DEFAULT_SEARCH_PARAMS.onlyClassics) {
    params.onlyClassics = onlyClassics.toString();
  }
  if (onlyTallClimbs !== DEFAULT_SEARCH_PARAMS.onlyTallClimbs) {
    params.onlyTallClimbs = onlyTallClimbs.toString();
  }
  if (settername && settername.length > 0) {
    params.settername = settername.join(',');
  }
  if (setternameSuggestion && setternameSuggestion !== DEFAULT_SEARCH_PARAMS.setternameSuggestion) {
    params.setternameSuggestion = setternameSuggestion;
  }
  if (page !== DEFAULT_SEARCH_PARAMS.page) {
    params.page = page.toString();
  }
  if (pageSize !== DEFAULT_SEARCH_PARAMS.pageSize) {
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

  // Add holds filter entries only if they exist
  if (holdsFilter && Object.keys(holdsFilter).length > 0) {
    Object.entries(holdsFilter).forEach(([key, value]) => {
      params[`hold_${key}`] = value.state;
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
  name: '',
  onlyClassics: false,
  onlyTallClimbs: false,
  settername: [],
  setternameSuggestion: '',
  holdsFilter: {},
  hideAttempted: false,
  hideCompleted: false,
  showOnlyAttempted: false,
  showOnlyCompleted: false,
  onlyDrafts: false,
  projectsOnly: false,
  page: 0,
  pageSize: PAGE_LIMIT,
};

export const urlParamsToSearchParams = (urlParams: URLSearchParams): SearchRequestPagination => {
  const holdsFilter = Object.fromEntries(
    Array.from(urlParams.entries())
      .filter(([key]) => key.startsWith('hold_'))
      .map(([key, value]) => [key.replace('hold_', ''), value]),
  );

  return {
    ...DEFAULT_SEARCH_PARAMS,
    gradeAccuracy: Number(urlParams.get('gradeAccuracy') ?? DEFAULT_SEARCH_PARAMS.gradeAccuracy),
    maxGrade: Number(urlParams.get('maxGrade') ?? DEFAULT_SEARCH_PARAMS.maxGrade),
    minAscents: Number(urlParams.get('minAscents') ?? DEFAULT_SEARCH_PARAMS.minAscents),
    minGrade: Number(urlParams.get('minGrade') ?? DEFAULT_SEARCH_PARAMS.minGrade),
    minRating: Number(urlParams.get('minRating') ?? DEFAULT_SEARCH_PARAMS.minRating),
    sortBy: (urlParams.get('sortBy') ?? DEFAULT_SEARCH_PARAMS.sortBy) as
      | 'ascents'
      | 'difficulty'
      | 'name'
      | 'quality'
      | 'popular',
    sortOrder: (urlParams.get('sortOrder') ?? DEFAULT_SEARCH_PARAMS.sortOrder) as 'asc' | 'desc',
    name: urlParams.get('name') ?? DEFAULT_SEARCH_PARAMS.name,
    onlyClassics: urlParams.get('onlyClassics') === 'true',
    onlyTallClimbs: urlParams.get('onlyTallClimbs') === 'true',
    settername:
      urlParams
        .get('settername')
        ?.split(',')
        .filter((s) => s.length > 0) ?? DEFAULT_SEARCH_PARAMS.settername,
    setternameSuggestion: urlParams.get('setternameSuggestion') ?? DEFAULT_SEARCH_PARAMS.setternameSuggestion,
    //@ts-expect-error fix later
    holdsFilter: holdsFilter ?? DEFAULT_SEARCH_PARAMS.holdsFilter,
    hideAttempted: urlParams.get('hideAttempted') === 'true',
    hideCompleted: urlParams.get('hideCompleted') === 'true',
    showOnlyAttempted: urlParams.get('showOnlyAttempted') === 'true',
    showOnlyCompleted: urlParams.get('showOnlyCompleted') === 'true',
    onlyDrafts: urlParams.get('onlyDrafts') === 'true',
    projectsOnly: urlParams.get('projectsOnly') === 'true',
    page: Number(urlParams.get('page') ?? DEFAULT_SEARCH_PARAMS.page),
    pageSize: Number(urlParams.get('pageSize') ?? DEFAULT_SEARCH_PARAMS.pageSize),
  };
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

  return {
    ...DEFAULT_SEARCH_PARAMS,
    ...urlParams,
    settername,
    gradeAccuracy: Number(urlParams.gradeAccuracy ?? DEFAULT_SEARCH_PARAMS.gradeAccuracy),
    maxGrade: Number(urlParams.maxGrade ?? DEFAULT_SEARCH_PARAMS.maxGrade),
    minAscents: Number(urlParams.minAscents ?? DEFAULT_SEARCH_PARAMS.minAscents),
    minGrade: Number(urlParams.minGrade ?? DEFAULT_SEARCH_PARAMS.minGrade),
    minRating: Number(urlParams.minRating ?? DEFAULT_SEARCH_PARAMS.minRating),
    page: Number(urlParams.page ?? DEFAULT_SEARCH_PARAMS.page),
    pageSize: Number(urlParams.pageSize ?? DEFAULT_SEARCH_PARAMS.pageSize),
    // Next.js route search params come as strings, so coerce to boolean
    onlyTallClimbs: String(urlParams.onlyTallClimbs) === 'true',
  };
};

export const constructClimbViewUrl = (
  { board_name, layout_id, angle, size_id, set_ids }: ParsedBoardRouteParameters,
  climb_uuid: ClimbUuid,
  climbName?: string,
) => {
  const baseUrl = `/${board_name}/${layout_id}/${size_id}/${set_ids}/${angle}/view/`;
  if (climbName && climbName.trim()) {
    const slug = generateSlugFromText(climbName.trim());
    if (slug) {
      return `${baseUrl}${slug}-${climb_uuid}`;
    }
  }
  return `${baseUrl}${climb_uuid}`;
};

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

//`/${board_name}/${layout_id}/${size_id}/${set_ids}/${angle}/info/${climb_uuid}`;

export const constructSetterStatsUrl = (
  { board_name, layout_id, angle, size_id, set_ids }: ParsedBoardRouteParameters,
  searchQuery?: string,
) => {
  const baseUrl = `/api/v1/${board_name}/${layout_id}/${size_id}/${set_ids}/${angle}/setters`;
  return searchQuery ? `${baseUrl}?search=${encodeURIComponent(searchQuery)}` : baseUrl;
};

export const constructClimbListWithSlugs = (
  board_name: string,
  layoutName: string,
  sizeName: string,
  sizeDescription: string | undefined,
  setNames: string[],
  angle: number,
  viewMode: 'list' | 'grid' = 'list',
) => {
  const layoutSlug = generateLayoutSlug(layoutName);
  const sizeSlug = generateSizeSlug(sizeName, sizeDescription);
  const setSlug = generateSetSlug(setNames);
  return `/${board_name}/${layoutSlug}/${sizeSlug}/${setSlug}/${angle}/${viewMode}`;
};

/**
 * Generates a slug from a text string by normalizing it.
 * This is a shared helper used by size slug generation.
 */
export const generateSlugFromText = (text: string): string => {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
};

/**
 * Generates a description slug, removing "LED Kit" suffix.
 * This is a shared helper used by size slug generation.
 */
export const generateDescriptionSlug = (description: string): string => {
  return description
    .toLowerCase()
    .replace(/led\s*kit/gi, '') // Remove "LED Kit" suffix
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
};

export const generateLayoutSlug = (layoutName: string): string => {
  const baseSlug = layoutName
    .toLowerCase()
    .trim()
    .replace(BOARD_NAME_PREFIX_REGEX, '') // Remove board name prefix
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  // Handle Tension board specific cases
  if (baseSlug === 'original-layout') {
    return 'original';
  }

  // Replace numbers with words for better readability
  if (baseSlug.startsWith('2-')) {
    return baseSlug.replace('2-', 'two-');
  }

  return baseSlug;
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

export const generateSizeSlug = (sizeName: string, description?: string): string => {
  // Extract size dimensions (e.g., "12 x 12 Commercial" -> "12x12")
  const sizeMatch = sizeName.match(/(\d+)\s*x\s*(\d+)/i);
  let baseSlug = '';

  if (sizeMatch) {
    baseSlug = `${sizeMatch[1]}x${sizeMatch[2]}`;
  } else {
    // Fallback to general slug generation
    baseSlug = generateSlugFromText(sizeName);
  }

  // Append description suffix if provided (for disambiguating sizes with same dimensions)
  if (description && description.trim()) {
    const descSlug = generateDescriptionSlug(description);

    if (descSlug) {
      return `${baseSlug}-${descSlug}`;
    }
  }

  return baseSlug;
};

export const generateSetSlug = (setNames: string[]): string => {
  return setNames
    .map((name) => {
      const lowercaseName = name.toLowerCase().trim();

      // Handle homewall-specific set names (supports both "Auxiliary/Mainline" and "Aux/Main" variants)
      const hasAux = lowercaseName.includes('auxiliary') || lowercaseName.includes('aux');
      const hasMain = lowercaseName.includes('mainline') || lowercaseName.includes('main');
      // Support both "kickboard" and "kicker" in set names (different sizes use different naming)
      const hasKickerVariant = lowercaseName.includes('kickboard') || lowercaseName.includes('kicker');

      if (hasAux && hasKickerVariant) {
        return 'aux-kicker';
      }
      if (hasMain && hasKickerVariant) {
        return 'main-kicker';
      }
      if (hasAux) {
        return 'aux';
      }
      if (hasMain) {
        return 'main';
      }

      // Handle original kilter/tension set names
      let result = lowercaseName
        .replace(/\s+ons?$/i, '') // Remove "on" or "ons" suffix
        .replace(/\s+/g, '-'); // Replace spaces with hyphens

      // Extract just 'bolt' or 'screw' if it starts with those
      if (result.startsWith('bolt')) {
        result = 'bolt';
      } else if (result.startsWith('screw')) {
        result = 'screw';
      }

      return result;
    })
    .sort((a, b) => b.localeCompare(a)) // Sort alphabetically descending
    .join('_'); // Use underscore as delimiter between sets
};

export const extractUuidFromSlug = (slugOrUuid: string): string => {
  // Match 32 hex characters (UUID without hyphens) - could be at end of string or standalone
  const uuidRegex = /[0-9A-F]{32}/i;
  const match = slugOrUuid.match(uuidRegex);
  return match ? match[0] : slugOrUuid;
};

export const isUuidOnly = (slugOrUuid: string): boolean => {
  // Check if it's exactly 32 hex characters (UUID format in the database)
  const uuidRegex = /^[0-9A-F]{32}$/i;
  return uuidRegex.test(slugOrUuid);
};

// Helper functions to determine if a parameter is numeric (old format) or slug (new format)
export const isNumericId = (value: string): boolean => {
  return /^\d+$/.test(value);
};

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

export const constructPlayUrlWithSlugs = (
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

  const baseUrl = `/${board_name}/${layoutSlug}/${sizeSlug}/${setSlug}/${angle}/play/`;
  if (climbName && climbName.trim()) {
    const climbSlug = generateSlugFromText(climbName.trim());
    if (climbSlug) {
      return `${baseUrl}${climbSlug}-${climb_uuid}`;
    }
  }
  return `${baseUrl}${climb_uuid}`;
};

export const constructCreateClimbUrl = (
  board_name: string,
  layoutName: string,
  sizeName: string,
  sizeDescription: string | undefined,
  setNames: string[],
  angle: number,
  forkParams?: { frames: string; name: string; description?: string; editClimbUuid?: string },
) => {
  const layoutSlug = generateLayoutSlug(layoutName);
  const sizeSlug = generateSizeSlug(sizeName, sizeDescription);
  const setSlug = generateSetSlug(setNames);
  const baseUrl = `/${board_name}/${layoutSlug}/${sizeSlug}/${setSlug}/${angle}/create`;

  if (forkParams) {
    const params = new URLSearchParams({
      forkFrames: forkParams.frames,
      forkName: forkParams.name,
    });
    if (forkParams.description) params.set('forkDescription', forkParams.description);
    if (forkParams.editClimbUuid) params.set('editClimbUuid', forkParams.editClimbUuid);
    return `${baseUrl}?${params.toString()}`;
  }

  return baseUrl;
};

/** BoardDetails with slug fields guaranteed to be present. */
type ResolvedBoardSlugs = BoardDetails & Required<Pick<BoardDetails, 'layout_name' | 'size_name' | 'set_names'>>;

/**
 * Resolve slug-ready board details from static data.
 * Returns null if the lookup fails or the result lacks slug fields.
 */
const tryResolveBoardSlugs = (
  board_name: string,
  layout_id: number,
  size_id: number,
  set_ids: number[],
): ResolvedBoardSlugs | null => {
  try {
    const details = getBoardDetailsForBoard({ board_name, layout_id, size_id, set_ids });
    if (details.layout_name && details.size_name && details.set_names) {
      return details as ResolvedBoardSlugs;
    }
  } catch {
    // Static data lookup failed for this board config
  }
  return null;
};

/** Try to construct a slug-based play URL. Returns null if resolution fails. */
export const tryConstructSlugPlayUrl = (
  board_name: string,
  layout_id: number,
  size_id: number,
  set_ids: number[],
  angle: number,
  climb_uuid: string,
  climbName?: string,
): string | null => {
  const d = tryResolveBoardSlugs(board_name, layout_id, size_id, set_ids);
  return d
    ? constructPlayUrlWithSlugs(
        d.board_name,
        d.layout_name,
        d.size_name,
        d.size_description,
        d.set_names,
        angle,
        climb_uuid,
        climbName,
      )
    : null;
};

/** Try to construct a slug-based view URL. Returns null if resolution fails. */
export const tryConstructSlugViewUrl = (
  board_name: string,
  layout_id: number,
  size_id: number,
  set_ids: number[],
  angle: number,
  climb_uuid: string,
  climbName?: string,
): string | null => {
  const d = tryResolveBoardSlugs(board_name, layout_id, size_id, set_ids);
  return d
    ? constructClimbViewUrlWithSlugs(
        d.board_name,
        d.layout_name,
        d.size_name,
        d.size_description,
        d.set_names,
        angle,
        climb_uuid,
        climbName,
      )
    : null;
};

/** Try to construct a slug-based list URL. Returns null if resolution fails. */
export const tryConstructSlugListUrl = (
  board_name: string,
  layout_id: number,
  size_id: number,
  set_ids: number[],
  angle: number,
  viewMode: 'list' | 'grid' = 'list',
): string | null => {
  const d = tryResolveBoardSlugs(board_name, layout_id, size_id, set_ids);
  return d
    ? constructClimbListWithSlugs(
        d.board_name,
        d.layout_name,
        d.size_name,
        d.size_description,
        d.set_names,
        angle,
        viewMode,
      )
    : null;
};

/**
 * Extracts the base board configuration path from a full pathname.
 * This removes dynamic segments that can change during a session:
 * - /play/[climb_uuid] - viewing different climbs
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
 * @example
 * getBaseBoardPath('/kilter/original/12x12/default/45/play/abc-123')
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

  // URL structure: /{board}/{layout}/{size}/{sets}/{angle}[/play/uuid|/view/slug|/list|/grid|/create]
  // We want to extract: /{board}/{layout}/{size}/{sets}

  // First, strip off trailing view segments if present
  let path = pathname;

  // Match /play/[uuid] or /play/[slug-uuid]
  const playMatch = path.match(/^(.+?)\/play\/[^/]+$/);
  if (playMatch) {
    path = playMatch[1];
  } else {
    // Match /view/[uuid] or /view/[slug-uuid]
    const viewMatch = path.match(/^(.+?)\/view\/[^/]+$/);
    if (viewMatch) {
      path = viewMatch[1];
    } else {
      const listMatch = path.match(/^(.+?)\/(list|grid)$/);
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
 * Construct a board slug URL for the climb browse view.
 * /b/{board-slug}/{angle}/list or /b/{board-slug}/{angle}/grid
 */
export const constructBoardSlugListUrl = (slug: string, angle: number, viewMode: 'list' | 'grid' = 'list') =>
  constructBoardSlugUrl(slug, angle, viewMode);

/**
 * Construct a board slug URL for the play view.
 * /b/{board-slug}/{angle}/play/{climb_uuid}
 */
export const constructBoardSlugPlayUrl = (slug: string, angle: number, climbUuid: string) =>
  constructBoardSlugUrl(slug, angle, `play/${climbUuid}`);

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

  // Try resolving names from static data
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
