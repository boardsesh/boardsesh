import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';
import {
  smartPlaylistGeometryKey,
  useSmartPlaylist,
  type SmartPlaylistActiveBoardInput,
} from '@boardsesh/playlists-react';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import {
  GET_SMART_PLAYLIST,
  type SmartPlaylistType,
  type GetSmartPlaylistInput,
  type GetSmartPlaylistQueryResponse,
} from '@boardsesh/graphql/operations/playlists';
import { Text } from '../../../../src/components/Text';
import { Icon } from '../../../../src/components/Icon';
import { ClimbListRowSkeleton } from '../../../../src/components/ClimbListRowSkeleton';
import {
  PlaylistDetailView,
  SKELETON_PLACEHOLDERS,
  PlaylistStateHeader,
  PlaylistFilterBar,
  type PlaylistDetailEmptyState,
  type PlaylistFilterStatus,
} from '../../../../src/components/playlist';
import { ClimbFilterSheet, type ClimbFilterSheetPickers } from '../../../../src/components/ClimbFilterSheet';
import { useClimbFilterSession } from '../../../../src/hooks/use-climb-filter-session';
import { usePersonalGradesActive } from '../../../../src/hooks/use-personal-grades';
import { getHttpClient } from '../../../../src/lib/graphql/client';
import { useSearchGradeSourceActive } from '../../../../src/lib/graphql/hooks/search-grade-source';
import { boardConfigKey } from '../../../../src/lib/last-search-store';
import { playlistPinnedChipsStore } from '../../../../src/lib/playlist-pinned-chips-store';
import { PLAYLIST_PINNABLE_CHIP_KINDS } from '../../../../src/lib/playlist-pinnable-chips';
import {
  PLAYLIST_ACTIVE_BOARD_ONLY_CHIPS,
  playlistSheetSections,
} from '../../../../src/lib/playlists/playlist-board-scope';
import { readListSort, writeListSort } from '../../../../src/lib/playlists/playlist-sort-memory';
import {
  PLAYLIST_FILTER_DEFAULTS,
  listSourceId,
  playlistEmptyKind,
  playlistViewKey,
  type PlaylistEmptyKind,
} from '../../../../src/lib/playlists/playlist-view';
import { listAddToQueueCount } from '../../../../src/lib/playlists/list-add-to-queue-count';
import {
  smartListHiddenChips,
  smartListSheetSections,
  smartListSortModelFor,
  smartListViewInput,
  smartSortMemoryKey,
  type SmartListSelection,
} from '../../../../src/lib/playlists/smart-list-view';
import { usePlaylistActivation } from '../../../../src/lib/playlists/use-playlist-activation';
import { usePlaylistRenderBoard } from '../../../../src/lib/playlists/use-playlist-render-board';
import { toQueueClimbs } from '../../../../src/lib/climb-types';
import {
  isLogbookSmartType,
  parseSmartPlaylistOpenSource,
  smartPlaylistByType,
  type SmartPlaylistPresentation,
} from '../../../../src/lib/smart-playlists';
import { track } from '../../../../src/lib/analytics';
import { useProfile } from '../../../../src/lib/graphql/hooks';
import { useActiveBoard } from '../../../../src/lib/graphql/use-active-board';
import { useAuthToken } from '../../../../src/lib/graphql/use-auth-token';
import { useAuth } from '../../../../src/providers/auth-provider';
import { useIsSharedSession } from '../../../../src/providers/queue-provider';
import { useTheme } from '../../../../src/providers/theme-provider';

type SmartParams = {
  type: string;
  /** The surface that opened the list (`smartPlaylistHref`); absent on a deep link. */
  source?: string;
};

/**
 * The view whose rows are on screen: what the play drawer, Play next / Play last and the
 * empty state use (the playlist screen's rule). `selection` is what was asked
 * for (null for the list's own order) and `activeBoardInput` the board the view
 * read, so the drawer's pages ask exactly what the rows on screen asked.
 */
type SettledSmartView = {
  view: GetSmartPlaylistInput['view'];
  key: string | null;
  selection: SmartListSelection | null;
  activeBoardInput: SmartPlaylistActiveBoardInput | undefined;
};
const PLAIN_SMART_VIEW: SettledSmartView = { view: undefined, key: null, selection: null, activeBoardInput: undefined };

