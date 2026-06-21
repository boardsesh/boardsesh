// Board sheet — "now on the wall" (the board-presence primary surface).
//
// A gorhom BottomSheetModal sibling of QueueSheet: same visible→present/dismiss
// split, GlassSheetBackground, stackBehavior="push". (No FullWindowOverlay — it
// prevented the sheet from presenting in this app; QueueSheet/PlayDrawer omit it.)
// Renders the wall's now-on-the-wall hero, a VIRTUALIZED history list
// (BottomSheetFlatList — never .map), light stat tiles, and a discoverable
// "Switch board" footer row that opens the existing board switcher.
//
// State comes from `@boardsesh/board-presence-react`'s split current/feed
// contexts, which are inert when the `board-presence` flag is off — so this
// sheet is only ever opened from the board glyph when the flag is on.

import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, RefreshControl, StyleSheet, View, type ColorValue } from 'react-native';
import {
  BottomSheetModal,
  BottomSheetBackdrop,
  BottomSheetFlatList,
  type BottomSheetBackdropProps,
} from '@gorhom/bottom-sheet';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { getGradeColor, DEFAULT_GRADE_COLOR } from '@boardsesh/board-constants/grade-colors';
import {
  useBoardPresenceActions,
  useBoardPresenceCurrent,
  useBoardPresenceFeed,
} from '@boardsesh/board-presence-react';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import type { BoardName, BoardPresenceClimb, BoardPresenceHardestSend, Climb } from '@boardsesh/shared-schema';
import { GlassSheetBackground } from '../GlassSheetBackground';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { ActivityIndicator } from '../ActivityIndicator';
import { ClimbListRow, type ClimbListRowRenderContentArgs } from '../ClimbListRow';
import { PressableAvatar } from '../PressableAvatar';
import { BoardDriverAvatar } from './BoardDriverAvatar';
import { AccessoryClimbThumbnail } from '../queue-control/AccessoryClimbThumbnail';
import { useTheme } from '../../providers/theme-provider';
import { useToast } from '../../providers/toast-provider';
import type { BoardConfig } from '../../providers/drawer-host-provider';
import { useBoardPresenceControls } from '../../providers/board-presence-provider';
import { useGradeFormat } from '../../hooks/use-grade-format';
import { track } from '../../lib/analytics';
import { getHttpClient } from '../../lib/graphql/client';
import { GET_CLIMB, type GetClimbQueryResponse } from '../../lib/graphql/operations';
import { boardPresenceClimbToClimb } from '../../lib/board-presence/presence-climb';
import { withAlpha } from '../../theme/colors';
import { spacing, borderRadius } from '../../theme/tokens';

const ACTION_CLIMB_CACHE_LIMIT = 50;
function boardPresenceHistoryKeyExtractor(item: BoardPresenceClimb): string {
  return `${item.climbUuid}-${item.seq}`;
}

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
};

type BoardSheetActionContext = {
  actionBoardConfig: BoardConfig;
  cacheKey: string;
};

