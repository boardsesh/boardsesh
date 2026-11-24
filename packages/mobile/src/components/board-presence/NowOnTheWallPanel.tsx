import { WallStatTile as StatTile, WallHardestSendRow as HardestSendRow } from './WallPanelStatsViews';
import { WallHeroContentView, WallHistoryContentView } from './WallPanelRowViews';
import { NowOnTheWallPanelView } from './NowOnTheWallPanelView';
import { styles } from './wall-panel-styles';
import { PressableSurface } from '../PressableSurface';
// Now-on-the-wall panel — the board-presence "now on the wall" content, factored
// out of BoardSheet so it can render either inside the native BottomSheetModal
// (variant 'sheet', using `@expo/ui`'s BottomSheetFlatList) or as a standalone
// inline column (variant 'column', using a plain react-native FlatList) for the
// iPad shell.
//
// Owns the action-resolution machinery (GET_CLIMB hydration + LRU cache, pending
// generation guards), the interactive row handlers, and pull-to-refresh. The
// hero, stat tiles, hardest-send row and history rows are VIRTUALIZED (the list,
// never .map). State comes from `@boardsesh/board-presence-react`'s split
// current/feed contexts. The now-playing / history-view analytics stay in the
// BoardSheet wrapper so they don't double-fire from the inline column.

import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type Ref,
  type ComponentProps,
} from 'react';
import { FlatList, RefreshControl, View, type ColorValue } from 'react-native';
import { BottomSheetFlatList } from '@expo/ui/community/bottom-sheet';
import { ShowcaseAnchorView } from '../../lib/showcase-anchor';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import {
  boardHistoryEntryKey,
  mergeBoardHistory,
  useBoardHistoryPagination,
  useBoardPresenceActions,
  useBoardPresenceCurrent,
  useBoardPresenceFeed,
} from '@boardsesh/board-presence-react';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import type { BoardName, BoardPresenceClimb, Climb, UserBoard } from '@boardsesh/shared-schema';
import { Text } from '../Text';
import { GymWallSwitcher } from './GymWallSwitcher';

import { SprayWallActions } from '../board-discovery/SprayWallActions';
import type { SprayDetailRowKey } from '../board-discovery/spray-detail-rows';
import { useGymBoards } from '../../lib/graphql/hooks/use-gym-boards';
import { Icon } from '../Icon';
import { ActivityIndicator } from '../ActivityIndicator';
import { ClimbListRow, type ClimbListRowRenderContentArgs } from '../ClimbListRow';

import { BoardLiveSessionsBlock } from '../live-sessions/BoardLiveSessionsBlock';
import { WallDisplayEntry } from './WallDisplayEntry';
import { AccessoryClimbThumbnail } from '../queue-control/AccessoryClimbThumbnail';
import { useTheme } from '../../providers/theme-provider';
import { useToast } from '../../providers/toast-provider';
import { useBoardPresenceControls } from '../../providers/board-presence-provider';
import { track } from '../../lib/analytics';
import type { BoardConfig, ClimbActionsTarget } from '../../providers/drawer-host-provider';
import type { DismissAndWaitResult } from '../../providers/sheet-presentation-provider';
import { useGradeFormat } from '../../hooks/use-grade-format';
import { useDisplayGrade } from '../../hooks/use-display-grade';
import { offlineAwareRequest } from '../../lib/graphql/offline-request';
import { GET_CLIMB, type GetClimbQueryResponse } from '../../lib/graphql/operations';
import { boardPresenceClimbToClimb } from '../../lib/board-presence/presence-climb';
import {
  createPlaylistSuggestionSource,
  getQueueBoardKey,
  type Climb as QueueClimb,
  type PlaylistSuggestionSource,
} from '@boardsesh/queue';
import { toQueueClimb } from '../../lib/climb-types';
import { formatRelativeTime } from '../../lib/format-relative-time';

import { spacing } from '../../theme/tokens';
import { useAuroraPresenceGrades } from '../../hooks/use-aurora-presence-grades';
import { resolveBoardPresenceAngle, withAuroraActionOrientation } from '@boardsesh/board-presence-react/presentation';
import { useWindowBottomInset } from '../../hooks/use-window-bottom-inset';

const ACTION_CLIMB_CACHE_LIMIT = 50;
const MENU_METADATA_HISTORY_LIMIT = 8;
const AURORA_VISIBLE_HISTORY_LIMIT = 49;
const MENU_METADATA_CONCURRENCY = 3;
const MENU_VIEWABILITY_CONFIG = { itemVisiblePercentThreshold: 25, minimumViewTime: 100 };
type HistoryViewabilityChange = Parameters<
  NonNullable<ComponentProps<typeof FlatList<BoardPresenceClimb>>['onViewableItemsChanged']>
>[0];

// Like ShowcaseAnchorView, the capture-only hook is chosen once per JS bundle.
type BoardSheetRowBoard = {
  boardName: BoardName;
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle: number;
};

export type BoardSheetClimbAction = {
  climb: Climb;
  queueItemUuid: string | null;
  boardConfig: BoardConfig;
  /**
   * A row tap only: the wall's history as a swipe track, the wall's climb first
   * and then back through time (issue #6665), so the player walks it the way
   * the sheet lists it. Keyed to the board the sheet shows.
   */
  track?: PlaylistSuggestionSource | null;
  /** A row tap only: the climb is the one lit on the wall right now. */
  isWallClimb?: boolean;
};

export type NowOnTheWallPanelHandle = {
  invalidatePendingActions: () => void;
};

type BoardSheetActionContext = {
  actionBoardConfig: BoardConfig;
  cacheKey: string;
};

function actionBoardConfigForPresenceClimb(boardConfig: BoardConfig, presenceClimb: BoardPresenceClimb): BoardConfig {
  const angle = resolveBoardPresenceAngle(presenceClimb, boardConfig.angle);
  return angle === boardConfig.angle ? boardConfig : { ...boardConfig, angle };
}

function rowBoardForBoardConfig(boardConfig: BoardConfig): BoardSheetRowBoard {
  return {
    boardName: boardConfig.boardName as BoardName,
    layoutId: boardConfig.layoutId,
    sizeId: boardConfig.sizeId,
    setIds: boardConfig.setIds,
    angle: boardConfig.angle,
  };
}

function actionCacheKey(boardConfig: BoardConfig, climbUuid: string): string {
  return [
    boardConfig.boardName,
    boardConfig.layoutId,
    boardConfig.sizeId,
    boardConfig.setIds,
    boardConfig.angle,
    climbUuid,
  ].join(':');
}

function boardConfigActionSignature(boardConfig: BoardConfig | null): string {
  if (!boardConfig) return 'none';
  return [boardConfig.boardName, boardConfig.layoutId, boardConfig.sizeId, boardConfig.setIds, boardConfig.angle].join(
    ':',
  );
}

function actionContextForPresenceClimb(
  boardConfig: BoardConfig | null,
  presenceClimb: BoardPresenceClimb,
): BoardSheetActionContext | null {
  if (!boardConfig) return null;
  const actionBoardConfig = actionBoardConfigForPresenceClimb(boardConfig, presenceClimb);
  return {
    actionBoardConfig,
    cacheKey: actionCacheKey(actionBoardConfig, presenceClimb.climbUuid),
  };
}