export default function SmartPlaylistDetail() {
  const { type, source } = useLocalSearchParams<SmartParams>();
  const preset = smartPlaylistByType(type);
  const smartType = (preset?.type ?? type) as SmartPlaylistType;

  // Once per mount, for a list that exists: `$screen` keeps `[type]` verbatim,
  // so this is the only place a Liked Climbs open can be told from any other
  // smart list (#6002). The ref holds through a param change on the same mount.
  const openTrackedRef = useRef(false);
  const knownType = preset?.type ?? null;
  useEffect(() => {
    if (!knownType || openTrackedRef.current) return;
    openTrackedRef.current = true;
    track(SHARED_EVENTS.SmartPlaylistOpened, { type: knownType, source: parseSmartPlaylistOpenSource(source) });
  }, [knownType, source]);

  // One body per list: its sort model, remembered sort and filter session belong
  // to that list, so a param change to another list starts them fresh.
  return <SmartPlaylistBody key={smartType} smartType={smartType} preset={preset} />;
}

function SmartPlaylistBody({
  smartType,
  preset,
}: {
  smartType: SmartPlaylistType;
  preset: SmartPlaylistPresentation | null;
}) {
  const { t } = useTranslation('playlists');
  const { systemColors } = useTheme();
  const { data: profile } = useProfile();
  const { isLoading: tokenLoading } = useAuthToken();
  const { isAuthenticated } = useAuth();
  const { data: activeBoard, isPending: activeBoardPending } = useActiveBoard();
  const cppCapture = process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1' && !!process.env.EXPO_PUBLIC_SCREENSHOT_CPP_URL;
  // "Is anyone else here" — one boolean off a dedicated selector context, so the
  // session-stats push doesn't re-render this screen's list.
  const isSharedSession = useIsSharedSession();

  const userId = profile?.id ?? '';
  // Sort and filters run on the logbook lists only (#6651). A recommendation is
  // already ranked for the climber and the server rejects a view on one, so it
  // gets no filter bar: every hook below still runs, with the session shut.
  const logbookType = isLogbookSmartType(smartType) ? smartType : null;

  const activeBoardConfig = useMemo(
    () =>
      activeBoard
        ? {
            boardName: activeBoard.boardType,
            layoutId: activeBoard.layoutId,
            sizeId: activeBoard.sizeId,
            setIds: activeBoard.setIds,
            angle: activeBoard.angle,
          }
        : null,
    [activeBoard],
  );
  // The board a view's active-board filters read. Sent only with a view.
  const activeBoardInput = useMemo<SmartPlaylistActiveBoardInput | undefined>(
    () =>
      activeBoard
        ? {
            activeBoardName: activeBoard.boardType,
            activeAngle: activeBoard.angle,
            activeLayoutId: activeBoard.layoutId,
            activeSizeId: activeBoard.sizeId,
            ...(activeBoard.setIds ? { activeSetIds: activeBoard.setIds } : {}),
          }
        : undefined,
    [activeBoard],
  );

  // The sort a climber picked on this list is remembered per list type (a
  // synchronous read, so the first request already carries it); filters start
  // empty on every visit.
  const sortModel = smartListSortModelFor(smartType);
  const sortMemoryKey = smartSortMemoryKey(smartType);
  const [initialSort] = useState(() => readListSort(sortMemoryKey, sortModel));
  const rememberSort = useCallback(
    (sort: SmartListSelection['sort']) => writeListSort(sortMemoryKey, sort, sortModel),
    [sortMemoryKey, sortModel],
  );
  // The sheet's live count and the rail's grade board both come from the query,
  // which runs after the session: each is mirrored here once known.
  const [sheetMatchCount, setSheetMatchCount] = useState<number | null>(null);
  const [listBoardType, setListBoardType] = useState('');
  const filterScopeKey =
    logbookType && userId
      ? `smart:${smartType}:${userId}|${activeBoardConfig ? boardConfigKey(activeBoardConfig) : 'none'}|${isAuthenticated}`
      : null;
  // The pickers push onto the Discover stack, and Setters lists this list's
  // setters. Hold types offers no heatmap: it counts the board, not this list.
  const filterPickers = useMemo<ClimbFilterSheetPickers>(
    () => ({ stack: 'discover', heatmap: false, setterList: { kind: 'smart', smartType, userId } }),
    [smartType, userId],
  );
  const { state: filterState, actions: filterActions } = useClimbFilterSession({
    scopeKey: filterScopeKey,
    boardConfig: activeBoardConfig,
    gradeBoardName: activeBoard?.boardType ?? listBoardType,
    defaultFilters: PLAYLIST_FILTER_DEFAULTS,
    sortModel,
    initialSort,
    onSortCommit: rememberSort,
    pinStore: playlistPinnedChipsStore,
    pinnable: PLAYLIST_PINNABLE_CHIP_KINDS,
    sections: logbookType ? smartListSheetSections(logbookType, !!activeBoard) : playlistSheetSections(!!activeBoard),
    activeBoardAvailable: !!activeBoard,
    activeBoardOnlyChips: PLAYLIST_ACTIVE_BOARD_ONLY_CHIPS,
    hiddenChips: smartListHiddenChips(smartType),
    pickers: filterPickers,
    liveCount: sheetMatchCount,
    disabled: !logbookType,
    namePlaceholder: t('detail.view.namePlaceholder'),
  });
  const personalGrades = usePersonalGradesActive();
  const boardseshGrades = useSearchGradeSourceActive();
  // Undefined for a recommendation, and for the list's own order with no filter:
  // the request then goes out exactly as it did before views existed.
  const viewInput = useMemo(
    () => smartListViewInput(smartType, filterState.querySelection, { personalGrades, boardseshGrades }),
    [smartType, filterState.querySelection, personalGrades, boardseshGrades],
  );
  // A view's rows depend on the active board it reads (progress and ratings at
  // its angle, "Fits my board"), so the board is part of the view's key: a
  // board switch under a view is a new track, settled once its rows are up.
  const viewKey = useMemo(() => {
    const filterKey = playlistViewKey(viewInput);
    return filterKey === null ? null : `${filterKey}|${smartPlaylistGeometryKey(activeBoardInput) ?? 'no-board'}`;
  }, [viewInput, activeBoardInput]);

  const { query, allClimbs, meta } = useSmartPlaylist({
    smartPlaylistType: smartType,
    userId,
    tokenLoading: tokenLoading || !userId || (cppCapture && (activeBoardPending || !activeBoard)),
    ...(cppCapture && activeBoard
      ? {
          boardName: activeBoard.boardType,
          boardUuid: activeBoard.uuid,
          sizeId: activeBoard.sizeId,
          angle: activeBoard.angle,
          pageSize: 10,
        }
      : {}),
    view: viewInput,
    activeBoardInput,
  });

  // While a new sort or filter loads, the previous view's rows stay up. The
  // settled view is the one those rows belong to, updated during render in the
  // same pass that shows the new rows (see the playlist screen), so the drawer's
  // track, the activation source and Play next / Play last always follow what is on
  // screen. The guard compares keys, so it cannot loop. Rows a failed refetch
  // kept count as on screen too: they are what the climber sees.
  const [settledView, setSettledView] = useState<SettledSmartView>(PLAIN_SMART_VIEW);
  const viewRowsOnScreen = query.data !== undefined && !query.isPlaceholderData;
  if (viewRowsOnScreen && settledView.key !== viewKey) {
    setSettledView(
      viewKey === null
        ? PLAIN_SMART_VIEW
        : { view: viewInput, key: viewKey, selection: filterState.querySelection, activeBoardInput },
    );
  }
  const firstPage = query.data?.pages[0];
  const totalCount = firstPage?.totalCount;
  // Only a filtering view carries it, so it also says "the rows on screen are filtered".
  const unfilteredCount = firstPage?.unfilteredCount ?? null;
  useEffect(() => {
    if (totalCount !== undefined) setSheetMatchCount(totalCount);
  }, [totalCount]);
  // With no active board, the grade rail and tokens read the list's own board.
  const firstClimbBoardType = allClimbs[0]?.boardType ?? '';
  if (!listBoardType && firstClimbBoardType) setListBoardType(firstClimbBoardType);

  // Suggestion-refresh fetcher pages the smart playlist scoped to the active
  // board name so the play-drawer swipe walks the full computed list, under the
  // view on screen.
  const fetchPage = useCallback(
    async ({
      page,
      pageSize,
      board,
      signal,
    }: {
      page: number;
      pageSize: number;
      board: { boardName: string };
      signal: AbortSignal;
    }) => {
      // Under a view, the board the rows on screen were asked for: after a
      // board switch the old rows stay up until the new board's land, and the
      // player must walk the rows the climber is looking at, not the next
      // board's order. With no view the list has no board of its own, so the
      // activated board scopes it.
      const settledBoardInput = settledView.view ? settledView.activeBoardInput : undefined;
      const input: GetSmartPlaylistInput = {
        type: smartType,
        userId,
        boardName: settledBoardInput?.activeBoardName ?? board.boardName,
        page,
        pageSize,
        // The view on screen, so the drawer swipes and Play next / Play last walk the
        // same sorted, filtered rows the climber sees.
        ...(settledView.view ? { ...settledBoardInput, view: settledView.view } : {}),
      };
      // `signal` is what makes backing out of a playlist actually cancel the
      // load. Without it the drain only skipped the NEXT page; the in-flight
      // request ran to completion and could still replace the queue late.
      const response = await getHttpClient().request<GetSmartPlaylistQueryResponse, { input: GetSmartPlaylistInput }>({
        document: GET_SMART_PLAYLIST,
        variables: { input },
        signal,
      });
      return {
        climbs: toQueueClimbs(response.smartPlaylist.climbs),
        hasMore: response.smartPlaylist.hasMore,
        // Counted by the same board-scoped query, so the player's "4 of 23"
        // counts the climbs it walks.
        totalCount: response.smartPlaylist.totalCount,
      };
    },
    [smartType, userId, settledView.view, settledView.activeBoardInput],
  );

  const playlistActivation = usePlaylistActivation({
    sourceId: listSourceId(`smart:${smartType}:${userId}`, settledView.key),
    allClimbs,
    fetchPage,
    // "From Projects · 4 of 23": the same name the list's own header shows.
    label: preset ? t(preset.titleI18nKey) : meta?.userName,
    // Same rule as the playlist screen above: with a crew present a row tap is a
    // look, not a queue replacement plus a wall grab.
    previewOnly: isSharedSession,
    refreshErrorMessage: 'Failed to refresh smart playlist suggestions:',
    // A tap plays from the list; with "Tapping a playlist loads it into my
    // queue" on, it replaces the queue with it instead (F4, #6667).
    honorPlaylistLoadSetting: true,
  });

  // Smart playlists are computed relative to the active board, so they always
  // render against it (no mismatch banner).
  const { renderBoard } = usePlaylistRenderBoard(null);

  const hero = useMemo(
    () => ({
      name: preset ? t(preset.titleI18nKey) : (meta?.userName ?? ''),
      // Under a filtering view, page 0's meta counts the list before the filters.
      climbCount: meta?.climbCount ?? allClimbs.length,
      color: preset?.color,
      icon: preset?.icon,
      subtitle: meta?.userName,
    }),
    [preset, meta, allClimbs.length, t],
  );

  // The empty state follows the response on screen. A failed load (a view can
  // be rate limited, and a big Liked list costs more to sort) says so and offers
  // a retry. A list filtered to nothing is worded for the filter, and wins over
  // the Liked heart prompt, which is for a list with no likes at all.
  const { clearFilters, openFilters } = filterActions;
  const climbsFailed = query.isError && allClimbs.length === 0;
  const settledSelection = settledView.selection;
  const emptyKind: PlaylistEmptyKind | null =
    !climbsFailed && unfilteredCount != null && settledSelection ? playlistEmptyKind(settledSelection) : null;
  const { refetch: retryClimbs } = query;
  const queriedName = settledSelection?.name ?? '';
  const emptyMessage = useMemo(() => {
    if (climbsFailed) return t('detail.errors.loadTitle');
    switch (emptyKind) {
      case 'noName':
        return t('detail.view.empty.noName', { name: queriedName });
      case 'noBoardFit':
        return t('detail.view.empty.noBoardFit');
      case 'allSent':
        return t('detail.view.empty.allSent');
      case 'noMatch':
        return t('detail.view.empty.noMatch');
      case null:
        return t('library.smart.empty');
    }
  }, [climbsFailed, emptyKind, queriedName, t]);
  const emptyState = useMemo<PlaylistDetailEmptyState | undefined>(() => {
    if (climbsFailed) return { icon: 'error', title: emptyMessage, supporting: t('detail.errors.loadDescription') };
    if (emptyKind) return { icon: 'filter', title: emptyMessage };
    // The liked-climbs surface gets a climber-voice empty state (heart prompt) on
    // the Material branch; other smart playlists fall back to the generic message.
    return preset?.type === 'LIKED_CLIMBS'
      ? {
          icon: 'favorite',
          title: t('library.smart.likedClimbs.empty.title'),
          supporting: t('library.smart.likedClimbs.empty.supporting'),
        }
      : undefined;
  }, [climbsFailed, emptyKind, emptyMessage, preset, t]);
  const emptyIcon = climbsFailed ? 'error' : emptyKind ? 'filter' : undefined;
  const emptyAction = useMemo(() => {
    if (climbsFailed) return { label: t('detail.errors.tryAgain'), onPress: () => void retryClimbs() };
    if (emptyKind) return { label: t('detail.view.clearFilters'), onPress: clearFilters };
    return undefined;
  }, [climbsFailed, retryClimbs, emptyKind, clearFilters, t]);

  // The filter chrome under the hero, on the logbook lists that hold anything.
  const showFilterControls = !!logbookType && meta?.climbCount !== 0;
  // "12 of 117 climbs · Clear filters", from the rows on screen. Hidden at zero,
  // where the empty state carries its own Clear filters.
  const filterStatus = useMemo<PlaylistFilterStatus | null>(
    () =>
      unfilteredCount != null && totalCount !== undefined && totalCount > 0
        ? { shown: totalCount, total: unfilteredCount, onClear: clearFilters }
        : null,
    [unfilteredCount, totalCount, clearFilters],
  );
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
  // "Play 12 next" and "Play 12 last" while the rows on screen are filtered (`listAddToQueueCount`).
  const settledFitsBoard = !!settledView.view?.onlyActiveBoard;
  const { hasNextPage } = query;
  const addToQueueCount = useMemo(
    () =>
      listAddToQueueCount({
        unfilteredCount,
        totalCount,
        fitsBoard: settledFitsBoard,
        hasNextPage: !!hasNextPage,
        renderBoard,
        climbs: allClimbs,
      }),
    [unfilteredCount, totalCount, settledFitsBoard, hasNextPage, renderBoard, allClimbs],
  );

  if (!preset && !query.isLoading) {
    return (
      <View style={styles.stateContainer}>
        <PlaylistStateHeader />
        <Icon name="error" size={48} color={systemColors.tertiaryLabel} />
        <Text variant="headline" style={styles.stateTitle}>
          {t('library.smart.notFound.title')}
        </Text>
        <Text variant="subheadline" style={styles.stateSubtitle}>
          {t('library.smart.notFound.description')}
        </Text>
      </View>
    );
  }

  if (query.isLoading && allClimbs.length === 0) {
    return (
      <View style={styles.skeletonContainer}>
        <PlaylistStateHeader />
        <View style={styles.skeletonList}>
          {SKELETON_PLACEHOLDERS.map((key) => (
            <ClimbListRowSkeleton key={key} />
          ))}
        </View>
      </View>
    );
  }

  return (
    <>
      <PlaylistDetailView
        hero={hero}
        climbs={allClimbs}
        renderBoard={renderBoard}
        isLoading={query.isLoading}
        isFetchingNextPage={query.isFetchingNextPage}
        hasNextPage={query.hasNextPage ?? false}
        fetchNextPage={query.fetchNextPage}
        onActivateClimb={playlistActivation.activate}
        emptyMessage={emptyMessage}
        emptyIcon={emptyIcon}
        emptyState={emptyState}
        emptyAction={emptyAction}
        onQueueAll={playlistActivation.addToQueue.queue}
        pendingQueueAll={playlistActivation.addToQueue.pendingPlacement}
        addToQueueCount={addToQueueCount}
        onRefresh={query.refetch}
        filterBar={filterBar}
        filterAction={filterAction}
        scrollResetKey={settledView.key}
      />

      {filterState.sheetProps ? <ClimbFilterSheet key={filterScopeKey} {...filterState.sheetProps} /> : null}
    </>
  );
}

const styles = StyleSheet.create({
  stateContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    gap: 8,
  },
  skeletonContainer: {
    flex: 1,
  },
  skeletonList: {
    paddingTop: 64,
  },
  stateTitle: {
    marginTop: 12,
    opacity: 0.6,
  },
  stateSubtitle: {
    opacity: 0.4,
    textAlign: 'center',
  },
});
