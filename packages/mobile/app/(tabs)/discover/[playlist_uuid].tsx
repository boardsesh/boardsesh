import { PressableSurface } from '../../../src/components/PressableSurface';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { usePrivacyScopedState } from '../../../src/hooks/use-privacy-scoped-state';
import { getPrivacyRevocationGeneration, subscribeToPrivacyRevocations } from '../../../src/lib/privacy/privacy-cache';
import { View, StyleSheet, Alert } from 'react-native';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import type { BottomSheet } from '@expo/ui/community/bottom-sheet';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  playlistClimbsQueryKeyFor,
  usePlaylistClimbs,
  usePlaylistMutations,
  usePlaylistItemMutations,
  type PlaylistClimbsBoardInput,
} from '@boardsesh/playlists-react';
import type { Climb } from '@boardsesh/queue';
import {
  GET_PLAYLIST,
  GET_PLAYLIST_CLIMBS,
  type GetPlaylistQueryResponse,
  type GetPlaylistQueryVariables,
  type GetPlaylistClimbsInput,
  type GetPlaylistClimbsQueryResponse,
  type Playlist,
} from '@boardsesh/graphql/operations/playlists';
import { Text } from '../../../src/components/Text';
import { Icon } from '../../../src/components/Icon';
import { ClimbListRowSkeleton } from '../../../src/components/ClimbListRowSkeleton';
import {
  PlaylistDetailView,
  SKELETON_PLACEHOLDERS,
  PlaylistFormSheet,
  PlaylistActionsMenu,
  PlaylistFollowButton,
  PlaylistEditDoneButton,
  PlaylistOwnerToolbar,
  PlaylistStateHeader,
  PlaylistDiscussionRow,
  PlaylistFilterBar,
  type PlaylistFormValues,
  type PlaylistDetailEmptyState,
  type PlaylistFilterStatus,
} from '../../../src/components/playlist';
import { ClimbFilterSheet, type ClimbFilterSheetPickers } from '../../../src/components/ClimbFilterSheet';
import { useClimbFilterSession } from '../../../src/hooks/use-climb-filter-session';
import { usePersonalGradesActive } from '../../../src/hooks/use-personal-grades';
import { useSearchGradeSourceActive } from '../../../src/lib/graphql/hooks/search-grade-source';
import { boardConfigKey } from '../../../src/lib/last-search-store';
import { playlistPinnedChipsStore } from '../../../src/lib/playlist-pinned-chips-store';
import { PLAYLIST_PINNABLE_CHIP_KINDS } from '../../../src/lib/playlist-pinnable-chips';
import {
  PLAYLIST_ACTIVE_BOARD_ONLY_CHIPS,
  playlistSheetSections,
} from '../../../src/lib/playlists/playlist-board-scope';
import { playlistSortModel, type PlaylistSessionSort } from '../../../src/lib/playlists/playlist-sort-model';
import { playlistSortMemoryKey, readListSort, writeListSort } from '../../../src/lib/playlists/playlist-sort-memory';
import {
  PLAYLIST_FILTER_DEFAULTS,
  playlistEmptyKind,
  playlistSourceId,
  playlistViewKey,
  toPlaylistViewInput,
  type PlaylistEmptyKind,
  type PlaylistSelection,
} from '../../../src/lib/playlists/playlist-view';
import { listAddToQueueCount } from '../../../src/lib/playlists/list-add-to-queue-count';
import { CommentSheet } from '../../../src/components/you/CommentSheet';
import { GlassIconButton } from '../../../src/components/GlassIconButton';
import { getHttpClient } from '../../../src/lib/graphql/client';
import { useComments } from '../../../src/lib/graphql/hooks';
import { useActiveBoard } from '../../../src/lib/graphql/use-active-board';
import { usePlaylistActivation } from '../../../src/lib/playlists/use-playlist-activation';
import { usePlaylistRenderBoard } from '../../../src/lib/playlists/use-playlist-render-board';
import { resolvePlaylistClimbRenderBoard } from '../../../src/lib/playlists/playlist-climb-render-board';
import { recordPlaylistOpen } from '../../../src/lib/playlists/recents-store';
import { reportHandledError } from '../../../src/lib/error-reporting';
import { toQueueClimbs } from '../../../src/lib/climb-types';
import { hapticSelection } from '../../../src/lib/haptics';
import { useAuth } from '../../../src/providers/auth-provider';
import { useIsSharedSession } from '../../../src/providers/queue-provider';
import { useToast } from '../../../src/providers/toast-provider';
import { useTheme } from '../../../src/providers/theme-provider';

type DetailParams = {
  playlist_uuid: string;
};
const EMPTY_CLIMBS: Climb[] = [];
/** Most rows the editor loads to match a sorted list before it opens (10 pages of 20). */
const MAX_EDIT_ROWS = 200;

/**
 * The view whose rows are on screen: what the play drawer, Add to queue and the
 * empty state use. `selection` is what was asked for (null for the plain order).
 */
type SettledPlaylistView = {
  view: GetPlaylistClimbsInput['view'];
  key: string | null;
  selection: PlaylistSelection | null;
};
const PLAIN_PLAYLIST_VIEW: SettledPlaylistView = { view: undefined, key: null, selection: null };