function actionBoardConfigForPresenceClimb(boardConfig: BoardConfig, presenceClimb: BoardPresenceClimb): BoardConfig {
  const angle = presenceClimb.angle ?? boardConfig.angle;
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

/**
 * Imperative handle — the host presents/dismisses the sheet by calling these
 * directly from the tap handler (PlayDrawer's proven pattern). Driving gorhom's
 * `present()` from a `visible`-prop effect was a silent no-op in this build.
 */
export type BoardSheetHandle = {
  present: () => void;
  dismiss: () => void;
};

type BoardSheetProps = {
  /** The active board label, shown as the sheet title. */
  boardLabel: string | null;
  /**
   * Active board config for the climb thumbnails. Passed by the host (NOT read
   * via `useDrawerHost`) so BoardSheet stays out of the drawer-host require cycle
   * and doesn't subscribe to that volatile context — re-renders from it were
   * interfering with gorhom's `present()`, so the sheet never appeared.
   */
  boardConfig: BoardConfig | null;
  /** Request an animated close (header chevron) — the host calls `dismiss()`. */
  onClose: () => void;
  /** Optional: fired AFTER the dismiss animation finishes (gorhom `onDismiss`). */
  onDismissed?: () => void;
  /** Open the existing board switcher from the footer control. */
  onSwitchBoard: () => void;
  /** Activate/open a climb from the wall feed. BoardSheet closes itself after this. */
  onClimbPress?: (action: BoardSheetClimbAction) => void;
  /** Swipe action: append this wall-feed climb to the queue. */
  onAddToQueue?: (action: BoardSheetClimbAction) => void;
  /** Swipe action: open the add-to-playlist sheet for this climb. */
  onOpenPlaylist?: (action: BoardSheetClimbAction) => void;
  /** Long press action: open the existing climb actions sheet. */
  onOpenActions?: (action: BoardSheetClimbAction) => void;
};

export const BoardSheet = forwardRef<BoardSheetHandle, BoardSheetProps>(function BoardSheet(
  {
    boardLabel,
    boardConfig,
    onClose,
    onDismissed,
    onSwitchBoard,
    onClimbPress,
    onAddToQueue,
    onOpenPlaylist,
    onOpenActions,
  },
  ref,
) {
  const { t } = useTranslation('session');
  const insets = useSafeAreaInsets();
  const { systemColors, brandColors, sheet } = useTheme();
  const { showToast } = useToast();
  const { formatGrade } = useGradeFormat();
  const sheetRef = useRef<BottomSheetModal>(null);
  const boardConfigRef = useRef(boardConfig);
  boardConfigRef.current = boardConfig;
  const boardConfigSignature = useMemo(() => boardConfigActionSignature(boardConfig), [boardConfig]);
  const boardConfigSignatureRef = useRef(boardConfigSignature);
  boardConfigSignatureRef.current = boardConfigSignature;

  const { currentClimb } = useBoardPresenceCurrent();
  const { history, stats } = useBoardPresenceFeed();
  const { refresh } = useBoardPresenceActions();
  const { boardId: boardPresenceBoardId } = useBoardPresenceControls();
  const boardPresenceBoardIdRef = useRef(boardPresenceBoardId);
  boardPresenceBoardIdRef.current = boardPresenceBoardId;

  // Pull-to-refresh: a manual catch-up for when a user notices the wall feed is
  // stale. `refresh()` is fire-and-forget (the durable history merges back in
  // via context), so show the spinner briefly, then clear it.
  const [isRefreshing, setIsRefreshing] = useState(false);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleRefresh = useCallback(() => {
    refresh('manual');
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
  const historyCountRef = useRef(visibleHistory.length);
  historyCountRef.current = visibleHistory.length;

  const lastReceivedWallClimbRef = useRef<string | null>(null);
  // `seq` rides along in the telemetry payload but must NOT trigger the effect —
  // a same-uuid seq bump (e.g. a backfill merge) shouldn't re-evaluate the
  // "new climb on the wall" event. Read it from a ref so the effect keys only on
  // the climb uuid.
  const currentClimbSeqRef = useRef(currentClimb?.seq);
  currentClimbSeqRef.current = currentClimb?.seq;
  const actionClimbCacheRef = useRef(new Map<string, Climb>());
  const actionClimbRequestRef = useRef(new Map<string, Promise<Climb | null>>());
  const pendingActionKeysRef = useRef(new Set<string>());
  const actionGenerationRef = useRef(0);
  const [pendingActionKeys, setPendingActionKeys] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    const currentClimbUuid = currentClimb?.climbUuid;
    if (!currentClimbUuid) return;
    if (lastReceivedWallClimbRef.current === currentClimbUuid) return;
    lastReceivedWallClimbRef.current = currentClimbUuid;
    track(SHARED_EVENTS.BoardNowPlayingReceived, {
      boardId: boardPresenceBoardIdRef.current ?? undefined,
      climbUuid: currentClimbUuid,
      // `seq` lets PostHog spot gaps in the live stream (a jump = dropped pushes).
      seq: currentClimbSeqRef.current ?? undefined,
    });
  }, [currentClimb?.climbUuid]);

  const snapPoints = useMemo(() => ['55%', '92%'], []);
  const rowBoard = useMemo<BoardSheetRowBoard | null>(
    () => (boardConfig ? rowBoardForBoardConfig(boardConfig) : null),
    [boardConfig],
  );
  const canUseInteractiveRows = !!rowBoard && (!!onClimbPress || !!onAddToQueue || !!onOpenPlaylist || !!onOpenActions);

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
          climb: cachedClimb,
          queueItemUuid: presenceClimb.queueItemUuid ?? null,
          boardConfig: actionBoardConfig,
        };
      }

      let climbRequest = actionClimbRequestRef.current.get(cacheKey);
      if (!climbRequest) {
        climbRequest = getHttpClient()
          .request<GetClimbQueryResponse>(GET_CLIMB, {
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
        climb: loadedClimb,
        queueItemUuid: presenceClimb.queueItemUuid ?? null,
        boardConfig: actionBoardConfig,
      };
    },
    [],
  );

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
            if (closeOnSuccess) {
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

  const handleInteractiveClimbPress = useCallback(
    (presenceClimb: BoardPresenceClimb) => {
      if (!onClimbPress) return;
      runInteractiveAction(presenceClimb, onClimbPress, true);
    },
    [onClimbPress, runInteractiveAction],
  );

  const handleInteractiveAddToQueue = useCallback(
    (presenceClimb: BoardPresenceClimb) => {
      if (!onAddToQueue) return;
      runInteractiveAction(presenceClimb, onAddToQueue);
    },
    [onAddToQueue, runInteractiveAction],
  );

  const handleInteractiveOpenPlaylist = useCallback(
    (presenceClimb: BoardPresenceClimb) => {
      if (!onOpenPlaylist) return;
      runInteractiveAction(presenceClimb, onOpenPlaylist);
    },
    [onOpenPlaylist, runInteractiveAction],
  );

  const handleInteractiveOpenActions = useCallback(
    (presenceClimb: BoardPresenceClimb) => {
      if (!onOpenActions) return;
      runInteractiveAction(presenceClimb, onOpenActions);
    },
    [onOpenActions, runInteractiveAction],
  );

  const handleClose = useCallback(() => {
    invalidatePendingActions();
    onClose();
  }, [invalidatePendingActions, onClose]);

  const handleDismissed = useCallback(() => {
    invalidatePendingActions();
    onDismissed?.();
  }, [invalidatePendingActions, onDismissed]);

  const handleSwitchBoard = useCallback(() => {
    invalidatePendingActions();
    onSwitchBoard();
  }, [invalidatePendingActions, onSwitchBoard]);

  useImperativeHandle(ref, () => ({
    present: () => {
      if (historyCountRef.current > 0) {
        track(SHARED_EVENTS.BoardHistoryViewed, {
          boardId: boardPresenceBoardIdRef.current ?? undefined,
          itemCount: historyCountRef.current,
        });
      }
      sheetRef.current?.present();
    },
    dismiss: () => {
      invalidatePendingActions();
      sheetRef.current?.dismiss();
    },
  }));

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...props}
        disappearsOnIndex={-1}
        appearsOnIndex={0}
        opacity={sheet.scrimOpacity}
        pressBehavior="close"
      />
    ),
    [sheet.scrimOpacity],
  );

  const renderHistoryItem = useCallback(
    ({ item }: { item: BoardPresenceClimb }) => {
      const formattedGrade = item.grade ? formatGrade(item.grade) : null;
      const gradeColor = getGradeColor(item.grade ?? '') ?? DEFAULT_GRADE_COLOR;

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
            onAddToQueue={handleInteractiveAddToQueue}
            onOpenPlaylist={handleInteractiveOpenPlaylist}
            onOpenActions={handleInteractiveOpenActions}
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
      canUseInteractiveRows,
      rowBoard,
      systemColors.label,
      systemColors.secondaryLabel,
      formatGrade,
      handleInteractiveClimbPress,
      handleInteractiveAddToQueue,
      handleInteractiveOpenPlaylist,
      handleInteractiveOpenActions,
      isActionLoading,
      onClimbPress,
    ],
  );

  const listHeader = useMemo(
    () => (
      <View>
        {canUseInteractiveRows && rowBoard && currentClimb ? (
          <InteractiveHeroRow
            climb={currentClimb}
            rowBoard={rowBoard}
            boardConfig={boardConfig}
            labelColor={systemColors.label}
            secondaryColor={systemColors.secondaryLabel}
            accentColor={brandColors.warning}
            surfaceColor={systemColors.secondaryBackground}
            formattedGrade={currentClimb.grade ? formatGrade(currentClimb.grade) : null}
            gradeColor={getGradeColor(currentClimb.grade ?? '') ?? DEFAULT_GRADE_COLOR}
            isActionLoading={isActionLoading(currentClimb)}
            onPress={onClimbPress ? handleInteractiveClimbPress : undefined}
            onAddToQueue={handleInteractiveAddToQueue}
            onOpenPlaylist={handleInteractiveOpenPlaylist}
            onOpenActions={handleInteractiveOpenActions}
          />
        ) : (
          <NowOnTheWallHero
            climb={currentClimb}
            boardConfig={boardConfig}
            labelColor={systemColors.label}
            secondaryColor={systemColors.secondaryLabel}
            accentColor={brandColors.warning}
            surfaceColor={systemColors.secondaryBackground}
            formattedGrade={currentClimb?.grade ? formatGrade(currentClimb.grade) : null}
            gradeColor={getGradeColor(currentClimb?.grade ?? '') ?? DEFAULT_GRADE_COLOR}
          />
        )}
        {stats ? (
          <View style={styles.statsBlock}>
            <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.sectionHeader}>
              {t('mobile.boardPresence.statsHeader')}
            </Text>
            <View style={styles.statTiles}>
              <StatTile
                value={String(stats.climbsSentCount)}
                label={t('mobile.boardPresence.statSent')}
                surfaceColor={systemColors.secondaryBackground}
                labelColor={systemColors.secondaryLabel}
                valueColor={systemColors.label}
              />
              <StatTile
                value={String(stats.distinctClimbersCount)}
                label={t('mobile.boardPresence.statClimbers')}
                surfaceColor={systemColors.secondaryBackground}
                labelColor={systemColors.secondaryLabel}
                valueColor={systemColors.label}
              />
              <StatTile
                value={stats.hardestGrade ? (formatGrade(stats.hardestGrade) ?? '–') : '–'}
                label={t('mobile.boardPresence.statHardest')}
                surfaceColor={systemColors.secondaryBackground}
                labelColor={systemColors.secondaryLabel}
                valueColor={systemColors.label}
              />
              <StatTile
                value={stats.topGrade ? (formatGrade(stats.topGrade) ?? '–') : '–'}
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
                formattedGrade={formatGrade(stats.hardestSend.grade) ?? stats.hardestSend.grade}
                gradeColor={getGradeColor(stats.hardestSend.grade) ?? DEFAULT_GRADE_COLOR}
              />
            ) : null}
          </View>
        ) : null}
        {visibleHistory.length > 0 ? (
          <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.sectionHeader}>
            {t('mobile.boardPresence.historyHeader')}
          </Text>
        ) : null}
      </View>
    ),
    [
      currentClimb,
      boardConfig,
      stats,
      visibleHistory.length,
      systemColors,
      brandColors.warning,
      formatGrade,
      t,
      canUseInteractiveRows,
      rowBoard,
      handleInteractiveClimbPress,
      handleInteractiveAddToQueue,
      handleInteractiveOpenPlaylist,
      handleInteractiveOpenActions,
      isActionLoading,
      onClimbPress,
    ],
  );

  const listEmpty = useMemo(
    () =>
      currentClimb ? null : (
        <View style={styles.empty}>
          <Icon name="lightbulb" size={36} color={systemColors.tertiaryLabel} />
          <Text variant="headline" color={systemColors.label} style={styles.emptyTitle}>
            {t('mobile.boardPresence.emptyTitle')}
          </Text>
          <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.emptyBody}>
            {t('mobile.boardPresence.emptyBody')}
          </Text>
        </View>
      ),
    [currentClimb, systemColors, t],
  );

  return (
    <BottomSheetModal
      ref={sheetRef}
      index={0}
      snapPoints={snapPoints}
      // Height is driven by explicit snapPoints, so disable gorhom's dynamic
      // content sizing — it doesn't play well with a BottomSheetFlatList (no
      // bounded content height to measure).
      enableDynamicSizing={false}
      stackBehavior="push"
      enablePanDownToClose
      backdropComponent={renderBackdrop}
      onDismiss={handleDismissed}
      handleIndicatorStyle={sheet.handleStyle}
      backgroundComponent={GlassSheetBackground}
      style={styles.sheet}
    >
      <View style={[styles.header, { borderBottomColor: systemColors.separator }]}>
        <Pressable
          onPress={handleClose}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={t('mobile.boardPresence.close')}
          style={styles.headerAction}
        >
          <Icon name="chevron.down" size={20} color={systemColors.secondaryLabel} />
        </Pressable>
        <Text variant="title3" color={systemColors.label} numberOfLines={1} style={styles.headerTitle}>
          {boardLabel ?? t('mobile.boardPresence.title')}
        </Text>
        <View pointerEvents="none" style={styles.headerAction} />
      </View>

      <BottomSheetFlatList
        data={visibleHistory}
        keyExtractor={boardPresenceHistoryKeyExtractor}
        renderItem={renderHistoryItem}
        ListHeaderComponent={listHeader}
        ListEmptyComponent={listEmpty}
        contentContainerStyle={{ paddingBottom: spacing[4] }}
        refreshControl={
          <RefreshControl refreshing={isRefreshing} onRefresh={handleRefresh} tintColor={systemColors.secondaryLabel} />
        }
      />

      <Pressable
        onPress={handleSwitchBoard}
        accessibilityRole="button"
        accessibilityLabel={t('mobile.boardPresence.switchBoardAria')}
        style={[styles.footer, { borderTopColor: systemColors.separator, paddingBottom: insets.bottom + spacing[3] }]}
      >
        <View style={[styles.footerIcon, { backgroundColor: systemColors.secondaryBackground }]}>
          <Icon name="transfer" size={20} color={systemColors.label} />
        </View>
        <View style={styles.footerText}>
          <Text variant="body" color={systemColors.label}>
            {t('mobile.boardPresence.switchBoard')}
          </Text>
          {boardLabel ? (
            <Text variant="caption1" color={systemColors.secondaryLabel} numberOfLines={1}>
              {boardLabel}
            </Text>
          ) : null}
        </View>
        <Icon name="chevron.right" size={16} color={systemColors.tertiaryLabel} />
      </Pressable>
    </BottomSheetModal>
  );
});

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
  onAddToQueue?: (climb: BoardPresenceClimb) => void;
  onOpenPlaylist?: (climb: BoardPresenceClimb) => void;
  onOpenActions?: (climb: BoardPresenceClimb) => void;
};