function getActionClimbCacheEntry(cache: Map<string, Climb>, key: string): Climb | null {
  const cachedClimb = cache.get(key);
  if (!cachedClimb) return null;
  cache.delete(key);
  cache.set(key, cachedClimb);
  return cachedClimb;
}

function setActionClimbCacheEntry(cache: Map<string, Climb>, key: string, climb: Climb): void {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, climb);
  if (cache.size <= ACTION_CLIMB_CACHE_LIMIT) return;
  const oldestKey = cache.keys().next().value;
  if (oldestKey !== undefined) cache.delete(oldestKey);
}

export type NowOnTheWallPanelProps = {
  /**
   * 'sheet' renders inside the native modal (BottomSheetFlatList); 'column'
   * renders inline (plain FlatList) and owns both safe-area insets.
   */
  variant: 'sheet' | 'column';
  /** The active board label, shown as the panel title. */
  boardLabel: string | null;
  /**
   * Active board config for the climb thumbnails. Passed by the host (NOT read
   * via `useDrawerHost`) so this panel stays out of the drawer-host require cycle
   * and doesn't subscribe to that volatile context.
   */
  boardConfig: BoardConfig | null;
  /** Local orientation for a climb with one unambiguous queue occurrence. */
  getClimbMirror?: (climbUuid: string) => boolean | undefined;
  /** Sheet only: when set, the header renders a close chevron that calls this. */
  onClose?: () => void;
  /**
   * Sheet only: dismiss and resolve once the dismiss has settled. Routes pushed
   * from inside the sheet (the live-session join preview) wait on this so a
   * native modal never starts presenting while the sheet is still leaving.
   */
  dismissAndWait?: () => Promise<DismissAndWaitResult>;
  /** Open the existing board switcher from the inline column's footer. */
  onSwitchBoard: () => void;
  /**
   * The board the climber is on. Sheet variant only: it is what names the gym
   * whose other boards the switcher lists.
   */
  activeBoard?: UserBoard | null;
  onOpenSprayMaintenance?: (wallUuid: string, action: SprayDetailRowKey) => void;
  onShareSprayWall?: (wallUuid: string) => void;
  /** The signed-in climber's id. A spray wall's reset rows are its owner's alone. */
  viewerUserId?: string | null;
  /**
   * Hop to another board at the same gym. Sheet variant only — the same panel
   * renders the iPad wall kiosk, and a board switcher on a display mounted to a
   * wall lets a passer-by repoint the gym's screen with no way back.
   */
  onSelectGymWall?: (board: UserBoard) => void;
  /** Activate/open a climb from the wall feed. The panel closes itself after this (sheet). */
  onClimbPress?: (action: BoardSheetClimbAction) => void;
  /** Swipe action: play this wall-feed climb next. */
  onPlayNext?: (action: BoardSheetClimbAction) => void;
  /** Swipe action: open the add-to-playlist sheet for this climb. */
  onOpenPlaylist?: (action: BoardSheetClimbAction) => void;
  /** Long press action: open the existing climb actions sheet. */
  onOpenActions?: (action: BoardSheetClimbAction) => ClimbActionsTarget | null | undefined;
};

