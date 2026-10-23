import { useCallback, useEffect, useMemo, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import {
  PlaylistDetailView,
  PlaylistFilterBar,
  PlaylistStateHeader,
  type PlaylistDetailEmptyState,
  type PlaylistFilterStatus,
} from '../../../../src/components/playlist';
import {
  ClimbFilterSheet,
  type ClimbFilterSheetPickers,
  type ClimbFilterSheetSections,
} from '../../../../src/components/ClimbFilterSheet';
import { SetterFollowButton } from '../../../../src/components/SetterFollowButton';
import { Button } from '../../../../src/components/Button';
import { Text } from '../../../../src/components/Text';
import { useClimbFilterSession } from '../../../../src/hooks/use-climb-filter-session';
import { usePersonalGradesActive } from '../../../../src/hooks/use-personal-grades';
import {
  usePlaylistActivation,
  type UsePlaylistActivationOptions,
} from '../../../../src/lib/playlists/use-playlist-activation';
import { usePlaylistRenderBoard } from '../../../../src/lib/playlists/use-playlist-render-board';
import {
  SETTER_FILTER_DEFAULTS,
  isSetterViewActive,
  setterPlaylistInput,
  type SetterPlaylistView,
} from '../../../../src/lib/playlists/setter-playlist-input';
import {
  DEFAULT_SETTER_SORT,
  SETTER_SORT_MEMORY_KEY,
  setterSortModel,
  type SetterSelection,
  type SetterSessionSort,
} from '../../../../src/lib/playlists/setter-sort-model';
import { readListSort, writeListSort } from '../../../../src/lib/playlists/playlist-sort-memory';
import { PLAYLIST_ACTIVE_BOARD_ONLY_CHIPS } from '../../../../src/lib/playlists/playlist-board-scope';
import {
  hasActiveSessionFilters,
  listSourceId,
  playlistEmptyKind,
  type PlaylistEmptyKind,
} from '../../../../src/lib/playlists/playlist-view';
import { listAddToQueueCount } from '../../../../src/lib/playlists/list-add-to-queue-count';
import { playlistPinnedChipsStore } from '../../../../src/lib/playlist-pinned-chips-store';
import { PLAYLIST_PINNABLE_CHIP_KINDS } from '../../../../src/lib/playlist-pinnable-chips';
import { boardConfigKey } from '../../../../src/lib/last-search-store';
import { useInfiniteSearchClimbs } from '../../../../src/lib/graphql/hooks/use-infinite-search-climbs';
import { useSearchClimbsCount } from '../../../../src/lib/graphql/hooks';
import { useSearchGradeSourceActive, withGradeSource } from '../../../../src/lib/graphql/hooks/search-grade-source';
import { SEARCH_CLIMBS, type SearchClimbsQueryResponse } from '../../../../src/lib/graphql/operations';
import { offlineAwareRequest } from '../../../../src/lib/graphql/offline-request';
import { toQueueClimbs } from '../../../../src/lib/climb-types';
import { useAuth } from '../../../../src/providers/auth-provider';
import { useIsSharedSession } from '../../../../src/providers/queue-provider';
import { createAbortError } from '../../../../src/lib/graphql/request-timeout';
import { spacing } from '../../../../src/theme/tokens';
import { setterPlaylistReturnTo } from '../../../../src/lib/boards/board-return-to';

// Hooks still need an input while no board is selected; both queries stay disabled.
const PLACEHOLDER_BOARD = { boardName: '', layoutId: 0, sizeId: 0, setIds: '', angle: 0 };

/**
 * The sheet rows a setter page hides (#6651). Recent and My drafts belong to the
 * Climbs search; Setters and Following would only repeat the one setter the page
 * is about; Other angles is decided for the page (every angle on Woods). Hold
 * types and Board region stay: the page is one board's climbs.
 */
const SETTER_SHEET_SECTIONS: ClimbFilterSheetSections = {
  recent: false,
  drafts: false,
  setters: false,
  following: false,
  otherAngles: false,
};

/**
 * The page lives in the Climbs stack, so its pickers push there. Hold types
 * offers no heatmap: it would count the whole board, not this setter's climbs.
 */
const SETTER_PICKERS: ClimbFilterSheetPickers = { stack: 'climbs', heatmap: false };

/**
 * The view whose rows are on screen (the playlist screen's rule): what the play
 * drawer's pages, Add to queue, the status line and the empty state follow.
 */
type SettledSetterView = {
  view: SetterPlaylistView | null;
  key: string | null;
};
const PLAIN_SETTER_VIEW: SettledSetterView = { view: null, key: null };

export default function SetterPlaylist() {
  // `boardType`/`layoutId` are optional and name the board the CALLER was
  // looking at. Without them this resolves against the viewer's active board,
  // so arriving from a card for a setter on someone else's wall would filter
  // their climbs to a board they never set on — an empty list, with the climbs
  // the caller was trying to reach nowhere in it.
  const { username, boardType, layoutId } = useLocalSearchParams<{
    username: string;
    boardType?: string;
    layoutId?: string;
  }>();
  const { t } = useTranslation('climbs');
  const { t: tPlaylists } = useTranslation('playlists');
  const router = useRouter();
  const { isAuthenticated } = useAuth();
  const sourceBoard = useMemo(
    () => (boardType ? { boardType, layoutId: layoutId ? Number(layoutId) : null } : null),
    [boardType, layoutId],
  );
  const { renderBoard } = usePlaylistRenderBoard(sourceBoard);
  const board = renderBoard ?? PLACEHOLDER_BOARD;
  const enabled = !!renderBoard && !!username;

  // Sort and filters (#6651). One remembered sort for every setter page (a
  // synchronous read, so the first request already carries it); filters start
  // empty on every visit.
  const [initialSort] = useState(() => readListSort(SETTER_SORT_MEMORY_KEY, setterSortModel));
  const rememberSort = useCallback(
    (sort: SetterSessionSort) => writeListSort(SETTER_SORT_MEMORY_KEY, sort, setterSortModel),
    [],
  );
  // The sheet's live count: the view's count query runs after the session, so
  // it is mirrored here (in an effect, below).
  const [sheetMatchCount, setSheetMatchCount] = useState<number | null>(null);
  const filterScopeKey = enabled ? `setter:${username}|${boardConfigKey(board)}|${isAuthenticated}` : null;
  const { state: filterState, actions: filterActions } = useClimbFilterSession({
    scopeKey: filterScopeKey,
    boardConfig: renderBoard,
    gradeBoardName: board.boardName,
    defaultFilters: SETTER_FILTER_DEFAULTS,
    sortModel: setterSortModel,
    initialSort,
    onSortCommit: rememberSort,
    pinStore: playlistPinnedChipsStore,
    pinnable: PLAYLIST_PINNABLE_CHIP_KINDS,
    sections: SETTER_SHEET_SECTIONS,
    activeBoardAvailable: !!renderBoard,
    activeBoardOnlyChips: PLAYLIST_ACTIVE_BOARD_ONLY_CHIPS,
    // Every climb here is on this board already.
    boardFitAvailable: false,
    pickers: SETTER_PICKERS,
    liveCount: sheetMatchCount,
    disabled: false,
  });
  const personalGrades = usePersonalGradesActive();
  const boardseshGrades = useSearchGradeSourceActive();
  const querySelection: SetterSelection = filterState.querySelection;
  const viewActive = isSetterViewActive(querySelection);
  // With no view the two inputs are equal, so their queries share one cache
  // entry, the one this page always used.
  const plainInput = useMemo(() => setterPlaylistInput(username, board), [username, board]);
  const viewInput = useMemo(
    () =>
      viewActive ? setterPlaylistInput(username, board, { selection: querySelection, personalGrades }) : plainInput,
    [viewActive, username, board, querySelection, personalGrades, plainInput],
  );
  const viewKey = viewActive ? JSON.stringify(viewInput) : null;
  // What the view counts: its filters at the page's own order. A sort hides
  // nothing, so a new sort or a reshuffle asks for no new count, and a sort
  // alone counts the plain input (one shared cache entry).
  const countInput = useMemo(
    () =>
      setterPlaylistInput(username, board, {
        selection: { ...querySelection, sort: DEFAULT_SETTER_SORT },
        personalGrades,
      }),
    [username, board, querySelection, personalGrades],
  );

  const query = useInfiniteSearchClimbs(viewInput, enabled, { keepPreviousResults: true });
  // The hero counts the setter's climbs; the view's count drives the sheet, the
  // status line and Add to queue.
  const plainCount = useSearchClimbsCount(plainInput, enabled);
  const viewCount = useSearchClimbsCount(countInput, enabled);
  const allClimbs = useMemo(() => toQueueClimbs(query.data?.pages.flatMap((page) => page.climbs) ?? []), [query.data]);

  // While a new sort or filter loads, the previous view's rows stay up. The
  // settled view is the one those rows belong to, updated during render in the
  // same pass that shows the new rows (see the playlist screen), so the drawer's
  // track, the activation source and Add to queue follow what is on screen.
  // Rows a failed refetch kept count as on screen too: they are what the climber sees.
  const [settledView, setSettledView] = useState<SettledSetterView>(PLAIN_SETTER_VIEW);
  const viewRowsOnScreen = query.data !== undefined && !query.isPlaceholderData;
  if (viewRowsOnScreen && settledView.key !== viewKey) {
    setSettledView(
      viewKey === null ? PLAIN_SETTER_VIEW : { view: { selection: querySelection, personalGrades }, key: viewKey },
    );
  }
  // The count holds its previous number while a new one loads; that number
  // belongs to another view, so it counts only once it is this view's own.
  const viewMatchCount = viewCount.isPlaceholderData ? undefined : viewCount.data;
  useEffect(() => {
    if (viewMatchCount !== undefined) setSheetMatchCount(viewMatchCount);
  }, [viewMatchCount]);

  const fetchPage = useCallback<UsePlaylistActivationOptions['fetchPage']>(
    async ({ page, pageSize, board: activatedBoard, signal }) => {
      if (signal.aborted) throw createAbortError('Setter playlist navigation was cancelled');
      // The view on screen, with the grade source the list sends, so the
      // drawer swipes and Add to queue walk the same rows in the same order.
      const input = withGradeSource(
        { ...setterPlaylistInput(username, activatedBoard, settledView.view ?? undefined), page, pageSize },
        boardseshGrades,
      );
      const response = await offlineAwareRequest<SearchClimbsQueryResponse>(SEARCH_CLIMBS, { input });
      if (signal.aborted) throw createAbortError('Setter playlist navigation was cancelled');
      return { climbs: toQueueClimbs(response.searchClimbs.climbs), hasMore: response.searchClimbs.hasMore };
    },
    [username, settledView.view, boardseshGrades],
  );
  const isSharedSession = useIsSharedSession();
  const activation = usePlaylistActivation({
    sourceId: listSourceId(`setter:${username}:${JSON.stringify(renderBoard)}`, settledView.key),
    allClimbs,
    fetchPage,
    previewOnly: isSharedSession,
    replaceQueueOnActivate: true,
    refreshErrorMessage: 'Failed to refresh setter playlist',
  });

  const hero = useMemo(
    () => ({
      name: username,
      climbCount: plainCount.data ?? allClimbs.length,
      subtitle: t('authors.playlistSubtitleSort', { sort: filterState.sortDescription }),
    }),
    [username, plainCount.data, allClimbs.length, t, filterState.sortDescription],
  );
  const actions = useCallback(() => <SetterFollowButton username={username} />, [username]);
  const { refetch: refetchClimbs } = query;
  const { refetch: refetchPlainCount } = plainCount;
  const { refetch: refetchViewCount } = viewCount;
  const handleRefresh = useCallback(
    () => Promise.all([refetchClimbs(), refetchPlainCount(), refetchViewCount()]),
    [refetchClimbs, refetchPlainCount, refetchViewCount],
  );

  // What the rows on screen are: filtered (a sort alone hides nothing), and how
  // many there are. Only the settled view's own count is used.
  const settledSelection = settledView.view?.selection ?? null;
  const settledFiltered = !!settledSelection && hasActiveSessionFilters(settledSelection, SETTER_FILTER_DEFAULTS);
  // The settled view's own count, kept while the next view loads (its old rows
  // stay up too), so the status line and Add N don't blink on every tap. The
  // guard compares values, so this render-time update cannot loop.
  const [settledCount, setSettledCount] = useState<{ key: string | null; count: number } | null>(null);
  if (
    viewMatchCount !== undefined &&
    viewKey === settledView.key &&
    (settledCount?.key !== viewKey || settledCount.count !== viewMatchCount)
  ) {
    setSettledCount({ key: viewKey, count: viewMatchCount });
  }
  const settledMatchCount = settledCount?.key === settledView.key ? settledCount.count : undefined;
  // The plain count also holds its last number while it reloads (another board's, after a switch).
  const plainTotal = plainCount.isPlaceholderData ? undefined : plainCount.data;
  const unfilteredCount = settledFiltered ? (plainTotal ?? null) : null;
  const { clearFilters, openFilters } = filterActions;
  // "12 of 117 climbs · Clear filters". Hidden at zero, where the empty state
  // carries its own Clear filters.
  const filterStatus = useMemo<PlaylistFilterStatus | null>(
    () =>
      unfilteredCount != null && settledMatchCount !== undefined && settledMatchCount > 0
        ? { shown: settledMatchCount, total: unfilteredCount, onClear: clearFilters }
        : null,
    [unfilteredCount, settledMatchCount, clearFilters],
  );
  // A setter with no climbs on this board has nothing to filter.
  const showFilterControls = plainCount.data !== 0;
  const filterBar = useMemo(
    () =>
      showFilterControls ? (
        <PlaylistFilterBar
          chipRowProps={filterState.chipRowProps}
          tokens={filterState.tokens}
          gradeRail={filterState.gradeRail}
          status={filterStatus}
          editing={false}
        />
      ) : null,
    [showFilterControls, filterState.chipRowProps, filterState.tokens, filterState.gradeRail, filterStatus],
  );
  const activeFilterCount = filterState.activeFilterCount;
  const filterAction = useMemo(
    () => (showFilterControls ? { activeCount: activeFilterCount, onPress: openFilters } : null),
    [showFilterControls, activeFilterCount, openFilters],
  );
  // Every row is on this board (the search is), so the count is what the add takes.
  const { hasNextPage } = query;
  const addToQueueCount = useMemo(
    () =>
      listAddToQueueCount({
        unfilteredCount,
        totalCount: settledMatchCount,
        fitsBoard: true,
        hasNextPage: !!hasNextPage,
        renderBoard,
        climbs: allClimbs,
      }),
    [unfilteredCount, settledMatchCount, hasNextPage, renderBoard, allClimbs],
  );

  // A list filtered to nothing is worded for the filter and offers Clear filters.
  const emptyKind: PlaylistEmptyKind | null =
    !query.isError && settledFiltered && settledSelection ? playlistEmptyKind(settledSelection) : null;
  const queriedName = settledSelection?.name ?? '';
  const emptyMessage = useMemo(() => {
    if (query.isError) return t('authors.loadError');
    switch (emptyKind) {
      case 'noName':
        return tPlaylists('detail.view.empty.noName', { name: queriedName });
      case 'noBoardFit':
        return tPlaylists('detail.view.empty.noBoardFit');
      case 'allSent':
        return tPlaylists('detail.view.empty.allSent');
      case 'noMatch':
        return tPlaylists('detail.view.empty.noMatch');
      case null:
        return t('authors.empty');
    }
  }, [query.isError, emptyKind, queriedName, t, tPlaylists]);
  const emptyState = useMemo<PlaylistDetailEmptyState | undefined>(
    () => (emptyKind ? { icon: 'filter', title: emptyMessage } : undefined),
    [emptyKind, emptyMessage],
  );
  const emptyAction = useMemo(
    () => (emptyKind ? { label: tPlaylists('detail.view.clearFilters'), onPress: clearFilters } : undefined),
    [emptyKind, clearFilters, tPlaylists],
  );

  return (
    <>
      {renderBoard ? (
        <PlaylistDetailView
          hero={hero}
          actions={actions}
          climbs={allClimbs}
          renderBoard={renderBoard}
          isLoading={query.isLoading}
          isFetchingNextPage={query.isFetchingNextPage}
          hasNextPage={query.hasNextPage ?? false}
          fetchNextPage={query.fetchNextPage}
          onActivateClimb={activation.activate}
          onAddAllToQueue={activation.addToQueue.append}
          isAddingAllToQueue={activation.addToQueue.isAppending}
          addToQueueCount={addToQueueCount}
          onRefresh={handleRefresh}
          emptyMessage={emptyMessage}
          emptyIcon={emptyKind ? 'filter' : undefined}
          emptyState={emptyState}
          emptyAction={emptyAction}
          filterBar={filterBar}
          filterAction={filterAction}
          scrollResetKey={settledView.key}
          headerSlot={
            query.isError ? <Button title={t('authors.retry')} onPress={() => void query.refetch()} /> : undefined
          }
        />
      ) : (
        <View style={styles.chooseBoard}>
          <PlaylistStateHeader />
          <Text>{t('authors.chooseBoard')}</Text>
          <Button
            title={t('authors.chooseBoard')}
            onPress={() =>
              router.push({
                pathname: '/boards',
                params: { returnTo: setterPlaylistReturnTo(username) },
              })
            }
          />
        </View>
      )}

      {filterState.sheetProps ? <ClimbFilterSheet key={filterScopeKey} {...filterState.sheetProps} /> : null}
    </>
  );
}

const styles = StyleSheet.create({
  chooseBoard: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing[4], gap: spacing[3] },
});
