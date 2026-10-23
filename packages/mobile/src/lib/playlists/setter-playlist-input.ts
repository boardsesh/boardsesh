import { getBoardCapabilities } from '@boardsesh/board-config';
import { mergeBoardFilters, toClimbSearchInput } from '@boardsesh/climb-filters';
import type { ClimbSearchInput } from '@boardsesh/shared-schema';
import { filtersForBoard } from '../climb-filter-types';
import { normalizeSearchName } from '../search-name';
import { hasActiveSessionFilters, PLAYLIST_FILTER_DEFAULTS } from './playlist-view';
import { DEFAULT_SETTER_SORT, type SetterSelection } from './setter-sort-model';

/** The filters a setter page starts from: a playlist's (both climb types, nothing narrowed). */
export const SETTER_FILTER_DEFAULTS = PLAYLIST_FILTER_DEFAULTS;

/** The sort and filters the climber picked on a setter page (#6651). */
export type SetterPlaylistView = {
  selection: SetterSelection;
  /** The climber's "use my grades" preference. */
  personalGrades?: boolean;
};

type SetterPlaylistBoard = Pick<ClimbSearchInput, 'boardName' | 'layoutId' | 'sizeId' | 'setIds' | 'angle'>;

/** True when the page shows anything but its own order: a sort or a filter. */
export function isSetterViewActive(selection: SetterSelection): boolean {
  return (
    selection.sort.sortBy !== DEFAULT_SETTER_SORT.sortBy ||
    selection.sort.sortOrder !== DEFAULT_SETTER_SORT.sortOrder ||
    hasActiveSessionFilters(selection, SETTER_FILTER_DEFAULTS)
  );
}

/**
 * The search a setter's page runs: every climb they set on this board, newest
 * first, plus the sort and filters the climber picked in the page's own sheet.
 * Nothing from the Climbs tab's sheet ever reaches it.
 *
 * With no view (or the page's own order with nothing filtered) the input is the
 * one sent before views existed, so its cache and query keys do not move.
 *
 * Under a view the setter stays pinned whatever the selection says, and "Other
 * angles" is dropped: the page has no switch for it. On an angle-bound board
 * (Woods) it asks for every angle: a setter's page is their whole catalogue, and
 * without the opt-in the search keeps only the climbs set at the viewer's
 * current angle (#5642). Gated on the capability because on Kilter the same
 * opt-in is the ~5.6 s cross-angle query (see `angleBoundClimbs` in
 * @boardsesh/board-config). No page fields: the list and the play drawer add
 * their own.
 */
export function setterPlaylistInput(
  setter: string,
  board: SetterPlaylistBoard,
  view?: SetterPlaylistView,
): ClimbSearchInput {
  const angleBound = getBoardCapabilities(board.boardName).angleBoundClimbs;
  if (!view || !isSetterViewActive(view.selection)) {
    return {
      boardName: board.boardName,
      layoutId: board.layoutId,
      sizeId: board.sizeId,
      setIds: board.setIds,
      angle: board.angle,
      setter: [setter],
      sortBy: 'creation',
      sortOrder: 'desc',
      boulders: true,
      routes: true,
      ...(angleBound ? { crossAngleStats: true } : {}),
    };
  }
  const { selection, personalGrades } = view;
  const viewFilters = filtersForBoard(
    {
      ...selection.filters,
      sortBy: selection.sort.sortBy,
      sortOrder: selection.sort.sortOrder,
      sortSeed: selection.sort.sortSeed,
      includeOtherAngles: undefined,
    },
    board.boardName,
  );
  const {
    page: _droppedPage,
    pageSize: _droppedPageSize,
    crossAngleStats: _droppedCrossAngleStats,
    ...viewInput
  } = mergeBoardFilters(
    toClimbSearchInput(
      viewFilters,
      board,
      { page: 0, pageSize: 0 },
      { name: normalizeSearchName(selection.name), personalGrades },
    ),
    selection.boardFilters,
  );
  return {
    ...viewInput,
    setter: [setter],
    ...(angleBound ? { crossAngleStats: true } : {}),
  };
}
