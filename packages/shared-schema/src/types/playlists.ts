import type { ClimbSearchInput } from './climb';

// Playlist types

export type SearchPlaylistsInput = {
  query: string;
  boardType?: string;
  limit?: number;
  offset?: number;
};

export type DiscoverablePlaylist = {
  id: string;
  uuid: string;
  boardType: string;
  layoutId?: number | null;
  name: string;
  description?: string;
  color?: string;
  icon?: string;
  createdAt: string;
  updatedAt: string;
  climbCount: number;
  creatorId: string;
  creatorName: string;
  isGeneratedRecommendation: boolean;
};

export type SearchPlaylistsResult = {
  playlists: DiscoverablePlaylist[];
  totalCount: number;
  hasMore: boolean;
};

/** How a playlist's climbs are ordered. `position` is the playlist's own order. */
export type PlaylistClimbSort = 'position' | 'added' | 'difficulty' | 'quality' | 'ascents' | 'name' | 'random';

/**
 * Sort and filters for a playlist's climbs (`GetPlaylistClimbsInput.view`).
 *
 * The filter fields are the {@link ClimbSearchInput} filters a playlist can
 * apply, under the same names, so one mapper fills both. `onlyActiveBoard` is
 * the playlist's own: only the climbs that fit the active board.
 */
export type PlaylistClimbViewInput = Pick<
  ClimbSearchInput,
  | 'sortOrder'
  | 'sortSeed'
  | 'name'
  | 'minGrade'
  | 'maxGrade'
  | 'gradeAccuracy'
  | 'gradeSource'
  | 'useMyGrades'
  | 'minAscents'
  | 'minRating'
  | 'onlyBenchmarks'
  | 'setter'
  | 'onlyFollowedAuthors'
  | 'onlyTallClimbs'
  | 'onlyWideClimbs'
  | 'onlyWithBetaVideos'
  | 'boulders'
  | 'routes'
  | 'projectsOnly'
  | 'hideAttempted'
  | 'hideCompleted'
  | 'showOnlyAttempted'
  | 'showOnlyCompleted'
  | 'minUserRating'
  | 'onlyRatedByMe'
  | 'onlyFavorited'
  | 'holdsFilter'
  | 'zoneBox'
  | 'zoneMode'
> & {
  sortBy?: PlaylistClimbSort;
  onlyActiveBoard?: boolean;
};