function NowOnTheWallPanelComponent(
  {
    variant,
    boardLabel,
    boardConfig,
    getClimbMirror,
    onClose,
    dismissAndWait,
    onSwitchBoard,
    activeBoard,
    onOpenSprayMaintenance,
    onShareSprayWall,
    viewerUserId,
    onSelectGymWall,
    onClimbPress,
    onPlayNext,
    onOpenPlaylist,
    onOpenActions,
  }: NowOnTheWallPanelProps,
  ref: Ref<NowOnTheWallPanelHandle>,
) {
  const { t } = useTranslation('session');
  // Same cached roster the switcher above reads — a second subscriber, not a
  // second request. Null for the column variant so the iPad kiosk never fetches
  // a list it is not allowed to show.
  const { data: gymBoardsForFooter } = useGymBoards(
    variant === 'sheet' && onSelectGymWall ? (activeBoard?.gymUuid ?? null) : null,
  );
  const hasGymSiblings = (gymBoardsForFooter ?? []).some((board) => board.uuid !== activeBoard?.uuid);
  // The gym's other boards are a disclosure, not a permanent block. Measured on
  // an iPhone 17 Pro, the always-on list was 226-250pt of the ~305pt a climber
  // can actually see at the first detent — so the sheet opened on a board
  // switcher instead of on the wall feed it exists for. Collapsed on every
  // presentation; the header title is what opens it.
  const [gymWallsExpanded, setGymWallsExpanded] = useState(false);
  const canSwitchGymWall = variant === 'sheet' && onSelectGymWall != null && hasGymSiblings;
  const toggleGymWalls = useCallback(() => setGymWallsExpanded((open) => !open), []);
  const insets = useSafeAreaInsets();
  const windowBottomInset = useWindowBottomInset();
  const { systemColors, brandColors } = useTheme();
  const { showToast } = useToast();
  // `formatGrade` still renders the board-wide aggregate grade tiles (hardest / top
  // grade), which aren't a single climb's grade; `resolveGrade` swaps the per-climb
  // grades (hero, history rows, hardest send) to the Boardsesh grade when the toggle
  // is on. BoardPresenceClimb / BoardPresenceHardestSend carry no Boardsesh grade
  // today, so those fall back to the legacy grade until the backend stamps them.
  const { formatGrade } = useGradeFormat();
  const { resolveGrade } = useDisplayGrade();
  const climbMirrorReaderRef = useRef(getClimbMirror);
  climbMirrorReaderRef.current = getClimbMirror;
  const boardConfigRef = useRef(boardConfig);
  boardConfigRef.current = boardConfig;
  const { boardId: boardPresenceBoardId, boardUuid: boardPresenceBoardUuid } = useBoardPresenceControls();
  const boardConfigSignature = useMemo(
    () =>
      `${boardPresenceBoardId ?? 'none'}:${boardPresenceBoardUuid ?? ''}:${boardConfigActionSignature(boardConfig)}`,
    [boardConfig, boardPresenceBoardId, boardPresenceBoardUuid],
  );
  const boardConfigSignatureRef = useRef(boardConfigSignature);
  boardConfigSignatureRef.current = boardConfigSignature;

  const { currentClimb, holder } = useBoardPresenceCurrent();
  // Whoever is connected to the board now, not whoever lit the last climb: that
  // climber may have left an hour ago.
  const holderName = holder?.displayName?.trim() || null;
  const holderUserId = holder?.userId ?? null;
  const { history, stats } = useBoardPresenceFeed();
  const { refresh } = useBoardPresenceActions();
  const [isRefreshing, setIsRefreshing] = useState(false);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const durableRefreshRef = useRef<(() => void) | undefined>(undefined);
  const handleRefresh = useCallback(() => {
    refresh('manual');
    durableRefreshRef.current?.();
    setIsRefreshing(true);
    if (refreshTimerRef.current) {
      clearTimeout(refreshTimerRef.current);
    }
    refreshTimerRef.current = setTimeout(() => setIsRefreshing(false), 800);
  }, [refresh]);
  useEffect(
    () => () => {
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
      }
    },
    [],
  );

  const visibleHistory = useMemo(
    () =>
      currentClimb
        ? history.filter((historyClimb) => {
            return historyClimb.climbUuid !== currentClimb.climbUuid || historyClimb.seq !== currentClimb.seq;
          })
        : history,
    [currentClimb, history],
  );

  // "Load older" — pages further back through the durable history log, past
  // the live feed's in-memory HISTORY_CAP window.
  const handleHistoryPageLoaded = useCallback(
    (info: { pageSize: number; returnedCount: number }) => {
      track(SHARED_EVENTS.BoardHistoryPageLoaded, {
        boardId: boardPresenceBoardId ?? undefined,
        pageSize: info.pageSize,
        returnedCount: info.returnedCount,
      });
    },
    [boardPresenceBoardId],
  );
  const { olderHistory, isLoadingOlder, hasMore, loadOlder, refreshHistory, loadError } = useBoardHistoryPagination(
    undefined,
    handleHistoryPageLoaded,
  );
  durableRefreshRef.current = refreshHistory;
  // Keep richer live entries and hide the current climb's durable copy.
  // Imported arrival sequences do not determine display chronology.
  const combinedHistory = useMemo(() => {
    if (olderHistory.length === 0) return visibleHistory;
    const liveKeys = new Set(history.map(boardHistoryEntryKey));
    const dedupedOlder = olderHistory.filter((climb) => !liveKeys.has(boardHistoryEntryKey(climb)));
    return mergeBoardHistory(visibleHistory, dedupedOlder);
  }, [visibleHistory, history, olderHistory]);

  // FlatList fires onEndReached immediately when the content is shorter than
  // the viewport, so without this gate every presentation of a quiet wall
  // would drain durable pages after the automatic first page.
  // Require a real user scroll before loading another page.
  const hasUserScrolledRef = useRef(false);
  const handleScrollBeginDrag = useCallback(() => {
    hasUserScrolledRef.current = true;
  }, []);
  const handleEndReached = useCallback(() => {
    if (!hasUserScrolledRef.current) return;
    loadOlder();
  }, [loadOlder]);

  const actionClimbCacheRef = useRef(new Map<string, Climb>());
  const [menuClimbCache, setMenuClimbCache] = useState<ReadonlyMap<string, Climb>>(() => new Map());
  const [visibleMenuSelection, setVisibleMenuSelection] = useState<{
    boardSignature: string;
    historyKeys: string[];
  } | null>(null);
  const actionClimbRequestRef = useRef(new Map<string, Promise<Climb | null>>());
  const pendingActionKeysRef = useRef(new Set<string>());
  const actionGenerationRef = useRef(0);
  const [pendingActionKeys, setPendingActionKeys] = useState<ReadonlySet<string>>(() => new Set());

  const rowBoard = useMemo<BoardSheetRowBoard | null>(
    () => (boardConfig ? rowBoardForBoardConfig(boardConfig) : null),
    [boardConfig],
  );
  const canUseInteractiveRows = !!rowBoard && (!!onClimbPress || !!onPlayNext || !!onOpenPlaylist || !!onOpenActions);

  const getActionContext = useCallback((presenceClimb: BoardPresenceClimb) => {
    return actionContextForPresenceClimb(boardConfigRef.current, presenceClimb);
  }, []);

  const isActionLoading = useCallback(
    (presenceClimb: BoardPresenceClimb) => {
      const actionContext = getActionContext(presenceClimb);
      return actionContext ? pendingActionKeys.has(actionContext.cacheKey) : false;
    },
    [getActionContext, pendingActionKeys],
  );

  const setActionLoading = useCallback((cacheKey: string, loading: boolean) => {
    const pendingKeys = pendingActionKeysRef.current;
    if (loading) {
      if (pendingKeys.has(cacheKey)) return;
      pendingKeys.add(cacheKey);
    } else if (!pendingKeys.delete(cacheKey)) {
      return;
    }
    setPendingActionKeys(new Set(pendingKeys));
  }, []);

  const clearPendingActionKeys = useCallback(() => {
    const pendingKeys = pendingActionKeysRef.current;
    if (pendingKeys.size === 0) return;
    pendingKeys.clear();
    setPendingActionKeys(new Set());
  }, []);

  const invalidatePendingActions = useCallback(() => {
    actionGenerationRef.current += 1;
    clearPendingActionKeys();
  }, [clearPendingActionKeys]);

  useImperativeHandle(ref, () => ({ invalidatePendingActions }), [invalidatePendingActions]);

  useEffect(() => {
    invalidatePendingActions();
  }, [boardConfigSignature, invalidatePendingActions]);

  const notifyActionFailed = useCallback(() => {
    showToast(t('mobile.boardPresence.actionFailed'), 'error');
  }, [showToast, t]);

  const resolveAction = useCallback(
    async (
      presenceClimb: BoardPresenceClimb,
      actionContext: BoardSheetActionContext,
    ): Promise<BoardSheetClimbAction | null> => {
      const { actionBoardConfig, cacheKey } = actionContext;
      const cachedClimb = getActionClimbCacheEntry(actionClimbCacheRef.current, cacheKey);
      if (cachedClimb) {
        return {
          climb: withAuroraActionOrientation(cachedClimb, presenceClimb, climbMirrorReaderRef.current),
          queueItemUuid: presenceClimb.queueItemUuid ?? null,
          boardConfig: actionBoardConfig,
        };
      }

      let climbRequest = actionClimbRequestRef.current.get(cacheKey);
      if (!climbRequest) {
        climbRequest = offlineAwareRequest<GetClimbQueryResponse>(GET_CLIMB, {
          boardName: actionBoardConfig.boardName,
          layoutId: actionBoardConfig.layoutId,
          sizeId: actionBoardConfig.sizeId,
          setIds: actionBoardConfig.setIds,
          angle: actionBoardConfig.angle,
          climbUuid: presenceClimb.climbUuid,
        })
          .then((response): Climb | null => {
            if (!response.climb) {
              console.warn('Board-sheet climb action returned no climb', presenceClimb.climbUuid);
              return null;
            }
            setActionClimbCacheEntry(actionClimbCacheRef.current, cacheKey, response.climb);
            setMenuClimbCache(new Map(actionClimbCacheRef.current));
            return response.climb;
          })
          .catch((error: unknown): null => {
            console.warn('Failed to load board-sheet climb action', error);
            return null;
          })
          .finally(() => {
            actionClimbRequestRef.current.delete(cacheKey);
          });
        actionClimbRequestRef.current.set(cacheKey, climbRequest);
      }

      const loadedClimb = await climbRequest;
      if (!loadedClimb) return null;
      return {
        climb: withAuroraActionOrientation(loadedClimb, presenceClimb, climbMirrorReaderRef.current),
        queueItemUuid: presenceClimb.queueItemUuid ?? null,
        boardConfig: actionBoardConfig,
      };
    },
    [],
  );

  const handleMenuViewableItemsChanged = useCallback(({ viewableItems }: HistoryViewabilityChange) => {
    const historyKeys = viewableItems
      .filter((entry) => entry.isViewable)
      .slice(0, AURORA_VISIBLE_HISTORY_LIMIT)
      .map((entry) => boardHistoryEntryKey(entry.item));
    const boardSignature = boardConfigSignatureRef.current;
    setVisibleMenuSelection((previous) =>
      previous?.boardSignature === boardSignature &&
      previous.historyKeys.length === historyKeys.length &&
      previous.historyKeys.every((historyKey, index) => historyKey === historyKeys[index])
        ? previous
        : { boardSignature, historyKeys },
    );
  }, []);
  const presentationClimbs = useMemo(() => {
    const historyByKey = new Map(combinedHistory.map((climb) => [boardHistoryEntryKey(climb), climb]));
    const historyClimbs =
      visibleMenuSelection?.boardSignature === boardConfigSignature
        ? visibleMenuSelection.historyKeys.flatMap((historyKey) => {
            const climb = historyByKey.get(historyKey);
            return climb ? [climb] : [];
          })
        : combinedHistory.slice(0, MENU_METADATA_HISTORY_LIMIT);
    return currentClimb ? [currentClimb, ...historyClimbs] : historyClimbs;
  }, [boardConfigSignature, combinedHistory, currentClimb, visibleMenuSelection]);
  const menuMetadataClimbs = useMemo(
    () => presentationClimbs.slice(0, MENU_METADATA_HISTORY_LIMIT + 1),
    [presentationClimbs],
  );
  const auroraGrades = useAuroraPresenceGrades(presentationClimbs, boardConfig, {
    boardId: boardPresenceBoardId,
    boardUuid: boardPresenceBoardUuid,
  });

  useEffect(() => {
    if (!onOpenActions) return;
    let cancelled = false;
    const metadataGeneration = actionGenerationRef.current;
    const missing = menuMetadataClimbs.flatMap((climb) => {
      const context = getActionContext(climb);
      return context && !actionClimbCacheRef.current.has(context.cacheKey) ? [{ climb, context }] : [];
    });
    // At most the hero and eight visible/initial history rows, three requests
    // at a time. No history pagination, render-time requests or automatic retry:
    // a row whose load failed keeps its snapshot menu, and a selection on it
    // fetches the climb on demand.
    void (async () => {
      for (let offset = 0; offset < missing.length; offset += MENU_METADATA_CONCURRENCY) {
        if (cancelled || metadataGeneration !== actionGenerationRef.current) return;
        await Promise.all(
          missing
            .slice(offset, offset + MENU_METADATA_CONCURRENCY)
            .map(({ climb, context }) => resolveAction(climb, context)),
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [getActionContext, menuMetadataClimbs, onOpenActions, resolveAction]);

  const runInteractiveAction = useCallback(
    (presenceClimb: BoardPresenceClimb, callback: (action: BoardSheetClimbAction) => void, closeOnSuccess = false) => {
      const actionContext = getActionContext(presenceClimb);
      if (!actionContext) {
        notifyActionFailed();
        return;
      }

      if (pendingActionKeysRef.current.has(actionContext.cacheKey)) return;

      const actionGeneration = actionGenerationRef.current;
      const actionBoardSignature = boardConfigSignatureRef.current;
      setActionLoading(actionContext.cacheKey, true);
      void resolveAction(presenceClimb, actionContext)
        .then((action) => {
          if (
            actionGeneration !== actionGenerationRef.current ||
            actionBoardSignature !== boardConfigSignatureRef.current
          ) {
            return;
          }
          if (!action) {
            notifyActionFailed();
            return;
          }
          try {
            callback(action);
            if (closeOnSuccess && onClose) {
              invalidatePendingActions();
              onClose();
            }
          } catch (error) {
            console.warn('Failed to run board-sheet climb action', error);
            notifyActionFailed();
          }
        })
        .finally(() => {
          setActionLoading(actionContext.cacheKey, false);
        });
    },
    [getActionContext, invalidatePendingActions, notifyActionFailed, onClose, resolveAction, setActionLoading],
  );

  // The wall's climb, then its history: what a row tap plays from (#6665).
  // Read through a ref at the tap, so a history page landing doesn't rebuild
  // every row's handler. Rows with no frames have nothing to draw and stay out.
  const wallTrackClimbs = useMemo(() => {
    const climbs: Array<{ climb: QueueClimb; occurrence: BoardPresenceClimb }> = [];
    const seenClimbUuids = new Set<string>();
    for (const presenceClimb of currentClimb ? [currentClimb, ...combinedHistory] : combinedHistory) {
      if (!presenceClimb.frames || seenClimbUuids.has(presenceClimb.climbUuid)) continue;
      seenClimbUuids.add(presenceClimb.climbUuid);
      climbs.push({
        climb: boardPresenceClimbToClimb(presenceClimb, boardConfig?.angle),
        occurrence: presenceClimb,
      });
    }
    return climbs;
  }, [currentClimb, combinedHistory, boardConfig?.angle]);
  const wallTrackClimbsRef = useRef(wallTrackClimbs);
  wallTrackClimbsRef.current = wallTrackClimbs;
  const currentClimbRef = useRef(currentClimb);
  currentClimbRef.current = currentClimb;
  const wallTrackLabel = t('playView.track.wallHistory');

  const handleInteractiveClimbPress = useCallback(
    (presenceClimb: BoardPresenceClimb) => {
      if (!onClimbPress) return;
      runInteractiveAction(
        presenceClimb,
        (action) => {
          // Read after the climb resolves, with the track: a crewmate can move
          // the wall while it loads.
          const wallClimb = currentClimbRef.current;
          const isWallClimb =
            wallClimb != null && wallClimb.climbUuid === presenceClimb.climbUuid && wallClimb.seq === presenceClimb.seq;
          const panelBoard = boardConfigRef.current;
          const track = panelBoard
            ? createPlaylistSuggestionSource({
                playlistUuid: `wall-history:${boardConfigSignatureRef.current}`,
                activatedClimb: toQueueClimb(action.climb),
                climbs: wallTrackClimbsRef.current.map(({ climb, occurrence }) =>
                  withAuroraActionOrientation(climb, occurrence, climbMirrorReaderRef.current),
                ),
                boardKey: getQueueBoardKey({
                  board_name: panelBoard.boardName,
                  layout_id: panelBoard.layoutId,
                  size_id: panelBoard.sizeId,
                  set_ids: panelBoard.setIds,
                }),
                label: wallTrackLabel,
              })
            : null;
          onClimbPress({ ...action, track, isWallClimb });
        },
        true,
      );
    },
    [onClimbPress, runInteractiveAction, wallTrackLabel],
  );

  const handleInteractivePlayNext = useCallback(
    (presenceClimb: BoardPresenceClimb) => {
      if (!onPlayNext) return;
      runInteractiveAction(presenceClimb, onPlayNext);
    },
    [onPlayNext, runInteractiveAction],
  );

  const handleInteractiveOpenPlaylist = useCallback(
    (presenceClimb: BoardPresenceClimb) => {
      if (!onOpenPlaylist) return;
      runInteractiveAction(presenceClimb, onOpenPlaylist);
    },
    [onOpenPlaylist, runInteractiveAction],
  );

  // The full climb a row's menu can read, once the panel has loaded it. Rows get
  // it as a prop, so a load re-renders only the row it belongs to.
  const loadedMenuClimb = useCallback(
    (presenceClimb: BoardPresenceClimb): Climb | undefined => {
      const actionContext = getActionContext(presenceClimb);
      return actionContext ? menuClimbCache.get(actionContext.cacheKey) : undefined;
    },
    [getActionContext, menuClimbCache],
  );

  const handleInteractiveOpenActions = useCallback(
    (presenceClimb: BoardPresenceClimb, loadedClimb?: Climb) => {
      if (!onOpenActions) return null;
      const actionContext = getActionContext(presenceClimb);
      if (!actionContext) return null;
      // Who set the climb (Edit, Delete, Report) needs the full climb, which the
      // panel loads for the hero and the visible rows. Until it lands, or when
      // that load failed, the menu reads the wall's own snapshot of the climb,
      // so a hold always has a menu. Either way a selection fetches the full
      // climb first and runs only a row its menu offers too (ClimbMenusProvider).
      const target = onOpenActions({
        climb: withAuroraActionOrientation(
          loadedClimb ?? boardPresenceClimbToClimb(presenceClimb, actionContext.actionBoardConfig.angle),
          presenceClimb,
          climbMirrorReaderRef.current,
        ),
        boardConfig: actionContext.actionBoardConfig,
        queueItemUuid: presenceClimb.queueItemUuid ?? null,
      });
      if (!target) return null;
      // The board is stamped when the row builds its menu, during render; the
      // generation only once an action is picked. The panel bumps the generation
      // on mount, after the first render's menus exist, so stamping it here
      // would leave those menus doing nothing. A board switch rebuilds every
      // row's menu (boardConfigSignature is a dep).
      const actionBoardSignature = boardConfigSignature;
      return {
        ...target,
        resolveClimb: async () => {
          if (actionBoardSignature !== boardConfigSignatureRef.current) return null;
          const actionGeneration = actionGenerationRef.current;
          const action = await resolveAction(presenceClimb, actionContext);
          if (
            actionGeneration !== actionGenerationRef.current ||
            actionBoardSignature !== boardConfigSignatureRef.current
          ) {
            return null;
          }
          if (!action) notifyActionFailed();
          return action?.climb ?? null;
        },
      };
    },
    [boardConfigSignature, getActionContext, notifyActionFailed, onOpenActions, resolveAction],
  );

  const handleClose = useCallback(() => {
    invalidatePendingActions();
    onClose?.();
  }, [invalidatePendingActions, onClose]);

  // True once the sheet is gone and a route may be pushed; false when the
  // handoff was aborted (the sheet's owner went away mid-dismiss).
  const leaveSheet = useCallback(async (): Promise<boolean> => {
    invalidatePendingActions();
    if (!dismissAndWait) {
      onClose?.();
      return true;
    }
    const result = await dismissAndWait();
    return result.status === 'dismissed';
  }, [invalidatePendingActions, dismissAndWait, onClose]);

  // A ref, not a dep: a list `.length` in a callback's deps rebuilds it on every
  // page of history (docs/mobile/react-native-performance.md).
  const historyCountRef = useRef(combinedHistory.length);
  historyCountRef.current = combinedHistory.length;

  // Tracks before any other work, so it means "the tap reached JS" and nothing
  // more — see the SHARED_EVENTS.BoardSwapTapped note for what the pairing buys.
  const handleSwitchBoard = useCallback(() => {
    track(SHARED_EVENTS.BoardSwapTapped, {
      boardId: boardPresenceBoardId ?? undefined,
      historyCount: historyCountRef.current,
    });
    invalidatePendingActions();
    onSwitchBoard();
  }, [boardPresenceBoardId, invalidatePendingActions, onSwitchBoard]);

  const renderHistoryItem = useCallback(
    ({ item }: { item: BoardPresenceClimb }) => {
      const gradeFields = item.source === 'aurora' ? auroraGrades.get(item.climbUuid) : undefined;
      const resolvedGrade = resolveGrade(gradeFields ?? { difficulty: item.grade ?? '' }, boardConfig?.boardName);
      const formattedGrade =
        gradeFields?.difficulty || gradeFields?.boardseshDifficulty != null || item.grade ? resolvedGrade.label : null;
      const gradeColor = resolvedGrade.color;

      if (canUseInteractiveRows && rowBoard) {
        return (
          <InteractiveHistoryRow
            climb={item}
            rowBoard={rowBoard}
            boardConfig={boardConfig}
            labelColor={systemColors.label}
            secondaryColor={systemColors.secondaryLabel}
            formattedGrade={formattedGrade}
            gradeColor={gradeColor}
            isActionLoading={isActionLoading(item)}
            onPress={onClimbPress ? handleInteractiveClimbPress : undefined}
            onPlayNext={handleInteractivePlayNext}
            onOpenPlaylist={handleInteractiveOpenPlaylist}
            onOpenActions={handleInteractiveOpenActions}
            menuClimb={loadedMenuClimb(item)}
          />
        );
      }

      return (
        <HistoryRow
          climb={item}
          boardConfig={boardConfig}
          labelColor={systemColors.label}
          secondaryColor={systemColors.secondaryLabel}
          formattedGrade={formattedGrade}
          gradeColor={gradeColor}
        />
      );
    },
    [
      boardConfig,
      auroraGrades,
      canUseInteractiveRows,
      rowBoard,
      systemColors.label,
      systemColors.secondaryLabel,
      resolveGrade,
      handleInteractiveClimbPress,
      handleInteractivePlayNext,
      handleInteractiveOpenPlaylist,
      handleInteractiveOpenActions,
      loadedMenuClimb,
      isActionLoading,
      onClimbPress,
    ],
  );

  // Primitive derived from `pendingActionKeys` for just the hero's own climb —
  // NOT the `isActionLoading` function itself, which changes identity on every
  // row's action-state flip. Keeping `listHeader` keyed on this boolean instead
  // means an unrelated history-row tap no longer rebuilds the whole header
  // (hero + stat tiles + hardest-send row).
  const heroActionLoading =
    currentClimb && boardConfig
      ? pendingActionKeys.has(
          actionCacheKey(actionBoardConfigForPresenceClimb(boardConfig, currentClimb), currentClimb.climbUuid),
        )
      : false;

  const heroMenuClimb = currentClimb ? loadedMenuClimb(currentClimb) : undefined;

  const listHeader = useMemo(() => {
    // Per-climb grades under the "Show Boardsesh grades" toggle. resolveGrade with
    // an empty difficulty yields the default colour + empty label, so these are
    // safe to compute even when there's no current climb / hardest send.
    const wallBoardName = boardConfig?.boardName;
    const heroGradeFields = currentClimb?.source === 'aurora' ? auroraGrades.get(currentClimb.climbUuid) : undefined;
    const heroGrade = resolveGrade(heroGradeFields ?? { difficulty: currentClimb?.grade ?? '' }, wallBoardName);
    const heroHasGrade = Boolean(
      heroGradeFields?.difficulty || heroGradeFields?.boardseshDifficulty != null || currentClimb?.grade,
    );
    const hardestSendGrade = resolveGrade({ difficulty: stats?.hardestSend?.grade ?? '' }, wallBoardName);
    return (
      <View testID={activeBoard ? `board-panel-${activeBoard.uuid}` : undefined}>
        {/* First in the header, above the hero: the disclosure opens directly
            under the title that opened it. */}
        {canSwitchGymWall && gymWallsExpanded && onSelectGymWall ? (
          <GymWallSwitcher activeBoard={activeBoard ?? null} onSelectBoard={onSelectGymWall} />
        ) : null}
        {variant === 'sheet' ? (
          <SprayWallActions
            board={activeBoard ?? null}
            onOpenMaintenance={onOpenSprayMaintenance}
            onShare={onShareSprayWall}
            viewerUserId={viewerUserId}
          />
        ) : null}
        {/* Layout observation: the board sheet only, never the
            iPad kiosk column or the Wall display, so one panel reports each name. */}
        <ShowcaseAnchorView name="now-on-wall" enabled={variant === 'sheet'}>
          {canUseInteractiveRows && rowBoard && currentClimb ? (
            <InteractiveHeroRow
              climb={currentClimb}
              rowBoard={rowBoard}
              boardConfig={boardConfig}
              labelColor={systemColors.label}
              secondaryColor={systemColors.secondaryLabel}
              accentColor={brandColors.warning}
              surfaceColor={systemColors.secondaryBackground}
              formattedGrade={heroHasGrade ? heroGrade.label : null}
              gradeColor={heroGrade.color}
              isActionLoading={heroActionLoading}
              onPress={onClimbPress ? handleInteractiveClimbPress : undefined}
              onPlayNext={handleInteractivePlayNext}
              onOpenPlaylist={handleInteractiveOpenPlaylist}
              onOpenActions={handleInteractiveOpenActions}
              menuClimb={heroMenuClimb}
            />
          ) : (
            <NowOnTheWallHero
              climb={currentClimb}
              boardConfig={boardConfig}
              labelColor={systemColors.label}
              secondaryColor={systemColors.secondaryLabel}
              accentColor={brandColors.warning}
              surfaceColor={systemColors.secondaryBackground}
              formattedGrade={heroHasGrade ? heroGrade.label : null}
              gradeColor={heroGrade.color}
            />
          )}
        </ShowcaseAnchorView>
        {/* Sheet only, and only on a tablet (the entry decides): the full-screen
            Wall display for a tablet mounted at the board. */}
        {variant === 'sheet' ? <WallDisplayEntry onBeforeNavigate={leaveSheet} /> : null}
        {/* Sheet only: the column variant is also the wall-mounted iPad kiosk,
            where a passer-by's "Join" or "Start" would act on the kiosk's
            account. */}
        {variant === 'sheet' ? (
          <BoardLiveSessionsBlock
            boardId={boardPresenceBoardId}
            boardUuid={boardPresenceBoardUuid}
            holderName={holderName}
            holderUserId={holderUserId}
            onBeforeNavigate={leaveSheet}
          />
        ) : null}
        {stats ? (
          // testID anchors the store-screenshot flow: the stats only exist once the
          // wall history has landed, and this block is on screen at the top of the
          // sheet (the history rows below are virtualized and off-screen).
          <View testID="board-sheet-stats" style={styles.statsBlock}>
            <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.sectionHeader}>
              {t('mobile.boardPresence.statsHeader')}
            </Text>
            <View style={styles.statTiles}>
              <StatTile
                value={String(stats.climbsSentCount)}
                label={t('mobile.boardPresence.statSent', { count: stats.climbsSentCount })}
                surfaceColor={systemColors.secondaryBackground}
                labelColor={systemColors.secondaryLabel}
                valueColor={systemColors.label}
              />
              <StatTile
                value={String(stats.distinctClimbersCount)}
                label={t('mobile.boardPresence.statClimbers', { count: stats.distinctClimbersCount })}
                surfaceColor={systemColors.secondaryBackground}
                labelColor={systemColors.secondaryLabel}
                valueColor={systemColors.label}
              />
              <StatTile
                value={stats.hardestGrade ? (formatGrade(stats.hardestGrade, wallBoardName) ?? '–') : '–'}
                label={t('mobile.boardPresence.statHardest')}
                surfaceColor={systemColors.secondaryBackground}
                labelColor={systemColors.secondaryLabel}
                valueColor={systemColors.label}
              />
              <StatTile
                value={stats.topGrade ? (formatGrade(stats.topGrade, wallBoardName) ?? '–') : '–'}
                label={t('mobile.boardPresence.statTopGrade')}
                surfaceColor={systemColors.secondaryBackground}
                labelColor={systemColors.secondaryLabel}
                valueColor={systemColors.label}
              />
            </View>
            {stats.hardestSend ? (
              <HardestSendRow
                hardestSend={stats.hardestSend}
                labelColor={systemColors.label}
                secondaryColor={systemColors.secondaryLabel}
                surfaceColor={systemColors.secondaryBackground}
                crownColor={brandColors.warning}
                formattedGrade={hardestSendGrade.label}
                gradeColor={hardestSendGrade.color}
              />
            ) : null}
          </View>
        ) : null}
        {combinedHistory.length > 0 ? (
          <ShowcaseAnchorView name="wall-history" enabled={variant === 'sheet'}>
            <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.sectionHeader}>
              {t('mobile.boardPresence.historyHeader')}
              {' · '}
              {t('mobile.boardPresence.historyWindow')}
            </Text>
          </ShowcaseAnchorView>
        ) : null}
      </View>
    );
  }, [
    currentClimb,
    boardConfig,
    auroraGrades,
    stats,
    combinedHistory.length,
    systemColors,
    brandColors.warning,
    formatGrade,
    resolveGrade,
    t,
    canUseInteractiveRows,
    rowBoard,
    handleInteractiveClimbPress,
    handleInteractivePlayNext,
    handleInteractiveOpenPlaylist,
    handleInteractiveOpenActions,
    heroMenuClimb,
    heroActionLoading,
    onClimbPress,
    variant,
    activeBoard,
    onOpenSprayMaintenance,
    onShareSprayWall,
    viewerUserId,
    onSelectGymWall,
    canSwitchGymWall,
    gymWallsExpanded,
    boardPresenceBoardId,
    boardPresenceBoardUuid,
    holderName,
    holderUserId,
    leaveSheet,
  ]);

  const listEmpty = useMemo(
    () => (
      <View>
        <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.sectionHeader}>
          {t('mobile.boardPresence.historyWindow')}
        </Text>
        {currentClimb ? null : (
          <View style={styles.empty}>
            {/* secondaryLabel, not tertiary: on a glass sheet this sits over the
                blurred climb list, and tertiary is under the contrast floor. */}
            <Icon name="lightbulb" size={36} color={systemColors.secondaryLabel} />
            <Text variant="headline" color={systemColors.label} style={styles.emptyTitle}>
              {t('mobile.boardPresence.emptyTitle')}
            </Text>
            <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.emptyBody}>
              {t('mobile.boardPresence.emptyBody')}
            </Text>
          </View>
        )}
      </View>
    ),
    [currentClimb, systemColors, t],
  );

  const listFooter = useMemo(
    () =>
      isLoadingOlder ? (
        <View style={styles.historyFooter}>
          <ActivityIndicator size="small" accessibilityLabel={t('mobile.boardPresence.loadingMore')} />
        </View>
      ) : hasMore ? (
        <PressableSurface
          onPress={loadOlder}
          accessibilityRole="button"
          accessibilityLabel={loadError ? t('mobile.boardPresence.retryHistory') : t('mobile.boardPresence.loadMore')}
          style={styles.historyFooter}
        >
          <Text variant="subheadline" color={systemColors.accent}>
            {loadError ? t('mobile.boardPresence.retryHistory') : t('mobile.boardPresence.loadMore')}
          </Text>
        </PressableSurface>
      ) : null,
    [isLoadingOlder, t, hasMore, loadOlder, loadError, brandColors.primary],
  );

  const listContentContainerStyle = useMemo(
    () => ({ paddingBottom: spacing[4] + (variant === 'sheet' ? windowBottomInset : 0) }),
    [variant, windowBottomInset],
  );

  // In sheet mode the native drag handle supplies the top spacing, so the header
  // needs none; the inline column and full-screen tab render with no chrome and
  // own the top inset themselves. The sheet list clears the window's bottom inset
  // now that its switch-board footer lives in the Climbs options menu.
  const headerTopPadding = variant === 'sheet' ? 0 : insets.top + spacing[2];
  // The inline column keeps its switch-board action and its own surface inset.
  const footerBottomPadding = insets.bottom + spacing[3];

  const refreshControl = (
    <RefreshControl refreshing={isRefreshing} onRefresh={handleRefresh} tintColor={systemColors.secondaryLabel} />
  );

  return (
    <NowOnTheWallPanelView
      variant={variant}
      boardLabel={boardLabel}
      headerTopPadding={headerTopPadding}
      footerBottomPadding={footerBottomPadding}
      onClose={onClose ? handleClose : undefined}
      canSwitchGymWall={canSwitchGymWall}
      gymWallsExpanded={gymWallsExpanded}
      onToggleGymWalls={toggleGymWalls}
      onSwitchBoard={handleSwitchBoard}
      list={
        variant === 'sheet' ? (
          <BottomSheetFlatList
            data={combinedHistory}
            keyExtractor={boardHistoryEntryKey}
            renderItem={renderHistoryItem}
            ListHeaderComponent={listHeader ?? undefined}
            ListEmptyComponent={listEmpty ?? undefined}
            ListFooterComponent={listFooter ?? undefined}
            // `loadOlder` already no-ops once `hasMore` is false, but skipping the
            // prop entirely once there's nothing left avoids FlatList re-evaluating
            // the end-reached threshold on every scroll frame for no reason. The
            // handler itself is additionally gated on a real user scroll — see
            // `hasUserScrolledRef` above.
            onEndReached={hasMore ? handleEndReached : undefined}
            onEndReachedThreshold={0.6}
            onScrollBeginDrag={handleScrollBeginDrag}
            onViewableItemsChanged={handleMenuViewableItemsChanged}
            viewabilityConfig={MENU_VIEWABILITY_CONFIG}
            contentContainerStyle={listContentContainerStyle}
            refreshControl={refreshControl}
          />
        ) : (
          <FlatList
            data={combinedHistory}
            keyExtractor={boardHistoryEntryKey}
            renderItem={renderHistoryItem}
            ListHeaderComponent={listHeader ?? undefined}
            ListEmptyComponent={listEmpty ?? undefined}
            ListFooterComponent={listFooter ?? undefined}
            onEndReached={hasMore ? handleEndReached : undefined}
            onEndReachedThreshold={0.6}
            onScrollBeginDrag={handleScrollBeginDrag}
            onViewableItemsChanged={handleMenuViewableItemsChanged}
            viewabilityConfig={MENU_VIEWABILITY_CONFIG}
            // Fill the bounded height between the header and the switch-board footer
            // (the inline column and the full-screen tab both render in a flex parent).
            style={styles.fillList}
            contentContainerStyle={listContentContainerStyle}
            refreshControl={refreshControl}
          />
        )
      }
    />
  );
}

