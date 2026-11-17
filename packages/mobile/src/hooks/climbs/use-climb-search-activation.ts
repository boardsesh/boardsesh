import { useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { randomUUID } from 'expo-crypto';
import type { BoardName, Climb } from '@boardsesh/shared-schema';
import {
  mergeBoardFilters,
  toClimbSearchInput,
  type BoardSearchConfig,
  type ClimbBoardFilterState,
} from '@boardsesh/climb-filters';
import type { ClimbFilters } from '../../lib/climb-filter-types';
import type { WindowAnchorPoint } from '../../components/navigation/AnchoredPopover.types';
import { useFrozenSearchBasis } from '../../lib/playlists/use-frozen-search-basis';
import { usePlaylistActivation } from '../../lib/playlists/use-playlist-activation';
import { withGradeSource } from '../../lib/graphql/hooks/search-grade-source';
import { filtersForBoard } from '../../lib/climb-filter-types';
import { offlineAwareRequest } from '../../lib/graphql/offline-request';
import { SEARCH_CLIMBS, type SearchClimbsQueryResponse } from '../../lib/graphql/operations';
import { toQueueClimb, toQueueClimbs } from '../../lib/climb-types';
import { useFetchCachedSearchClimbsCount } from '../../lib/graphql/hooks/search-climbs-count-query';
import { useStoredUserId } from '../use-current-user-id';
import { requestPlayBoardPrewarm } from '../../lib/board-render/play-board-prewarm';
import { useIsSharedSession, useQueueActions } from '../../providers/queue-provider';
import { useDrawerHost } from '../../providers/drawer-host-provider';

type ClimbSearchActivationOptions = BoardSearchConfig & {
  filters: ClimbFilters;
  boardFilters: ClimbBoardFilterState;
  name: string;
  boardseshGradesActive: boolean;
  visibleClimbs: Climb[];
  isPlaceholderData: boolean;
};

/** Stable row actions capture the search on selection and reject stale rows. */
export function useClimbSearchActivation({
  filters,
  boardFilters,
  name,
  boardName,
  layoutId,
  sizeId,
  setIds,
  angle,
  boardseshGradesActive,
  visibleClimbs,
  isPlaceholderData,
}: ClimbSearchActivationOptions) {
  const { t: tSession } = useTranslation('session');
  const isSharedSession = useIsSharedSession();
  const { playNext } = useQueueActions();
  const { getClimbActions, openAddToPlaylist } = useDrawerHost();
  const isPlaceholderDataRef = useRef(isPlaceholderData);
  isPlaceholderDataRef.current = isPlaceholderData;
  // The search the swipe track pages against, frozen at selection (issue #5402).
  // See `useFrozenSearchBasis` for why it must not follow the live filters.
  const searchBasis = useFrozenSearchBasis({ filters, boardFilters, name });

  // Page the same search query the list uses so the play-drawer swipe can walk
  // climbs beyond what's loaded. Activation pages and search pages are both 0-based.
  //
  // Reads the frozen basis rather than taking the filters as dependencies, so one
  // drain cannot straddle two orderings and the callback identity stays stable
  // across list refetches.
  const searchInputForPage = useCallback(
    (basis: ReturnType<typeof searchBasis.read>, page: number, pageSize: number) => {
      const { filters: basisFilters, boardFilters: basisBoardFilters, name: basisName } = basis;
      return withGradeSource(
        mergeBoardFilters(
          toClimbSearchInput(
            filtersForBoard(basisFilters, boardName),
            { boardName, layoutId, sizeId, setIds, angle },
            { page, pageSize },
            { name: basisName },
          ),
          basisBoardFilters,
        ),
        boardseshGradesActive,
      );
    },
    [boardName, layoutId, sizeId, setIds, angle, boardseshGradesActive],
  );
  const fetchSearchPageFor = useCallback(
    async (basis: ReturnType<typeof searchBasis.read>, page: number, pageSize: number) => {
      // Same offline-aware source the list uses, so the play-drawer swipe keeps
      // paging climbs with no signal on a downloaded board.
      const response = await offlineAwareRequest<SearchClimbsQueryResponse>(SEARCH_CLIMBS, {
        input: searchInputForPage(basis, page, pageSize),
      });
      return {
        climbs: toQueueClimbs(response.searchClimbs.climbs),
        hasMore: response.searchClimbs.hasMore,
      };
    },
    [searchInputForPage],
  );
  const fetchSearchPage = useCallback(
    ({ page, pageSize }: { page: number; pageSize: number }) => fetchSearchPageFor(searchBasis.read(), page, pageSize),
    [fetchSearchPageFor, searchBasis],
  );
  // Every row tap re-captures the basis, crew and preview taps included, which
  // leave the committed track alone. A track's later pages keep the search it
  // was built from.
  const snapshotSearchPageFetcher = useCallback(() => {
    const basis = searchBasis.read();
    return ({ page, pageSize }: { page: number; pageSize: number }) => fetchSearchPageFor(basis, page, pageSize);
  }, [fetchSearchPageFor, searchBasis]);
  // The search pages carry no count (counting every page would cost the server
  // a count per page), so the player's "4 of 230" asks for one per tap, for the
  // same frozen search the pages walk, through the count cache.
  const fetchCachedCount = useFetchCachedSearchClimbsCount();
  const { userId: storedUserId } = useStoredUserId(true);
  const fetchSearchTotal = useCallback(() => {
    const { page: _page, pageSize: _pageSize, ...countInput } = searchInputForPage(searchBasis.read(), 0, 1);
    return fetchCachedCount(countInput, storedUserId);
  }, [fetchCachedCount, searchBasis, searchInputForPage, storedUserId]);

  const allQueueClimbs = useMemo(() => toQueueClimbs(visibleClimbs), [visibleClimbs]);

  const activateClimbListClimb = usePlaylistActivation({
    sourceId: 'climblist',
    allClimbs: allQueueClimbs,
    fetchPage: fetchSearchPage,
    snapshotFetchPage: snapshotSearchPageFetcher,
    fetchTotal: fetchSearchTotal,
    label: tSession('playView.track.searchResults'),
    // The rows are this same search's pages, from the top, on the active board.
    loadedRowsArePages: true,
    // In a crew, a row tap browses instead of taking everyone's wall: the drawer
    // opens on the tapped climb with these results seeded as its swipe track, so
    // the climber can walk the list and put up only the one they choose.
    previewOnly: isSharedSession,
    refreshErrorMessage: 'Failed to refresh climb-list suggestions:',
  });

  const handleClimbPress = useCallback(
    (climb: Climb, readyBoardArt?: import('../../lib/board-render/ready-board-art').ReadyBoardArtSnapshot) => {
      if (isPlaceholderDataRef.current) return;
      // First, before the navigation work below: the play drawer needs ~110ms to
      // mount and measure, and this render fits inside that.
      requestPlayBoardPrewarm({ boardName: boardName as BoardName, layoutId, sizeId, setIds }, climb.frames);
      // This tap IS the selection, so it is the one moment the swipe track may be
      // re-derived. Every tap re-captures it, previews included: outside a
      // drive, the activation hook opens a preview seeded with these results,
      // so swipes walk them (#5157).
      searchBasis.capture();
      void activateClimbListClimb.activate(toQueueClimb(climb), readyBoardArt);
    },
    [activateClimbListClimb, searchBasis, boardName, layoutId, sizeId, setIds],
  );

  // Row actions ignore stale placeholder rows, same as handleClimbPress. The
  // right swipe is Play next: the top of Up next, so a climber with a long queue
  // still reaches what they swiped (#6772).
  const handlePlayNext = useCallback(
    (climb: Climb) => {
      if (isPlaceholderDataRef.current) return;
      void playNext({ item: { uuid: randomUUID(), climb } });
    },
    [playNext],
  );

  // The row builds its menu while it renders, so the stale-row guard runs when
  // a command is picked, not here: a dep on the placeholder flag would rebuild
  // every visible row's menu twice per search.
  const handleOpenClimbActions = useCallback(
    (climb: Climb) => {
      const target = getClimbActions(climb);
      if (!target) return target;
      return { ...target, resolveClimb: async () => (isPlaceholderDataRef.current ? null : climb) };
    },
    [getClimbActions],
  );

  const handleOpenAddToPlaylist = useCallback(
    (climb: Climb, anchorPoint?: WindowAnchorPoint) => {
      if (isPlaceholderDataRef.current) return;
      openAddToPlaylist(climb, undefined, anchorPoint);
    },
    [openAddToPlaylist],
  );

  return { handleClimbPress, handlePlayNext, handleOpenClimbActions, handleOpenAddToPlaylist };
}