type HeroContentProps = Omit<HeroProps, 'climb' | 'surfaceColor'> & {
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

function NowOnTheWallHeroContent({
  climb,
  renderClimb,
  boardConfig,
  labelColor,
  secondaryColor,
  accentColor,
  formattedGrade,
  gradeColor,
  thumbnailSize,
  isActionLoading = false,
  pressableAvatar = true,
}: HeroContentProps) {
  const { t } = useTranslation('session');
  const litBy = climb.sentByDisplayName?.trim() || null;
  const setter = climb.setter?.trim();

  return (
    <>
      <AccessoryClimbThumbnail climb={renderClimb} boardConfig={boardConfig} size={thumbnailSize} />
      <View style={styles.heroBody}>
        <View style={styles.heroNameRow}>
          <Text variant="headline" color={labelColor} numberOfLines={1} style={styles.heroName}>
            {climb.name ?? ''}
          </Text>
          {formattedGrade ? (
            <Text variant="headline" style={[styles.heroGrade, { color: gradeColor }]}>
              {formattedGrade}
            </Text>
          ) : null}
          {isActionLoading ? (
            <ActivityIndicator
              size="small"
              accessibilityLabel={t('mobile.boardPresence.actionLoading')}
              style={styles.actionSpinner}
            />
          ) : null}
        </View>
        {setter ? (
          <Text variant="caption1" color={secondaryColor} numberOfLines={1}>
            {t('mobile.boardPresence.setByLine', { setter })}
          </Text>
        ) : null}
        {litBy ? (
          <View style={styles.heroDriverRow}>
            <BoardDriverAvatar
              size={20}
              userId={pressableAvatar ? climb.sentByUserId : null}
              uri={climb.sentByAvatarUrl}
              name={litBy}
              status="connected"
              accessibilityLabel={t('mobile.boardPresence.drivenByA11y', { name: litBy })}
            />
            <Text variant="caption1" color={accentColor} numberOfLines={1} style={styles.heroDriverName}>
              {litBy}
            </Text>
          </View>
        ) : null}
      </View>
    </>
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
  onAddToQueue,
  onOpenPlaylist,
  onOpenActions,
}: InteractiveHeroRowProps) {
  const rowClimb = useMemo(() => boardPresenceClimbToClimb(climb), [climb]);
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
  const handleAddToQueue = useCallback(() => {
    onAddToQueue?.(climb);
  }, [climb, onAddToQueue]);
  const handleOpenPlaylist = useCallback(() => {
    onOpenPlaylist?.(climb);
  }, [climb, onOpenPlaylist]);
  const handleOpenActions = useCallback(() => {
    onOpenActions?.(climb);
  }, [climb, onOpenActions]);
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
      onAddToQueue={onAddToQueue ? handleAddToQueue : undefined}
      onOpenPlaylist={onOpenPlaylist ? handleOpenPlaylist : undefined}
      onOpenActions={onOpenActions ? handleOpenActions : undefined}
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
  const renderClimb = useMemo(() => (climb ? boardPresenceClimbToClimb(climb) : null), [climb]);
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

type HistoryRowContentProps = HistoryRowProps & {
  renderClimb: Climb;
  isActionLoading?: boolean;
  /** See HeroContentProps.pressableAvatar — off inside an interactive row. */
  pressableAvatar?: boolean;
};

function HistoryRowContent({
  climb,
  renderClimb,
  boardConfig,
  labelColor,
  secondaryColor,
  formattedGrade,
  gradeColor,
  isActionLoading = false,
  pressableAvatar = true,
}: HistoryRowContentProps) {
  const { t } = useTranslation('session');
  const litBy = climb.sentByDisplayName?.trim() || null;

  return (
    <>
      <AccessoryClimbThumbnail climb={renderClimb} boardConfig={boardConfig} />
      <View style={styles.historyBody}>
        <Text variant="subheadline" color={labelColor} numberOfLines={1} style={styles.historyName}>
          {climb.name ?? ''}
        </Text>
        {litBy ? (
          <View style={styles.historyDriverRow}>
            {/* Past send — no Bluetooth glyph (nobody's driving it now); just a
                pressable face for attribution. */}
            <BoardDriverAvatar
              size={18}
              userId={pressableAvatar ? climb.sentByUserId : null}
              uri={climb.sentByAvatarUrl}
              name={litBy}
              status="none"
              accessibilityLabel={t('mobile.boardPresence.drivenByA11y', { name: litBy })}
            />
            <Text variant="caption1" color={secondaryColor} numberOfLines={1} style={styles.historyDriverName}>
              {litBy}
            </Text>
          </View>
        ) : null}
      </View>
      {formattedGrade ? (
        <Text variant="headline" style={[styles.historyGrade, { color: gradeColor }]}>
          {formattedGrade}
        </Text>
      ) : null}
      {isActionLoading ? (
        <ActivityIndicator
          size="small"
          accessibilityLabel={t('mobile.boardPresence.actionLoading')}
          style={styles.actionSpinner}
        />
      ) : null}
    </>
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
  onAddToQueue,
  onOpenPlaylist,
  onOpenActions,
}: InteractiveHistoryRowProps) {
  const rowClimb = useMemo(() => boardPresenceClimbToClimb(climb), [climb]);
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
  const handleAddToQueue = useCallback(() => {
    onAddToQueue?.(climb);
  }, [climb, onAddToQueue]);
  const handleOpenPlaylist = useCallback(() => {
    onOpenPlaylist?.(climb);
  }, [climb, onOpenPlaylist]);
  const handleOpenActions = useCallback(() => {
    onOpenActions?.(climb);
  }, [climb, onOpenActions]);
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
      onAddToQueue={onAddToQueue ? handleAddToQueue : undefined}
      onOpenPlaylist={onOpenPlaylist ? handleOpenPlaylist : undefined}
      onOpenActions={onOpenActions ? handleOpenActions : undefined}
      contentRowStyle={styles.historyInteractiveRow}
      showSeparator={false}
      renderContent={renderContent}
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
  const thumbnailClimb = useMemo(() => boardPresenceClimbToClimb(climb), [climb]);
  const climbBoardConfig = useMemo(
    () => (boardConfig ? actionBoardConfigForPresenceClimb(boardConfig, climb) : null),
    [boardConfig, climb],
  );

  return (
    <View style={styles.historyRow}>
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

type StatTileProps = {
  value: string;
  label: string;
  surfaceColor: ColorValue;
  labelColor: ColorValue;
  valueColor: ColorValue;
};

function StatTile({ value, label, surfaceColor, labelColor, valueColor }: StatTileProps) {
  return (
    <View style={[styles.statTile, { backgroundColor: surfaceColor }]}>
      <Text variant="title3" color={valueColor} numberOfLines={1}>
        {value}
      </Text>
      <Text variant="caption1" color={labelColor} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

type HardestSendRowProps = {
  hardestSend: BoardPresenceHardestSend;
  labelColor: ColorValue;
  secondaryColor: ColorValue;
  surfaceColor: ColorValue;
  crownColor: string;
  formattedGrade: string;
  gradeColor: string;
};

function HardestSendRow({
  hardestSend,
  labelColor,
  secondaryColor,
  surfaceColor,
  crownColor,
  formattedGrade,
  gradeColor,
}: HardestSendRowProps) {
  const { t } = useTranslation('session');
  const climberName = hardestSend.sentByDisplayName?.trim();

  return (
    <View style={[styles.hardestSendRow, { backgroundColor: surfaceColor }]}>
      <View style={styles.hardestAvatar}>
        <PressableAvatar
          userId={hardestSend.sentByUserId}
          uri={hardestSend.sentByAvatarUrl}
          name={climberName}
          size={34}
        />
        <View style={[styles.crownBadge, { backgroundColor: withAlpha(crownColor, 0.18) }]}>
          <Icon name="crown" size={11} color={crownColor} />
        </View>
      </View>
      <View style={styles.hardestBody}>
        <Text variant="caption1" color={secondaryColor} numberOfLines={1}>
          {t('mobile.boardPresence.hardestSendLabel')}
        </Text>
        <Text variant="subheadline" color={labelColor} numberOfLines={1} style={styles.hardestName}>
          {hardestSend.name ?? ''}
        </Text>
        {climberName ? (
          <Text variant="caption1" color={secondaryColor} numberOfLines={1}>
            {t('mobile.boardPresence.sentByLine', { name: climberName })}
          </Text>
        ) : null}
      </View>
      <Text variant="headline" style={[styles.historyGrade, { color: gradeColor }]}>
        {formattedGrade}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: {
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: -4 },
        shadowOpacity: 0.1,
        shadowRadius: 12,
      },
      android: {
        elevation: 16,
      },
    }),
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing[3],
    paddingBottom: spacing[3],
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerAction: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    flex: 1,
    marginHorizontal: spacing[2],
    textAlign: 'center',
  },
  hero: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    margin: spacing[4],
    padding: spacing[3],
    borderRadius: borderRadius.lg,
  },
  heroInteractiveContainer: {
    margin: spacing[4],
    borderRadius: borderRadius.lg,
  },
  heroInteractiveRow: {
    padding: spacing[3],
    borderRadius: borderRadius.lg,
  },
  heroBody: {
    flex: 1,
    gap: 2,
  },
  heroNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
  heroName: {
    flex: 1,
  },
  heroDriverRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    // Headroom for the badge that pokes ~2pt past the avatar's top-right corner.
    paddingTop: 2,
  },
  heroDriverName: {
    flexShrink: 1,
  },
  heroGrade: {
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
  },
  sectionHeader: {
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    paddingHorizontal: spacing[4],
    paddingTop: spacing[3],
    paddingBottom: spacing[2],
  },
  statsBlock: {
    paddingBottom: spacing[2],
  },
  statTiles: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing[2],
    paddingHorizontal: spacing[4],
  },
  statTile: {
    flexGrow: 1,
    flexBasis: '47%',
    paddingVertical: spacing[3],
    paddingHorizontal: spacing[3],
    borderRadius: borderRadius.md,
    gap: 2,
  },
  hardestSendRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    marginHorizontal: spacing[4],
    marginTop: spacing[2],
    paddingVertical: spacing[3],
    paddingHorizontal: spacing[3],
    borderRadius: borderRadius.md,
  },
  hardestAvatar: {
    width: 42,
    height: 42,
    justifyContent: 'flex-end',
  },
  crownBadge: {
    position: 'absolute',
    top: 0,
    right: 0,
    width: 18,
    height: 18,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },
  hardestBody: {
    flex: 1,
    gap: 2,
  },
  hardestName: {
    fontWeight: '600',
  },
  historyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[2],
  },
  historyInteractiveRow: {
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[2],
  },
  historyBody: {
    flex: 1,
    gap: 2,
  },
  historyName: {
    fontWeight: '600',
  },
  historyDriverRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
  historyDriverName: {
    flexShrink: 1,
  },
  historyGrade: {
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
    minWidth: 40,
    textAlign: 'right',
  },
  actionSpinner: {
    width: 20,
    height: 20,
  },
  empty: {
    alignItems: 'center',
    gap: spacing[2],
    paddingHorizontal: spacing[6],
    paddingVertical: spacing[8],
  },
  emptyTitle: {
    textAlign: 'center',
  },
  emptyBody: {
    textAlign: 'center',
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    paddingHorizontal: spacing[4],
    paddingTop: spacing[3],
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  footerIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  footerText: {
    flex: 1,
    gap: 2,
  },
});