export const NowOnTheWallPanel = memo(forwardRef(NowOnTheWallPanelComponent));

type HeroProps = {
  climb: BoardPresenceClimb | null;
  boardConfig: BoardConfig | null;
  labelColor: ColorValue;
  secondaryColor: ColorValue;
  accentColor: ColorValue;
  surfaceColor: ColorValue;
  formattedGrade: string | null;
  gradeColor: string;
};

type InteractiveRowActionProps = {
  onPress?: (climb: BoardPresenceClimb) => void;
  onPlayNext?: (climb: BoardPresenceClimb) => void;
  onOpenPlaylist?: (climb: BoardPresenceClimb) => void;
  onOpenActions?: (climb: BoardPresenceClimb, loadedClimb?: Climb) => ClimbActionsTarget | null | undefined;
  /** The full climb, once loaded: its menu then knows who set it. */
  menuClimb?: Climb;
};

export type HeroContentProps = Omit<HeroProps, 'climb' | 'surfaceColor'> & {
  climb: BoardPresenceClimb;
  renderClimb: Climb;
  thumbnailSize?: number;
  isActionLoading?: boolean;
  /**
   * Make the driver avatar open the climber's profile on tap. Off inside an
   * interactive ClimbListRow, whose own tap gesture owns the row (a nested
   * pressable would double-fire the climb action + the profile push, and the
   * row's collapsed a11y node would hide it anyway). The row opens the climb;
   * the avatar there is identity only.
   */
  pressableAvatar?: boolean;
};

