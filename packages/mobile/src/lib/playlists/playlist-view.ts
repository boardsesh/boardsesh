// What a playlist screen's filter session turns into: the `view` the
// playlistClimbs query carries, the activation source id that follows it, and
// which empty state a filtered-to-nothing list shows. Pure, so each rule is a
// unit test away.

import {
  DEFAULT_CLIMB_FILTER_STATE,
  countActivePlaylistFilters,
  flagsToProgress,
  toPlaylistClimbViewInput,
  type PlaylistSortOption,
} from '@boardsesh/climb-filters';
import type { PlaylistClimbViewInput } from '@boardsesh/shared-schema';
import type { ClimbFilters } from '../climb-filter-types';
import type { ClimbFilterSessionSelection } from '../climb-filter-session-reducer';

export type PlaylistSelection = ClimbFilterSessionSelection<PlaylistSortOption>;

/**
 * The filters a playlist starts from: the Climbs defaults with routes on, since
 * a playlist lists everything its owner put in it. The sort fields stay on the
 * Climbs defaults and never move (the playlist sort lives apart), so they are
 * inert in every count and token.
 */
export const PLAYLIST_FILTER_DEFAULTS: ClimbFilters = { ...DEFAULT_CLIMB_FILTER_STATE, routes: true };

export type PlaylistViewOptions = {
  /** The climber's "use my grades" preference. */
  personalGrades?: boolean;
  /** Whether rows show Boardsesh grades. */
  boardseshGrades?: boolean;
};

/**
 * The `view` for a playlist request, or `undefined` for the playlist's own order
 * with no filter, so a plain request stays byte-identical to the one sent
 * before views existed.
 */
export function toPlaylistViewInput(
  selection: PlaylistSelection,
  options: PlaylistViewOptions = {},
): PlaylistClimbViewInput | undefined {
  return toPlaylistClimbViewInput(
    {
      ...selection.filters,
      sortBy: selection.sort.sortBy,
      sortOrder: selection.sort.sortOrder,
      sortSeed: selection.sort.sortSeed,
      onlyActiveBoard: selection.boardFit || undefined,
    },
    {
      name: selection.name,
      personalGrades: options.personalGrades,
      boardseshGrades: options.boardseshGrades,
      boardFilters: selection.boardFilters,
    },
  );
}

/** A stable string for a view: the activation source id and the scroll reset key. Null for no view. */
export function playlistViewKey(view: PlaylistClimbViewInput | undefined): string | null {
  return view ? JSON.stringify(view) : null;
}

/**
 * The play drawer's source id for a playlist. The plain `playlist:<uuid>` for
 * the playlist's own order; with a view the key rides along, so a sorted or
 * filtered track is a different source from the plain one and swiping follows
 * the rows on screen.
 */
export function playlistSourceId(playlistUuid: string, viewKey: string | null): string {
  return viewKey ? `playlist:${playlistUuid}|${viewKey}` : `playlist:${playlistUuid}`;
}

/**
 * The source id error reports name a list by: the id without a view key (see
 * `playlistSourceId`). A view can carry the climber's typed name search.
 */
export function sourceIdForReports(sourceId: string): string {
  const viewStart = sourceId.indexOf('|');
  return viewStart === -1 ? sourceId : sourceId.slice(0, viewStart);
}

/** Which empty state a filtered-to-nothing playlist shows. */
export type PlaylistEmptyKind = 'noMatch' | 'allSent' | 'noName' | 'noBoardFit';

/**
 * - Only a name search: "No climb called …".
 * - Only "Fits my board": "None of these fit your board."
 * - Only Your progress on Unsent: "You've sent everything on this list."
 * - Anything else: "Nothing here fits those filters."
 */
export function playlistEmptyKind(selection: PlaylistSelection): PlaylistEmptyKind {
  const hasName = selection.name.trim().length > 0;
  const filterCount = countActivePlaylistFilters(
    { ...selection.filters, sortBy: selection.sort.sortBy, sortOrder: selection.sort.sortOrder },
    selection.boardFilters,
  );
  if (hasName && !selection.boardFit && filterCount === 0) return 'noName';
  if (selection.boardFit && !hasName && filterCount === 0) return 'noBoardFit';
  if (!hasName && !selection.boardFit && filterCount === 1 && flagsToProgress(selection.filters) === 'unsent') {
    return 'allSent';
  }
  return 'noMatch';
}
