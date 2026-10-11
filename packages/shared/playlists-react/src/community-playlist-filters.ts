import type { DiscoverPlaylistsInput } from '@boardsesh/graphql/operations/playlists';

/**
 * The browse filters for the full Community Playlists list, as one object.
 *
 * Every field maps onto `discoverPlaylists` input in
 * `buildCommunityPlaylistsInput`; the screen only owns this object and never
 * builds server input itself. Adding a filter means: a field here, its default
 * in `DEFAULT_COMMUNITY_PLAYLIST_FILTERS`, its mapping in
 * `buildCommunityPlaylistsInput`, its place in `hasActiveCommunityPlaylistFilters`,
 * and (if it needs viewer data) a field on `CommunityPlaylistsContext`. The
 * follow list is not viewer data the client sends: `following` maps to
 * `followedOnly` and the server resolves who the viewer follows.
 */
export type CommunityPlaylistFilters = {
  /** Free-text title search. Trimmed and capped before it reaches the server. */
  search: string;
  /** Whose playlists to show. */
  creator: CommunityPlaylistCreatorScope;
  sort: CommunityPlaylistSort;
  size: CommunityPlaylistSize;
  /**
   * Lowest grade (difficulty id) a playlist's band may start at, or null for
   * no floor. The server checks it against the playlist's 10th-percentile
   * grade, so one easy warm-up doesn't let a hard list in.
   */
  minGrade: number | null;
  /** Highest grade the band may end at (its 90th percentile), or null for no ceiling. */
  maxGrade: number | null;
};

/**
 * Whose playlists the list shows. `everyone` leaves the viewer's own out (they
 * have My Playlists for those); `mine` shows only the viewer's public ones;
 * `following` shows the climbers the viewer follows, resolved on the server.
 * `mine` and `following` need a signed-in viewer.
 */
export type CommunityPlaylistCreatorScope = 'everyone' | 'mine' | 'following';

/** `popular` matches the Discover shelf's default; `recent` is newest first. */
export type CommunityPlaylistSort = 'popular' | 'recent';

/** Climb-count bands. See `COMMUNITY_PLAYLIST_SIZE_BANDS` for the numbers. */
export type CommunityPlaylistSize = 'any' | 'short' | 'session' | 'big';

/**
 * The most climbs a community playlist can hold and still be listed. Bigger
 * lists are data exports with a playlist's name on them (a 600-climb
 * "favorites" dump), not something to climb through, so every band stops here.
 *
 * Only this full list applies it. The Discover hub's community shelf
 * (`useDiscoverPlaylists`) still sends no cap: adding one changes the shelf's
 * request variables, which the pinned App Store screenshot recordings are
 * keyed on, so it waits for a re-record.
 */
export const COMMUNITY_PLAYLIST_MAX_CLIMBS = 150;

/** Inclusive climb-count bounds per size band. The copy under the filters is built from these. */
export const COMMUNITY_PLAYLIST_SIZE_BANDS: Record<CommunityPlaylistSize, { minClimbs?: number; maxClimbs?: number }> =
  {
    any: { maxClimbs: COMMUNITY_PLAYLIST_MAX_CLIMBS },
    short: { maxClimbs: 10 },
    session: { minClimbs: 11, maxClimbs: 30 },
    big: { minClimbs: 31, maxClimbs: COMMUNITY_PLAYLIST_MAX_CLIMBS },
  };

export const DEFAULT_COMMUNITY_PLAYLIST_FILTERS: CommunityPlaylistFilters = {
  search: '',
  creator: 'everyone',
  sort: 'popular',
  size: 'any',
  minGrade: null,
  maxGrade: null,
};

/** The server rejects a longer `name` (backend `DiscoverPlaylistsInputSchema`). */
export const COMMUNITY_PLAYLIST_SEARCH_MAX_LENGTH = 100;

/** Who is looking, and at which board. Not a filter the climber picks. */
export type CommunityPlaylistsContext = {
  /** The signed-in viewer's user id, or null when signed out. */
  viewerId: string | null;
  boardType?: string;
  layoutId?: number;
};

/** `discoverPlaylists` input for one filter state, without the page cursor. */
export type CommunityPlaylistsInput = Omit<DiscoverPlaylistsInput, 'page' | 'pageSize'>;

/**
 * The creator scope that actually applies. `mine` and `following` need a
 * viewer, so a signed-out viewer (or one who signed out with either picked)
 * gets `everyone`.
 */
export function effectiveCommunityCreatorScope(
  filters: CommunityPlaylistFilters,
  context: Pick<CommunityPlaylistsContext, 'viewerId'>,
): CommunityPlaylistCreatorScope {
  if (filters.creator !== 'everyone' && !context.viewerId) return 'everyone';
  return filters.creator;
}

/** Maps the climber's filters onto `discoverPlaylists` input. Pure. */
export function buildCommunityPlaylistsInput(
  filters: CommunityPlaylistFilters,
  context: CommunityPlaylistsContext,
): CommunityPlaylistsInput {
  const input: CommunityPlaylistsInput = {
    // Community means climber-made: generated recommendation lists have their
    // own shelf, same as the Discover hub.
    generatedRecommendation: false,
    sortBy: filters.sort,
  };
  if (context.boardType !== undefined) input.boardType = context.boardType;
  if (context.layoutId !== undefined) input.layoutId = context.layoutId;

  const search = filters.search.trim().slice(0, COMMUNITY_PLAYLIST_SEARCH_MAX_LENGTH);
  if (search.length > 0) input.name = search;

  const scope = effectiveCommunityCreatorScope(filters, context);
  if (scope === 'mine' && context.viewerId) {
    input.creatorIds = [context.viewerId];
  } else if (scope === 'following') {
    // Nobody can follow themselves, so this never includes the viewer.
    input.followedOnly = true;
  } else if (scope === 'everyone' && context.viewerId) {
    input.excludeCreatorIds = [context.viewerId];
  }

  const band = COMMUNITY_PLAYLIST_SIZE_BANDS[filters.size];
  if (band.minClimbs !== undefined) input.minClimbs = band.minClimbs;
  if (band.maxClimbs !== undefined) input.maxClimbs = band.maxClimbs;

  if (filters.minGrade !== null) input.minGrade = filters.minGrade;
  if (filters.maxGrade !== null) input.maxGrade = filters.maxGrade;

  return input;
}

/**
 * True when the filters narrow the list beyond the defaults, ignoring sort
 * (a sort never hides a playlist). Drives the "Clear filters" action.
 */
export function hasActiveCommunityPlaylistFilters(filters: CommunityPlaylistFilters): boolean {
  return (
    filters.search.trim().length > 0 ||
    filters.creator !== DEFAULT_COMMUNITY_PLAYLIST_FILTERS.creator ||
    filters.size !== DEFAULT_COMMUNITY_PLAYLIST_FILTERS.size ||
    filters.minGrade !== null ||
    filters.maxGrade !== null
  );
}

/**
 * Resets everything that narrows the list and keeps the chosen sort, so
 * "Clear filters" doesn't also flip the order the climber picked.
 */
export function clearCommunityPlaylistFilters(filters: CommunityPlaylistFilters): CommunityPlaylistFilters {
  return { ...DEFAULT_COMMUNITY_PLAYLIST_FILTERS, sort: filters.sort };
}