function NowOnTheWallHeroContent(props: HeroContentProps) {
  return (
    <WallHeroContentView
      {...props}
      thumbnail={
        <AccessoryClimbThumbnail climb={props.renderClimb} boardConfig={props.boardConfig} size={props.thumbnailSize} />
      }
    />
  );
}

type InteractiveHeroRowProps = HeroProps & {
  climb: BoardPresenceClimb;
  rowBoard: BoardSheetRowBoard;
  isActionLoading: boolean;
} & InteractiveRowActionProps;

const InteractiveHeroRow = memo(function InteractiveHeroRowInner({
  climb,
  rowBoard,
  boardConfig,
  labelColor,
  secondaryColor,
  accentColor,
  surfaceColor,
  formattedGrade,
  gradeColor,
  isActionLoading,
  onPress,
  onPlayNext,
  onOpenPlaylist,
  onOpenActions,
  menuClimb,
}: InteractiveHeroRowProps) {
  const rowClimb = useMemo(() => boardPresenceClimbToClimb(climb, boardConfig?.angle), [climb, boardConfig?.angle]);
  const climbBoardConfig = useMemo(
    () => (boardConfig ? actionBoardConfigForPresenceClimb(boardConfig, climb) : null),
    [boardConfig, climb],
  );
  const climbRowBoard = useMemo(
    () => (climbBoardConfig ? rowBoardForBoardConfig(climbBoardConfig) : rowBoard),
    [climbBoardConfig, rowBoard],
  );
  const contentRowStyle = useMemo(() => [styles.heroInteractiveRow, { backgroundColor: surfaceColor }], [surfaceColor]);
  const handlePress = useCallback(() => {
    onPress?.(climb);
  }, [climb, onPress]);
  const handlePlayNext = useCallback(() => {
    onPlayNext?.(climb);
  }, [climb, onPlayNext]);
  const handleOpenPlaylist = useCallback(() => {
    onOpenPlaylist?.(climb);
  }, [climb, onOpenPlaylist]);
  const handleOpenActions = useCallback(() => {
    return onOpenActions?.(climb, menuClimb);
  }, [climb, menuClimb, onOpenActions]);
  const renderContent = useCallback(
    ({ climb: renderClimb }: ClimbListRowRenderContentArgs) => (
      <NowOnTheWallHeroContent
        climb={climb}
        renderClimb={renderClimb}
        boardConfig={climbBoardConfig}
        labelColor={labelColor}
        secondaryColor={secondaryColor}
        accentColor={accentColor}
        formattedGrade={formattedGrade}
        gradeColor={gradeColor}
        thumbnailSize={52}
        isActionLoading={isActionLoading}
        // The row's tap opens the climb; the avatar is identity only here.
        pressableAvatar={false}
      />
    ),
    [accentColor, climb, climbBoardConfig, formattedGrade, gradeColor, isActionLoading, labelColor, secondaryColor],
  );

  return (
    <ClimbListRow
      climb={rowClimb}
      boardName={climbRowBoard.boardName}
      layoutId={climbRowBoard.layoutId}
      sizeId={climbRowBoard.sizeId}
      setIds={climbRowBoard.setIds}
      angle={climbRowBoard.angle}
      onPress={onPress ? handlePress : undefined}
      onPlayNext={onPlayNext ? handlePlayNext : undefined}
      onOpenPlaylist={onOpenPlaylist ? handleOpenPlaylist : undefined}
      onOpenActions={onOpenActions ? handleOpenActions : undefined}
      // Match the stat tiles; the native menu trigger would paint over this card.
      liftedMenu
      containerStyle={styles.heroInteractiveContainer}
      contentRowStyle={contentRowStyle}
      showSeparator={false}
      renderContent={renderContent}
    />
  );
});