export default function PlaylistDetail() {
  const privacyGeneration = useSyncExternalStore(
    subscribeToPrivacyRevocations,
    getPrivacyRevocationGeneration,
    getPrivacyRevocationGeneration,
  );
  const { playlist_uuid: playlistUuid } = useLocalSearchParams<DetailParams>();
  const { t } = useTranslation('playlists');
  const navigation = useNavigation();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { isAuthenticated } = useAuth();
  // Whether anyone else is in this session. Read off a dedicated selector context
  // so the ≤1/2s session-stats push doesn't re-render this screen's list — the
  // boolean flips only across the solo ↔ crew boundary.
  const isSharedSession = useIsSharedSession();
  const { showToast } = useToast();
  const { systemColors, brandColors } = useTheme();
  const { updatePlaylist, deletePlaylist, pinPlaylist, unpinPlaylist, followPlaylist, unfollowPlaylist } =
    usePlaylistMutations();
  const { reorderPlaylistClimb, removeClimbFromPlaylist } = usePlaylistItemMutations();

  // Playlist metadata for the hero (name, climb count, colour, icon, ownership,
  // pin/follow state).
  const {
    data: playlist,
    isLoading: metaLoading,
    isError: metaError,
    refetch: refetchMeta,
  } = useQuery({
    queryKey: ['playlist', playlistUuid],
    queryFn: async () => {
      const response = await getHttpClient().request<GetPlaylistQueryResponse, GetPlaylistQueryVariables>(
        GET_PLAYLIST,
        {
          playlistId: playlistUuid,
        },
      );
      return response.playlist;
    },
    enabled: !!playlistUuid,
  });

  // Render the list at the user's selected wall angle: in all-boards mode the
  // resolver renders on-active-board climbs' grades at `activeAngle` instead of
  // the added-at / most-ascents fallback. `boardName` is deliberately omitted so
  // the resolver stays in all-boards mode and still lists off-board climbs
  // (dimmed) rather than filtering them out.
  const activeBoard = useActiveBoard().data ?? null;
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

  // Sort and filters (#6651). The sort a climber picked here is remembered per
  // playlist (a synchronous read, so the first request already carries it);
  // filters start empty on every visit. Edit mode pauses the view.
  const [initialSort] = useState(() => readListSort(playlistSortMemoryKey(playlistUuid), playlistSortModel));
  const rememberSort = useCallback(
    (sort: PlaylistSessionSort) => writeListSort(playlistSortMemoryKey(playlistUuid), sort, playlistSortModel),
    [playlistUuid],
  );
  const [editMode, setEditMode] = useState(false);
  // Edit was tapped and the playlist's own order is still loading: the editor
  // opens once those rows are on screen (see the effect below).
  const [pendingEdit, setPendingEdit] = useState(false);
  // The sheet's live count. The session hook runs before the query that answers
  // it, so the count is mirrored here (in an effect, below) and kept while a
  // new view loads.
  const [sheetMatchCount, setSheetMatchCount] = useState<number | null>(null);
  const filterScopeKey = playlistUuid
    ? `playlist:${playlistUuid}|${activeBoardConfig ? boardConfigKey(activeBoardConfig) : 'none'}|${isAuthenticated}`
    : null;
  // The sheet's pickers push onto the Discover stack, and its Setters row lists
  // this playlist's setters. Hold types offers no heatmap: it counts the
  // board's catalogue, not this playlist.
  const filterPickers = useMemo<ClimbFilterSheetPickers>(
    () => ({ stack: 'discover', heatmap: false, setterList: { kind: 'playlist', playlistId: playlistUuid } }),
    [playlistUuid],
  );
  const { state: filterState, actions: filterActions } = useClimbFilterSession({
    scopeKey: filterScopeKey,
    boardConfig: activeBoardConfig,
    gradeBoardName: activeBoard?.boardType ?? playlist?.boardType ?? '',
    defaultFilters: PLAYLIST_FILTER_DEFAULTS,
    sortModel: playlistSortModel,
    initialSort,
    onSortCommit: rememberSort,
    pinStore: playlistPinnedChipsStore,
    pinnable: PLAYLIST_PINNABLE_CHIP_KINDS,
    // Without an active board the filters that pass only its climbs would match
    // nothing, so their rows and chips go (#6651, PR 1's board rule).
    sections: playlistSheetSections(!!activeBoard),
    activeBoardAvailable: !!activeBoard,
    activeBoardOnlyChips: PLAYLIST_ACTIVE_BOARD_ONLY_CHIPS,
    pickers: filterPickers,
    liveCount: sheetMatchCount,
    disabled: editMode || pendingEdit,
    namePlaceholder: t('detail.view.namePlaceholder'),
  });
  const personalGrades = usePersonalGradesActive();
  const boardseshGrades = useSearchGradeSourceActive();
  // Undefined for the playlist's own order with no filter: the request then goes
  // out exactly as it did before views existed.
  const viewInput = useMemo(
    () => toPlaylistViewInput(filterState.querySelection, { personalGrades, boardseshGrades }),
    [filterState.querySelection, personalGrades, boardseshGrades],
  );
  const viewKey = useMemo(() => playlistViewKey(viewInput), [viewInput]);
  const hasView = viewInput !== undefined;
  // The view's board-only filters (progress, ratings, "fits my board") read the
  // rest of the active board; a plain request stays as it was. The plain input
  // is kept on its own: the editor marks the plain order's cache entry, whose
  // key is built from it (no geometry), whatever view is on screen.
  const plainBoardInput = useMemo<PlaylistClimbsBoardInput | undefined>(
    () => (activeBoard ? { activeBoardName: activeBoard.boardType, activeAngle: activeBoard.angle } : undefined),
    [activeBoard],
  );
  const playlistClimbsBoardInput = useMemo<PlaylistClimbsBoardInput | undefined>(
    () =>
      activeBoard && plainBoardInput && hasView
        ? {
            ...plainBoardInput,
            activeLayoutId: activeBoard.layoutId,
            activeSizeId: activeBoard.sizeId,
            activeSetIds: activeBoard.setIds,
          }
        : plainBoardInput,
    [activeBoard, plainBoardInput, hasView],
  );
  const { query, allClimbs } = usePlaylistClimbs({
    playlistUuid,
    // Key the cache by the active board so switching board/angle refetches at
    // the new angle instead of serving stale grades.
    boardUuid: activeBoard?.uuid ?? null,
    boardInput: playlistClimbsBoardInput,
    view: viewInput,
  });

  // While a new sort or filter loads, the previous view's rows stay up
  // (placeholder data). The settled view is the one those rows belong to, so the
  // play drawer's track, the activation source and Add to queue always follow
  // what is on screen. Updated during render, in the same pass that shows the
  // new rows: React's "adjust state while rendering" pattern. An effect would
  // leave one committed frame where the new rows show under the old view, and a
  // tap in that frame would queue the wrong order. The guard compares keys, so
  // it costs one extra render per view change and cannot loop.
  const [settledView, setSettledView] = useState<SettledPlaylistView>(PLAIN_PLAYLIST_VIEW);
  // Rows a failed refetch kept count as on screen too: they are what the climber sees.
  const viewRowsOnScreen = query.data !== undefined && !query.isPlaceholderData;
  if (viewRowsOnScreen && settledView.key !== viewKey) {
    setSettledView({ view: viewInput, key: viewKey, selection: viewKey === null ? null : filterState.querySelection });
  }
  const firstPage = query.data?.pages[0];
  const totalCount = firstPage?.totalCount;
  // Only a filtering view carries it, so it also says "the rows on screen are filtered".
  const unfilteredCount = firstPage?.unfilteredCount ?? null;
  // The sheet subtitle can trail the list by a frame, so this needs no render-time update.
  useEffect(() => {
    if (totalCount !== undefined) setSheetMatchCount(totalCount);
  }, [totalCount]);

  // Suggestion-refresh fetcher: pages the same playlist scoped to the active
  // board so the play-drawer swipe walks the whole playlist on that board.
  const fetchPage = useCallback(
    async ({
      page,
      pageSize,
      board,
      signal,
    }: {
      page: number;
      pageSize: number;
      board: { boardName: string; layoutId: number; sizeId: number; setIds: string; angle: number };
      signal: AbortSignal;
    }) => {
      const input: GetPlaylistClimbsInput = {
        playlistId: playlistUuid,
        boardName: board.boardName,
        layoutId: board.layoutId,
        sizeId: board.sizeId,
        setIds: board.setIds,
        angle: board.angle,
        page,
        pageSize,
        // The view on screen, so the drawer swipes and Add to queue walk the
        // same sorted, filtered rows the climber sees.
        ...(settledView.view ? { view: settledView.view } : {}),
      };
      // See the smart-playlist screen: passing the signal is what turns
      // "stop paging" into "cancel the request that is already out".
      const response = await getHttpClient().request<GetPlaylistClimbsQueryResponse, { input: GetPlaylistClimbsInput }>(
        {
          document: GET_PLAYLIST_CLIMBS,
          variables: { input },
          signal,
        },
      );
      return {
        climbs: toQueueClimbs(response.playlistClimbs.climbs),
        hasMore: response.playlistClimbs.hasMore,
      };
    },
    [playlistUuid, settledView.view],
  );

  // Prefer the active board for row rendering; mixed-board climbs resolve their
  // own board per row and dim when they do not fit the active board. The banner
  // still prompts a switch for list-level board mismatches.
  const { renderBoard, banner: boardBanner } = usePlaylistRenderBoard(
    playlist ? { boardType: playlist.boardType, layoutId: playlist.layoutId } : null,
  );

  const shouldOpenViewOnly = !!boardBanner;
  const resolveViewOnlyBoard = useCallback(
    (climb: Climb) => {
      if (!shouldOpenViewOnly) return null;
      const resolvedRenderBoard = resolvePlaylistClimbRenderBoard(climb, renderBoard);
      return resolvedRenderBoard?.incompatible ? resolvedRenderBoard.renderBoard : null;
    },
    [shouldOpenViewOnly, renderBoard],
  );

  const playlistActivation = usePlaylistActivation({
    sourceId: playlistSourceId(playlistUuid, settledView.key),
    allClimbs,
    fetchPage,
    viewOnlyBoard: resolveViewOnlyBoard,
    // In a crew a row tap browses: it opens the drawer on the tapped climb with
    // the playlist seeded as the swipe track, and leaves the queue alone. The
    // alternative here is the loudest write in the app — `replaceQueueOnActivate`
    // swaps the whole crew's queue for the playlist order and takes the wall,
    // which is not what tapping a row to look at it means.
    previewOnly: isSharedSession,
    refreshErrorMessage: 'Failed to refresh playlist suggestions:',
    replaceQueueOnActivate: true,
  });

  const isOwner = playlist?.userRole === 'owner';
  const isFollowable = !!playlist?.isPublic && !isOwner;

  // General playlist discussion — the same `<uuid>:_all` entity web's
  // CommentSection uses, and only on public playlists (web gates the same way).
  const discussionEntityId = playlist?.isPublic ? `${playlistUuid}:_all` : null;
  const commentSheetRef = useRef<BottomSheet | null>(null);
  const [discussionOpen, setDiscussionOpen] = useState(false);
  // Shares its react-query key with the sheet's own useComments, so opening the
  // sheet reads the cache instead of firing a second request.
  const discussionQuery = useComments('playlist_climb', discussionEntityId ?? undefined, !!discussionEntityId);
  const commentCount = discussionQuery.data?.totalCount ?? 0;

  const openDiscussion = useCallback(() => {
    setDiscussionOpen(true);
    // Stacked native sheets must be presented imperatively; a `visible`-prop
    // effect is a silent no-op here.
    commentSheetRef.current?.snapToIndex(0);
  }, []);

  const closeDiscussion = useCallback(() => setDiscussionOpen(false), []);

  // Interactive state seeded from the loaded playlist, updated optimistically.
  const [isPinned, setIsPinned] = useState(false);
  const [isFollowing, setIsFollowing] = useState(false);
  const [followerCount, setFollowerCount] = useState(0);
  const [followLoading, setFollowLoading] = useState(false);
  const [editVisible, setEditVisible] = useState(false);
  const [savingEdit, setSavingEdit] = useState(false);
  // Update failures surface INLINE in the edit sheet, not via a root toast — a
  // toast fired while the native sheet is open renders behind it and is invisible.
  // The sheet stays open on failure so the user can fix and retry.
  const [editError, setEditError] = useState<string | null>(null);

  // Climbs edit mode (reorder + remove). `editClimbs` is a frozen snapshot of the
  // loaded list seeded on entry; the list renders from it while editing so
  // moves/removals show instantly. A ref mirrors it for the async handlers' reads
  // and revert snapshots. Pagination is paused while editing (v1 edits the loaded
  // window); on exit we invalidate so the canonical server order reloads. The
  // editor always shows the playlist's own order (a reorder index means a place
  // in that order), so entering it pauses any sort or filter first.
  const [editSnapshot, setEditClimbs] = usePrivacyScopedState<Climb[]>(null);
  const editClimbs = editSnapshot ?? EMPTY_CLIMBS;
  const editClimbsRef = useRef<Climb[]>([]);
  const climbGenerations = useRef(new WeakMap<Climb, number>());
  const visibleAllClimbs = useMemo(
    () =>
      allClimbs.filter((climb) => {
        if (!climbGenerations.current.has(climb)) climbGenerations.current.set(climb, privacyGeneration);
        return climbGenerations.current.get(climb) === privacyGeneration;
      }),
    [allClimbs, privacyGeneration],
  );
  // Always-current view of the loaded climbs so enterEditMode seeds from the
  // latest data, not the snapshot captured when the actions menu opened.
  const allClimbsRef = useRef(visibleAllClimbs);
  allClimbsRef.current = visibleAllClimbs;
  const resumeFilterView = filterActions.resumeView;
  useEffect(
    () =>
      subscribeToPrivacyRevocations(() => {
        // Retire imperative callbacks before React and query cancellation settle.
        editClimbsRef.current = [];
        allClimbsRef.current = [];
        setEditMode(false);
        setPendingEdit(false);
        // Leaving edit this way still gives the climber their sort back.
        resumeFilterView();
      }),
    [resumeFilterView],
  );

  const setEditList = useCallback(
    (list: Climb[]) => {
      if (privacyGeneration !== getPrivacyRevocationGeneration()) return;
      editClimbsRef.current = list;
      setEditClimbs(list);
    },
    [privacyGeneration, setEditClimbs],
  );

  // A reorder index is a place in the playlist's own order (#4012), so a drag
  // must never run against a sorted or filtered list.
  const viewActive = viewKey !== null || settledView.key !== null;
  const viewActiveRef = useRef(viewActive);
  viewActiveRef.current = viewActive;

  // The editor works on the playlist's own order: a reorder index is a place in
  // it (#4012). With a sort or filter on, that order's cached pages may be stale
  // (an add or remove refetches only the view on screen), so they are marked
  // stale and refetched before the editor reads them; the editor also loads as
  // many rows as the sorted list showed. Seeding at once would freeze the sorted
  // rows, or old plain rows whose indices are off by one.
  const editTargetRowsRef = useRef(0);
  // Built from the options the list's usePlaylistClimbs call gets for the plain
  // order (no view, so no geometry either), so the editor marks exactly the
  // cache entry the plain order lives in.
  const activeBoardUuid = activeBoard?.uuid ?? null;
  const plainOrderQueryKey = useMemo(
    () => playlistClimbsQueryKeyFor({ playlistUuid, boardUuid: activeBoardUuid, boardInput: plainBoardInput }),
    [playlistUuid, activeBoardUuid, plainBoardInput],
  );
  const enterEditMode = useCallback(() => {
    if (privacyGeneration !== getPrivacyRevocationGeneration()) return;
    editTargetRowsRef.current = Math.min(allClimbsRef.current.length, MAX_EDIT_ROWS);
    if (viewActiveRef.current) {
      void queryClient.invalidateQueries({ queryKey: plainOrderQueryKey, exact: true, refetchType: 'none' });
    }
    filterActions.pauseView();
    setPendingEdit(true);
  }, [filterActions, privacyGeneration, queryClient, plainOrderQueryKey]);

  // Back out of a pending edit: the view the climber had comes back.
  const cancelPendingEdit = useCallback(() => {
    setPendingEdit(false);
    filterActions.resumeView();
  }, [filterActions]);

  // The plain order's rows are on screen, fetched, and not still refreshing. A
  // failed next page still counts: the rows loaded so far are a true prefix.
  const plainOrderReady =
    viewKey === null &&
    settledView.key === null &&
    !query.isPlaceholderData &&
    !query.isFetching &&
    (query.isSuccess || query.isFetchNextPageError);
  // It cannot be loaded now: the request failed (and is not being retried), or
  // it is paused with no connection (React Query waits instead of failing then).
  const plainOrderUnavailable =
    viewKey === null &&
    ((query.isError && !query.isFetchNextPageError && !query.isFetching) || query.fetchStatus === 'paused');
  const loadedRowCount = visibleAllClimbs.length;
  const { hasNextPage, isFetchNextPageError, fetchNextPage } = query;
  useEffect(() => {
    if (!pendingEdit) return;
    if (privacyGeneration !== getPrivacyRevocationGeneration()) {
      cancelPendingEdit();
      return;
    }
    if (plainOrderUnavailable) {
      // Nothing safe to edit: give the climber their view back and say why.
      cancelPendingEdit();
      showToast(t('detail.errors.loadDescription'), 'error');
      return;
    }
    if (!plainOrderReady) return;
    if (hasNextPage && !isFetchNextPageError && loadedRowCount < editTargetRowsRef.current) {
      void fetchNextPage();
      return;
    }
    setEditList(allClimbsRef.current);
    setEditMode(true);
    setPendingEdit(false);
  }, [
    pendingEdit,
    privacyGeneration,
    plainOrderUnavailable,
    plainOrderReady,
    hasNextPage,
    isFetchNextPageError,
    loadedRowCount,
    fetchNextPage,
    cancelPendingEdit,
    setEditList,
    showToast,
    t,
  ]);

  const exitEditMode = useCallback(() => {
    setEditMode(false);
    setEditList([]);
    void queryClient.invalidateQueries({ queryKey: ['playlistClimbs', playlistUuid] });
    void queryClient.invalidateQueries({ queryKey: ['playlist', playlistUuid] });
    // A removed climb can take its setter off the Setters picker.
    void queryClient.invalidateQueries({ queryKey: ['playlistSetters', playlistUuid] });
    // The sort the climber had before editing comes back; filters stay cleared.
    filterActions.resumeView();
  }, [setEditList, queryClient, playlistUuid, filterActions]);

  const handleReorderClimb = useCallback(
    async (climbUuid: string, newIndex: number) => {
      if (privacyGeneration !== getPrivacyRevocationGeneration()) return;
      if (viewActiveRef.current) return;
      const current = editClimbsRef.current;
      const oldIndex = current.findIndex((climb) => climb.uuid === climbUuid);
      if (oldIndex === -1) return;
      // Clamp — the screen-reader actions can ask for an index past either edge.
      const target = Math.max(0, Math.min(newIndex, current.length - 1));
      if (oldIndex === target) return;
      const next = [...current];
      const [moved] = next.splice(oldIndex, 1);
      next.splice(target, 0, moved);
      setEditList(next);
      try {
        await reorderPlaylistClimb({ playlistId: playlistUuid, climbUuid, newIndex: target });
      } catch (err) {
        if (privacyGeneration !== getPrivacyRevocationGeneration()) return;
        console.error('Failed to reorder playlist climb:', err);
        reportHandledError(err, { tags: { source: 'playlist', op: 'reorder-climb' } });
        // Only wholesale-restore the pre-move snapshot if no other edit landed in
        // the meantime; otherwise a concurrent op's optimistic state would be
        // clobbered, so reconcile from the server instead.
        if (editClimbsRef.current === next) {
          setEditList(current);
        } else {
          void queryClient.invalidateQueries({ queryKey: ['playlistClimbs', playlistUuid] });
        }
        showToast(t('editClimbs.reorderFailed'), 'error');
      }
    },
    [reorderPlaylistClimb, playlistUuid, setEditList, queryClient, showToast, t, privacyGeneration],
  );

  const handleRemoveClimb = useCallback(
    (climbUuid: string) => {
      if (privacyGeneration !== getPrivacyRevocationGeneration()) return;
      const target = editClimbsRef.current.find((climb) => climb.uuid === climbUuid);
      Alert.alert(
        t('editClimbs.removeConfirm.title'),
        t('editClimbs.removeConfirm.message', { name: target?.name ?? '' }),
        [
          { text: t('editClimbs.removeConfirm.cancel'), style: 'cancel' },
          {
            text: t('editClimbs.removeConfirm.confirm'),
            style: 'destructive',
            onPress: async () => {
              if (privacyGeneration !== getPrivacyRevocationGeneration()) return;
              const current = editClimbsRef.current;
              const next = current.filter((climb) => climb.uuid !== climbUuid);
              if (next.length === current.length) return;
              setEditList(next);
              // Optimistically decrement the hero climb count.
              queryClient.setQueryData<Playlist | null>(['playlist', playlistUuid], (prev) =>
                prev ? { ...prev, climbCount: Math.max(0, prev.climbCount - 1) } : prev,
              );
              try {
                await removeClimbFromPlaylist({ playlistId: playlistUuid, climbUuid });
              } catch (err) {
                if (privacyGeneration !== getPrivacyRevocationGeneration()) return;
                console.error('Failed to remove playlist climb:', err);
                reportHandledError(err, { tags: { source: 'playlist', op: 'remove-climb' } });
                // Restore only if no concurrent edit landed since; otherwise
                // reconcile from the server so we don't clobber it.
                if (editClimbsRef.current === next) {
                  setEditList(current);
                } else {
                  void queryClient.invalidateQueries({ queryKey: ['playlistClimbs', playlistUuid] });
                }
                // Reconcile the climb count from the server rather than adding 1
                // back — a manual +1 would overshoot if a concurrent add already
                // bumped the count.
                void queryClient.invalidateQueries({ queryKey: ['playlist', playlistUuid] });
                showToast(t('editClimbs.removeFailed'), 'error');
              }
            },
          },
        ],
      );
    },
    [removeClimbFromPlaylist, playlistUuid, setEditList, queryClient, showToast, t, privacyGeneration],
  );

  // Re-seed interactive state whenever the cached playlist changes — including
  // after a mutation writes its response back via setQueryData. Safe because the
  // GraphQL payloads (the updatePlaylist response + our optimistic setQueryData)
  // all carry accurate isPinnedByMe/isFollowedByMe/followerCount (the update
  // resolver recomputes pin/follow stats), so reseeding can't clobber an
  // optimistic flip with a stale value.
  useEffect(() => {
    if (!playlist) return;
    setIsPinned(playlist.isPinnedByMe);
    setIsFollowing(playlist.isFollowedByMe);
    setFollowerCount(playlist.followerCount);
  }, [playlist]);

  // Record the open for the "recently opened" pinned fallback. Smart playlists
  // (a separate route) are deliberately not recorded — no uuid/board to match.
  // Guard on the uuid so optimistic `setQueryData` updates (pin/follow/edit),
  // which replace the `playlist` object reference, don't re-record + spuriously
  // refresh the library's recents fallback on every tap.
  const recordedUuidRef = useRef<string | null>(null);
  useEffect(() => {
    if (!playlist || recordedUuidRef.current === playlist.uuid) return;
    recordedUuidRef.current = playlist.uuid;
    void recordPlaylistOpen({
      uuid: playlist.uuid,
      boardType: playlist.boardType,
      layoutId: playlist.layoutId ?? null,
    });
  }, [playlist]);

  const handleTogglePin = useCallback(async () => {
    if (!playlist) return;
    const next = !isPinned;
    setIsPinned(next);
    // Update the cache before the await so the reseed effect mirrors the
    // optimistic value (not a stale one) if it fires mid-request.
    queryClient.setQueryData<Playlist | null>(['playlist', playlistUuid], (prev) =>
      prev ? { ...prev, isPinnedByMe: next } : prev,
    );
    try {
      if (next) await pinPlaylist(playlist.uuid);
      else await unpinPlaylist(playlist.uuid);
    } catch (err) {
      console.error('Failed to toggle pin:', err);
      reportHandledError(err, { tags: { source: 'playlist', op: 'toggle-pin' } });
      setIsPinned(!next);
      queryClient.setQueryData<Playlist | null>(['playlist', playlistUuid], (prev) =>
        prev ? { ...prev, isPinnedByMe: !next } : prev,
      );
      showToast(t(next ? 'library.pin.pinFailed' : 'library.pin.unpinFailed'), 'error');
    }
  }, [playlist, isPinned, pinPlaylist, unpinPlaylist, queryClient, playlistUuid, showToast, t]);

  const handleToggleFollow = useCallback(async () => {
    if (!playlist) return;
    const next = !isFollowing;
    const delta = next ? 1 : -1;
    setIsFollowing(next);
    setFollowerCount((count) => count + delta);
    // Update the cache before the await so a reseed mid-request mirrors the
    // optimistic count, and the error path can't double-revert from a stale one.
    queryClient.setQueryData<Playlist | null>(['playlist', playlistUuid], (prev) =>
      prev ? { ...prev, isFollowedByMe: next, followerCount: prev.followerCount + delta } : prev,
    );
    setFollowLoading(true);
    try {
      if (next) await followPlaylist(playlist.uuid);
      else await unfollowPlaylist(playlist.uuid);
    } catch (err) {
      console.error('Failed to toggle follow:', err);
      reportHandledError(err, { tags: { source: 'playlist', op: 'toggle-follow' } });
      setIsFollowing(!next);
      setFollowerCount((count) => count - delta);
      queryClient.setQueryData<Playlist | null>(['playlist', playlistUuid], (prev) =>
        prev ? { ...prev, isFollowedByMe: !next, followerCount: prev.followerCount - delta } : prev,
      );
      showToast(t('detail.followFailed'), 'error');
    } finally {
      setFollowLoading(false);
    }
  }, [playlist, isFollowing, followPlaylist, unfollowPlaylist, queryClient, playlistUuid, showToast, t]);

  const handleEditSubmit = useCallback(
    async (values: PlaylistFormValues) => {
      if (!playlist) return;
      setSavingEdit(true);
      setEditError(null);
      try {
        const updated = await updatePlaylist({
          playlistId: playlist.uuid,
          name: values.name,
          // The form emits '' for cleared description/colour/icon in edit mode,
          // so the removals persist; pass them straight through.
          description: values.description,
          color: values.color,
          icon: values.icon,
          isPublic: values.isPublic,
        });
        queryClient.setQueryData(['playlist', playlistUuid], updated);
        // Also patch the Add-to-Playlist picker's react-query list (the shelves
        // refetch on focus, but this cache wouldn't until its staleTime lapses).
        queryClient.setQueryData<Playlist[]>(['userPlaylists'], (prev) =>
          prev?.map((entry) => (entry.uuid === updated.uuid || entry.id === updated.id ? updated : entry)),
        );
        setEditVisible(false);
        showToast(t('edit.messages.updated'), 'success');
      } catch (err) {
        console.error('Failed to update playlist:', err);
        reportHandledError(err, { tags: { source: 'playlist', op: 'update' } });
        // Inline, not a toast: the sheet is still open, so a root toast would be
        // hidden behind it.
        setEditError(t('edit.messages.updateFailed'));
      } finally {
        setSavingEdit(false);
      }
    },
    [playlist, updatePlaylist, queryClient, playlistUuid, showToast, t],
  );

  const handleDelete = useCallback(() => {
    if (!playlist) return;
    Alert.alert(t('detail.deleteConfirm.title'), t('detail.deleteConfirm.message', { name: playlist.name }), [
      { text: t('detail.deleteConfirm.cancel'), style: 'cancel' },
      {
        text: t('detail.deleteConfirm.confirm'),
        style: 'destructive',
        onPress: async () => {
          try {
            await deletePlaylist(playlist.uuid);
            queryClient.removeQueries({ queryKey: ['playlist', playlistUuid] });
            showToast(t('detail.deleted'), 'success');
            navigation.goBack();
          } catch (err) {
            console.error('Failed to delete playlist:', err);
            reportHandledError(err, { tags: { source: 'playlist', op: 'delete' } });
            showToast(t('detail.deleteFailed'), 'error');
          }
        },
      },
    ]);
  }, [playlist, deletePlaylist, queryClient, playlistUuid, showToast, t, navigation]);

  // Cog (shown in edit mode) → open the edit-details sheet directly.
  const openEditDetails = useCallback(() => {
    setEditError(null);
    setEditVisible(true);
  }, []);

  // There is no add-from-here flow yet — adding runs through a climb's own
  // action menu — so both the overflow row and the empty-state CTA just land the
  // user on the Climbs tab instead of leaving them at a dead end (#3966).
  const goToClimbs = useCallback(() => router.navigate('/(tabs)/climbs'), [router]);

  // Owners only, and only while the playlist matches the active board — when it
  // does not, the switch-board banner owns that prompt. A list filtered to
  // nothing offers Clear filters instead.
  const canAddClimbs = isOwner && !boardBanner;
  const { clearFilters, openFilters } = filterActions;
  // The empty state follows the response on screen: the server sends
  // `unfilteredCount` only for a filtering view, so an empty page with it is a
  // list filtered to nothing, worded for the filter that was asked for. A failed
  // request (a view can be rate limited) says so and offers a retry, rather than
  // passing for an empty or filtered-out playlist.
  const climbsFailed = query.isError && visibleAllClimbs.length === 0;
  const settledSelection = settledView.selection;
  const emptyKind: PlaylistEmptyKind | null =
    !climbsFailed && unfilteredCount != null && settledSelection ? playlistEmptyKind(settledSelection) : null;
  const retryClimbs = query.refetch;
  const emptyAction = useMemo(() => {
    if (climbsFailed) return { label: t('detail.errors.tryAgain'), onPress: () => void retryClimbs() };
    if (emptyKind) return { label: t('detail.view.clearFilters'), onPress: clearFilters };
    return canAddClimbs ? { label: t('detail.menu.addClimbs'), icon: 'add' as const, onPress: goToClimbs } : undefined;
  }, [climbsFailed, retryClimbs, emptyKind, clearFilters, canAddClimbs, goToClimbs, t]);
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
        return t('detail.empty');
    }
  }, [climbsFailed, emptyKind, queriedName, t]);
  const emptyState = useMemo<PlaylistDetailEmptyState | undefined>(() => {
    if (climbsFailed) return { icon: 'error', title: emptyMessage, supporting: t('detail.errors.loadDescription') };
    return emptyKind ? { icon: 'filter', title: emptyMessage } : undefined;
  }, [climbsFailed, emptyKind, emptyMessage, t]);
  const emptyIcon = climbsFailed ? 'error' : emptyKind ? 'filter' : undefined;

  // The filter chrome under the hero. A playlist with no climbs at all has
  // nothing to filter, so it shows none.
  const showFilterControls = !(playlist && playlist.climbCount === 0);
  const filterEditing = editMode || pendingEdit;
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
          editing={filterEditing}
        />
      ) : null,
    [
      showFilterControls,
      filterState.chipRowProps,
      filterState.tokens,
      filterState.gradeRail,
      filterStatus,
      filterEditing,
    ],
  );
  const activeFilterCount = filterState.activeFilterCount;
  const filterAction = useMemo(
    () => (showFilterControls && !filterEditing ? { activeCount: activeFilterCount, onPress: openFilters } : null),
    [showFilterControls, filterEditing, activeFilterCount, openFilters],
  );
  // "Add 12 to queue" while the rows on screen are filtered (`listAddToQueueCount`).
  // `totalCount` comes from the live query and `settledFitsBoard` from the
  // settled view. They agree: while a new view loads, the query's data IS the
  // settled view's placeholder rows, so both describe the same list.
  const settledFitsBoard = !!settledView.view?.onlyActiveBoard;
  const addToQueueCount = useMemo(
    () =>
      listAddToQueueCount({
        unfilteredCount,
        totalCount,
        fitsBoard: settledFitsBoard,
        hasNextPage: !!hasNextPage,
        renderBoard,
        climbs: visibleAllClimbs,
      }),
    [unfilteredCount, totalCount, settledFitsBoard, hasNextPage, renderBoard, visibleAllClimbs],
  );

  // Header controls over the hero. Owners get a pin · edit · delete toolbar that
  // collapses to a single overflow ⋯ menu on scroll (and always on Material,
  // which asks for the collapsed form). Non-owners keep follow + pin. Edit mode
  // replaces everything with Done.
  const renderActions = useCallback(
    (collapsed: boolean) => {
      if (!playlist) return null;
      if (editMode) {
        return <PlaylistEditDoneButton onPress={exitEditMode} collapsed={collapsed} />;
      }
      // The editor is waiting for the playlist order; Done backs out, so a slow
      // or dropped request can never leave the screen stuck with grey chips.
      if (pendingEdit) {
        return <PlaylistEditDoneButton onPress={cancelPendingEdit} collapsed={collapsed} />;
      }
      if (isOwner) {
        if (collapsed) {
          return (
            <PlaylistActionsMenu
              isPinned={isPinned}
              onTogglePin={handleTogglePin}
              onAddClimbs={canAddClimbs ? goToClimbs : undefined}
              onEditDetails={openEditDetails}
              onEdit={enterEditMode}
              onDelete={handleDelete}
            />
          );
        }
        return (
          <PlaylistOwnerToolbar
            isPinned={isPinned}
            onTogglePin={handleTogglePin}
            onEdit={enterEditMode}
            onDelete={handleDelete}
          />
        );
      }
      // Signed out there is nothing to follow or pin: no item, not an empty one.
      if (!isAuthenticated) return null;
      return (
        <>
          {isFollowable ? (
            <PlaylistFollowButton
              isFollowing={isFollowing}
              onToggle={handleToggleFollow}
              loading={followLoading}
              collapsed={collapsed}
            />
          ) : null}
          <GlassIconButton
            iconName={isPinned ? 'pin.fill' : 'pin'}
            iconColor={systemColors.label}
            onPress={() => {
              hapticSelection();
              void handleTogglePin();
            }}
            accessibilityLabel={isPinned ? t('library.pin.unpinAriaLabel') : t('library.pin.pinAriaLabel')}
            fallbackColor={systemColors.fill}
          />
        </>
      );
    },
    [
      playlist,
      editMode,
      exitEditMode,
      pendingEdit,
      cancelPendingEdit,
      isOwner,
      isPinned,
      handleTogglePin,
      enterEditMode,
      handleDelete,
      isAuthenticated,
      isFollowable,
      isFollowing,
      handleToggleFollow,
      followLoading,
      canAddClimbs,
      goToClimbs,
      openEditDetails,
      systemColors,
      brandColors,
      t,
    ],
  );

  // Pull to refresh (HIG Refresh content controls): the playlist's details, its
  // climbs and the discussion count.
  const { refetch: refetchClimbs } = query;
  const { refetch: refetchDiscussion } = discussionQuery;
  const handleRefresh = useCallback(
    () => Promise.all([refetchMeta(), refetchClimbs(), discussionEntityId ? refetchDiscussion() : undefined]),
    [refetchMeta, refetchClimbs, refetchDiscussion, discussionEntityId],
  );

  const hero = useMemo(
    () => ({
      name: playlist?.name ?? t('metadata.detail.fallbackTitle'),
      // `unfilteredCount` is null exactly when no filter is on, and then
      // `totalCount` is the whole playlist, so this never shows a filtered count.
      climbCount: playlist?.climbCount ?? unfilteredCount ?? totalCount ?? allClimbs.length,
      color: playlist?.color,
      icon: playlist?.icon,
      description: playlist?.description,
      boardType: playlist?.boardType,
      layoutId: playlist?.layoutId,
      showBoardBackdrop: !!playlist?.boardType,
      followerLabel: playlist?.isPublic ? t('detail.followerCount', { count: followerCount }) : undefined,
    }),
    [playlist, unfilteredCount, totalCount, allClimbs.length, followerCount, t],
  );

  // Metadata fetch threw (network/server error): react-query leaves `playlist`
  // undefined (never null), so the not-found guard below would be skipped and
  // a blank fallback-titled hero would render as if it were a real empty
  // playlist. Surface an explicit error + retry instead. Distinct from the
  // resolved-null not-found case.
  if (metaError && !playlist) {
    return (
      <View style={styles.stateContainer}>
        <PlaylistStateHeader />
        <Icon name="error" size={48} color={systemColors.tertiaryLabel} />
        <Text variant="headline" style={styles.stateTitle}>
          {t('detail.errors.loadTitle')}
        </Text>
        <Text variant="subheadline" style={styles.stateSubtitle}>
          {t('detail.errors.loadDescription')}
        </Text>
        <PressableSurface
          onPress={() => {
            void refetchMeta();
            void query.refetch();
          }}
          accessibilityRole="button"
          accessibilityLabel={t('detail.errors.tryAgain')}
          hitSlop={8}
        >
          <Text variant="subheadline" color={brandColors.primary} style={styles.stateRetry}>
            {t('detail.errors.tryAgain')}
          </Text>
        </PressableSurface>
      </View>
    );
  }

  // Playlist not found (resolved, null) — distinct from still-loading.
  if (!metaLoading && playlist === null) {
    return (
      <View style={styles.stateContainer}>
        <PlaylistStateHeader />
        <Icon name="error" size={48} color={systemColors.tertiaryLabel} />
        <Text variant="headline" style={styles.stateTitle}>
          {t('detail.errors.notFoundTitle')}
        </Text>
        <Text variant="subheadline" style={styles.stateSubtitle}>
          {t('detail.errors.notFoundDescription')}
        </Text>
      </View>
    );
  }

  if (metaLoading && allClimbs.length === 0) {
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
        climbs={editMode ? editClimbs : visibleAllClimbs}
        renderBoard={renderBoard}
        boardBanner={boardBanner}
        isLoading={query.isLoading}
        // Pagination is paused while editing the loaded window.
        isFetchingNextPage={editMode ? false : query.isFetchingNextPage}
        hasNextPage={editMode ? false : (query.hasNextPage ?? false)}
        fetchNextPage={query.fetchNextPage}
        onActivateClimb={playlistActivation.activate}
        emptyMessage={emptyMessage}
        emptyIcon={emptyIcon}
        emptyState={emptyState}
        emptyAction={emptyAction}
        actions={renderActions}
        editMode={editMode}
        onReorderClimb={viewActive ? undefined : handleReorderClimb}
        onRemoveClimb={handleRemoveClimb}
        onEditDetails={openEditDetails}
        onAddAllToQueue={playlistActivation.addToQueue.append}
        isAddingAllToQueue={playlistActivation.addToQueue.isAppending}
        addToQueueCount={addToQueueCount}
        onRefresh={handleRefresh}
        filterBar={filterBar}
        filterAction={filterAction}
        scrollResetKey={settledView.key}
        headerSlot={
          discussionEntityId && !editMode ? (
            <PlaylistDiscussionRow commentCount={commentCount} onPress={openDiscussion} />
          ) : null
        }
      />

      <PlaylistFormSheet
        mode="edit"
        visible={editVisible}
        submitting={savingEdit}
        playlist={playlist ?? null}
        submitError={editError}
        onSubmit={handleEditSubmit}
        onClose={() => {
          setEditVisible(false);
          setEditError(null);
        }}
      />

      {filterState.sheetProps ? <ClimbFilterSheet key={filterScopeKey} {...filterState.sheetProps} /> : null}

      <CommentSheet
        sheetRef={commentSheetRef}
        entityType="playlist_climb"
        entityId={discussionOpen ? discussionEntityId : null}
        canComment={isAuthenticated}
        onClose={closeDiscussion}
      />
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
  stateRetry: {
    marginTop: 12,
    fontWeight: '600',
  },
});