const NowOnTheWallHero = memo(function NowOnTheWallHeroInner({
  climb,
  boardConfig,
  labelColor,
  secondaryColor,
  accentColor,
  surfaceColor,
  formattedGrade,
  gradeColor,
}: HeroProps) {
  const renderClimb = useMemo(
    () => (climb ? boardPresenceClimbToClimb(climb, boardConfig?.angle) : null),
    [climb, boardConfig?.angle],
  );
  const climbBoardConfig = useMemo(
    () => (boardConfig && climb ? actionBoardConfigForPresenceClimb(boardConfig, climb) : null),
    [boardConfig, climb],
  );

  if (!climb || !renderClimb) return null;

  return (
    <View style={[styles.hero, { backgroundColor: surfaceColor }]}>
      <NowOnTheWallHeroContent
        climb={climb}
        renderClimb={renderClimb}
        boardConfig={climbBoardConfig}
        labelColor={labelColor}
        secondaryColor={secondaryColor}
        accentColor={accentColor}
        formattedGrade={formattedGrade}
        gradeColor={gradeColor}
      />
    </View>
  );
});

type HistoryRowProps = {
  climb: BoardPresenceClimb;
  boardConfig: BoardConfig | null;
  labelColor: ColorValue;
  secondaryColor: ColorValue;
  formattedGrade: string | null;
  gradeColor: string;
};

export type HistoryRowContentProps = HistoryRowProps & {
  renderClimb: Climb;
  isActionLoading?: boolean;
  /** See HeroContentProps.pressableAvatar — off inside an interactive row. */
  pressableAvatar?: boolean;
};

function HistoryRowContent(props: HistoryRowContentProps) {
  return (
    <WallHistoryContentView
      {...props}
      thumbnail={<AccessoryClimbThumbnail climb={props.renderClimb} boardConfig={props.boardConfig} />}
      sentAgo={formatRelativeTime(props.climb.sentAt)}
    />
  );
}

type InteractiveHistoryRowProps = HistoryRowProps & {
  rowBoard: BoardSheetRowBoard;
  isActionLoading: boolean;
} & InteractiveRowActionProps;

const InteractiveHistoryRow = memo(function InteractiveHistoryRowInner({
  climb,
  rowBoard,
  boardConfig,
  labelColor,
  secondaryColor,
  formattedGrade,
  gradeColor,
  isActionLoading,
  onPress,
  onPlayNext,
  onOpenPlaylist,
  onOpenActions,
  menuClimb,
}: InteractiveHistoryRowProps) {
  const rowClimb = useMemo(() => boardPresenceClimbToClimb(climb, boardConfig?.angle), [climb, boardConfig?.angle]);
  const climbBoardConfig = useMemo(
    () => (boardConfig ? actionBoardConfigForPresenceClimb(boardConfig, climb) : null),
    [boardConfig, climb],
  );
  const climbRowBoard = useMemo(
    () => (climbBoardConfig ? rowBoardForBoardConfig(climbBoardConfig) : rowBoard),
    [climbBoardConfig, rowBoard],
  );
  const handlePress = useCallback(() => {
    onPress?.(climb);
  }, [climb, onPress]);
  const handlePlayNext = useCallback(() => {
    onPlayNext?.(climb);
  }, [climb, onPlayNext]);
  const handleOpenPlaylist = useCallback(() => {
    onOpenPlaylist?.(climb);
  }, [climb, onOpenPlaylist]);
  const handleOpenActions = useCallback(() => {
    return onOpenActions?.(climb, menuClimb);
  }, [climb, menuClimb, onOpenActions]);
  const renderContent = useCallback(
    ({ climb: renderClimb }: ClimbListRowRenderContentArgs) => (
      <HistoryRowContent
        climb={climb}
        renderClimb={renderClimb}
        boardConfig={climbBoardConfig}
        labelColor={labelColor}
        secondaryColor={secondaryColor}
        formattedGrade={formattedGrade}
        gradeColor={gradeColor}
        isActionLoading={isActionLoading}
        // The row's tap opens the climb; the avatar is identity only here.
        pressableAvatar={false}
      />
    ),
    [climb, climbBoardConfig, formattedGrade, gradeColor, isActionLoading, labelColor, secondaryColor],
  );

  return (
    <ClimbListRow
      climb={rowClimb}
      boardName={climbRowBoard.boardName}
      layoutId={climbRowBoard.layoutId}
      sizeId={climbRowBoard.sizeId}
      setIds={climbRowBoard.setIds}
      angle={climbRowBoard.angle}
      onPress={onPress ? handlePress : undefined}
      onPlayNext={onPlayNext ? handlePlayNext : undefined}
      onOpenPlaylist={onOpenPlaylist ? handleOpenPlaylist : undefined}
      onOpenActions={onOpenActions ? handleOpenActions : undefined}
      contentRowStyle={styles.historyInteractiveRow}
      showSeparator={false}
      renderContent={renderContent}
      testID="board-sheet-climb-row"
    />
  );
});

const HistoryRow = memo(function HistoryRowInner({
  climb,
  boardConfig,
  labelColor,
  secondaryColor,
  formattedGrade,
  gradeColor,
}: HistoryRowProps) {
  const thumbnailClimb = useMemo(
    () => boardPresenceClimbToClimb(climb, boardConfig?.angle),
    [climb, boardConfig?.angle],
  );
  const climbBoardConfig = useMemo(
    () => (boardConfig ? actionBoardConfigForPresenceClimb(boardConfig, climb) : null),
    [boardConfig, climb],
  );

  return (
    <View testID="board-sheet-climb-row" style={styles.historyRow}>
      <HistoryRowContent
        climb={climb}
        renderClimb={thumbnailClimb}
        boardConfig={climbBoardConfig}
        labelColor={labelColor}
        secondaryColor={secondaryColor}
        formattedGrade={formattedGrade}
        gradeColor={gradeColor}
      />
    </View>
  );
});
