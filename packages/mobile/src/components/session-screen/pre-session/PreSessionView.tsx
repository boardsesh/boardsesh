import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { FlashList, type FlashListRef } from '@shopify/flash-list';
import { ScrollView as GestureScrollView } from 'react-native-gesture-handler';
import { useSharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { toBoardName } from '@boardsesh/board-config';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import type { BoardName, Climb } from '@boardsesh/shared-schema';
import type { ClimbQueueItem } from '@boardsesh/queue';
import { track } from '../../../lib/analytics';
import { Card } from '../../Card';
import { SectionHeader } from '../../SectionHeader';
import { Text } from '../../Text';
import type { QueueItemRowBoard } from '../../QueueItemRow';
import { useTheme } from '../../../providers/theme-provider';
import { spacing } from '../../../theme/tokens';
import { useActiveBoard } from '../../../lib/graphql/use-active-board';
import { useAuth } from '../../../providers/auth-provider';
import { useQueueActions } from '../../../providers/queue-provider';
import { useToast } from '../../../providers/toast-provider';
import { useDrawerHost } from '../../../providers/drawer-host-provider';
import { useBottomChromeMetrics } from '../../../hooks/use-bottom-chrome-metrics';
import { reportError } from '../../../lib/error-reporting';
import { RecordTopChrome } from '../RecordTopChrome';
import { SESSION_START_FAB_HEIGHT, SessionStartFab } from '../SessionStartFab';
import { RepTimerSettingsCard } from '../in-session/RepTimerSettingsCard';
import { BoardSummaryCard } from './BoardSummaryCard';
import { GeneratorPickerCard, type GeneratorSelection } from './GeneratorPickerCard';
import { WorkoutPreviewRow } from './WorkoutPreviewRow';
import { useWorkoutPreview } from './use-workout-preview';
import type { PreviewItem } from './workout-preview-pool';

type PreSessionViewProps = {
  /** Render the floating glass chrome (large title + board pill). True in the
   *  Record tab; false in the overlay host, where the header strip owns the top. */
  showChrome?: boolean;
};

/**
 * First screen of the session overlay before a session is live: pick a board,
 * optionally generate a workout, review (and tweak) a live preview of the queue,
 * then tap Start. The preview is built/refreshed by `useWorkoutPreview`; Start
 * creates the session (the ONLY create path besides joining — sessions are never
 * created lazily) and replaces the user's queue with the preview, so
 * SessionScreen re-renders into InSessionView when `sessionId` flips.
 */
function previewKeyExtractor(previewItem: PreviewItem): string {
  return previewItem.item.uuid;
}

export function PreSessionView({ showChrome = false }: PreSessionViewProps) {
  const { t } = useTranslation('session');
  const { systemColors, variant } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const bottomChrome = useBottomChromeMetrics();
  const { data: activeBoard } = useActiveBoard();
  const { isAuthenticated } = useAuth();
  const { startSession, setQueue } = useQueueActions();
  const { openPlayDrawer } = useDrawerHost();
  const { showToast } = useToast();

  // Scroll offset drives the floating large-title chrome's collapse; tapping the
  // collapsed title capsule scrolls the list back to the top. FlashList forwards
  // a plain JS scroll event, so we mirror the offset into the shared value (the
  // same pattern the climbs list uses).
  const listRef = useRef<FlashListRef<PreviewItem>>(null);
  const scrollY = useSharedValue(0);
  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      scrollY.value = event.nativeEvent.contentOffset.y;
    },
    [scrollY],
  );
  const handleScrollToTop = useCallback(() => {
    listRef.current?.scrollToTop({ animated: true });
  }, []);
  // Measured chrome height (incl. the top safe-area inset) so the list pads its
  // top by it. Only used when the floating chrome renders (tab mode).
  const [chromeHeight, setChromeHeight] = useState(() => insets.top + 56);
  const handleOpenBoardSwitcher = useCallback(() => {
    router.push('/boards');
  }, [router]);

  const [selection, setSelection] = useState<GeneratorSelection>({ type: 'off' });
  const [isStarting, setIsStarting] = useState(false);
  const [activePreviewUuid, setActivePreviewUuid] = useState<string | null>(null);
  // Measured height of the Start capsule's container, so the list reserves exactly
  // its real height (+ the bottom offset) instead of a hardcoded clearance. Seeded
  // with the capsule's own constant so the first paint matches before onLayout
  // settles (Material's extended FAB is close enough and self-corrects on layout).
  const [footerHeight, setFooterHeight] = useState(SESSION_START_FAB_HEIGHT);

  const preview = useWorkoutPreview(selection, activeBoard ?? null, { isAuthenticated });
  const { items: previewItems, status, refreshingUuids, plannedCount, refreshSlot, toQueueItems } = preview;

  // Refreshes run one at a time, so once any row is regenerating every row's
  // refresh button is disabled (the rows dim it). Derived as a primitive so
  // renderItem keeps a stable, length-free dep.
  const isRefreshingAnyRow = refreshingUuids.size > 0;

  // A rebuild (generator options changed) mints fresh queue-item uuids, so a
  // previously highlighted preview row no longer exists. Drop the stale uuid so
  // the highlight doesn't point at a row that's gone. (A single-row refresh
  // keeps its uuid, so this leaves an active refresh's highlight intact.)
  useEffect(() => {
    if (
      activePreviewUuid !== null &&
      !previewItems.some((previewItem) => previewItem.item.uuid === activePreviewUuid)
    ) {
      setActivePreviewUuid(null);
    }
  }, [previewItems, activePreviewUuid]);

  // Board context for the preview rows (thumbnails + grade colours).
  const previewBoard = useMemo<QueueItemRowBoard | null>(() => {
    if (!activeBoard) return null;
    return {
      boardName: activeBoard.boardType as BoardName,
      layoutId: activeBoard.layoutId,
      sizeId: activeBoard.sizeId,
      setIds: activeBoard.setIds,
      angle: activeBoard.angle,
    };
  }, [activeBoard]);

  // Preview-only: show the climb in the play drawer and highlight the row, but
  // leave the real queue untouched until Start.
  const handlePreviewPress = useCallback(
    (item: ClimbQueueItem) => {
      setActivePreviewUuid(item.uuid);
      openPlayDrawer(item.climb as Climb, { setAsCurrent: false, previewQueueItem: item });
    },
    [openPlayDrawer],
  );

  const renderPreviewRow = useCallback(
    ({ item: previewItem }: { item: PreviewItem }) => {
      if (!previewBoard) return null;
      const isRefreshing = refreshingUuids.has(previewItem.item.uuid);
      return (
        <WorkoutPreviewRow
          item={previewItem.item}
          board={previewBoard}
          isActive={previewItem.item.uuid === activePreviewUuid}
          isRefreshing={isRefreshing}
          refreshDisabled={isRefreshingAnyRow && !isRefreshing}
          onPress={handlePreviewPress}
          onRefresh={refreshSlot}
        />
      );
    },
    [previewBoard, activePreviewUuid, refreshingUuids, isRefreshingAnyRow, handlePreviewPress, refreshSlot],
  );

  const handleStart = useCallback(async () => {
    if (!activeBoard) return;
    const generatedItems = selection.type === 'on' ? toQueueItems() : [];
    if (selection.type === 'on' && (status !== 'ready' || refreshingUuids.size > 0 || generatedItems.length === 0)) {
      return;
    }

    setIsStarting(true);
    try {
      const newSessionId = await startSession();
      if (!newSessionId) {
        // startSession already toasted on failure; just bail.
        return;
      }

      if (selection.type === 'on') {
        // Replace the queue with the reviewed preview (set the first climb
        // current so the session opens on climb #1). setQueue dispatches
        // UPDATE_QUEUE locally + best-effort party sync.
        setQueue(generatedItems, generatedItems[0]);
        track(SHARED_EVENTS.SessionQueueGenerated, {
          workoutType: selection.options.type,
          boardName: activeBoard.boardType,
          angle: activeBoard.angle,
          savedCount: generatedItems.length,
          failedCount: plannedCount - generatedItems.length,
        });
      }
    } catch (error) {
      reportError(error, { tags: { source: 'preSessionStart' } });
      showToast(t('mobile.session.preStartError'), 'error');
    } finally {
      setIsStarting(false);
    }
  }, [
    activeBoard,
    selection,
    toQueueItems,
    status,
    refreshingUuids,
    plannedCount,
    startSession,
    setQueue,
    showToast,
    t,
  ]);

  const generatorPreviewReady =
    selection.type !== 'on' || (status === 'ready' && previewItems.length > 0 && refreshingUuids.size === 0);
  const canStart = activeBoard != null && !isStarting && generatorPreviewReady;
  // The single source of the Start capsule's bottom offset: passed to SessionStartFab
  // AND used for the list reservation, so the FAB position and the last-row clearance
  // can't drift. Liquid Glass anchors to the raw safe-area inset; Material uses the
  // fixed-footer reserve.
  //
  // Verified on-device (iPhone 17 Pro / iOS 26): with the native tab bar + climb
  // accessory present, `useSafeAreaInsets().bottom` is 139 = home indicator (34) +
  // tab bar (49) + accessory (56) — i.e. the glass tab bar DOES extend the UIKit safe
  // area. `bottomChrome.fixedFooterBottom` adds the tab bar + accessory a second time
  // (246), which strands the control ~110px up the screen — hence the raw inset here.
  const footerBottom = variant === 'material' ? bottomChrome.fixedFooterBottom : insets.bottom;

  // Inline status copy shown above an empty preview (loading / no results /
  // error). When rows are already present a rebuild keeps them mounted, so these
  // only render while the preview is empty.
  const showPreviewSection = selection.type === 'on';
  const previewStateMessage =
    previewItems.length > 0
      ? null
      : status === 'loading'
        ? t('mobile.session.preWorkoutPreviewGenerating')
        : status === 'error'
          ? t('mobile.session.preWorkoutPreviewError')
          : status === 'ready'
            ? t('mobile.session.preWorkoutPreviewEmpty')
            : null;

  const listHeader = useMemo(
    () => (
      <View style={styles.header}>
        {/* The screen's identity in-body under the floating chrome, collapsing
            into the centred header capsule as it scrolls up. On Material the
            app bar owns the title, so the in-body large title is gated off. */}
        {variant === 'material' ? null : (
          <Text variant="largeTitle" style={styles.screenTitle}>
            {t('mobile.session.headerStart')}
          </Text>
        )}

        {/* The chrome pill owns board identity but collapses on scroll, so this
            keeps the full config (name · size · angle) persistently visible when a
            board is set, and prompts to pick one when none is. */}
        <View style={styles.cardInset}>
          <BoardSummaryCard onPress={handleOpenBoardSwitcher} board={activeBoard ?? null} />
        </View>

        <View style={styles.cardInset}>
          <RepTimerSettingsCard />
        </View>

        <GeneratorPickerCard
          boardName={activeBoard ? toBoardName(activeBoard.boardType) : null}
          layoutId={activeBoard?.layoutId ?? null}
          sizeId={activeBoard?.sizeId ?? null}
          angle={activeBoard?.angle ?? null}
          selection={selection}
          onChange={setSelection}
        />

        {showPreviewSection ? (
          <View>
            <SectionHeader title={t('mobile.session.preWorkoutPreviewTitle')} />
            {previewStateMessage ? (
              <View style={styles.cardInset}>
                <Card>
                  <Text variant="body" color={systemColors.secondaryLabel}>
                    {previewStateMessage}
                  </Text>
                </Card>
              </View>
            ) : null}
          </View>
        ) : null}
      </View>
    ),
    [
      activeBoard,
      handleOpenBoardSwitcher,
      previewStateMessage,
      selection,
      setSelection,
      showPreviewSection,
      systemColors.secondaryLabel,
      t,
      variant,
    ],
  );

  // Tab mode insets the list top by the measured floating-chrome height; the
  // overlay host renders its own header strip above, so no inset there.
  const listPaddingTop = showChrome ? chromeHeight : spacing[2];

  return (
    <View style={styles.container}>
      <FlashList
        ref={listRef}
        style={styles.scroll}
        data={previewItems}
        renderItem={renderPreviewRow}
        keyExtractor={previewKeyExtractor}
        ListHeaderComponent={listHeader}
        // Supported in FlashList 2.3.1: typed in FlashListProps and consumed at
        // runtime (useSecondaryProps wraps it via createAnimatedComponent). Use a
        // gesture-handler scroll host so Android nested chip rails keep their
        // horizontal gestures while the preview rows stay virtualized.
        renderScrollComponent={GestureScrollView}
        onScroll={handleScroll}
        scrollEventThrottle={16}
        // The floating chrome owns the top inset (tab mode), so pad manually by
        // the measured chrome height; never auto-inset under the (absent) header.
        contentInsetAdjustmentBehavior="never"
        contentContainerStyle={{
          paddingTop: listPaddingTop,
          paddingBottom: footerHeight + footerBottom,
        }}
        scrollIndicatorInsets={{ top: showChrome ? chromeHeight : 0 }}
        showsVerticalScrollIndicator={false}
        nestedScrollEnabled
        keyboardShouldPersistTaps="handled"
      />

      {showChrome ? (
        <RecordTopChrome
          title={t('mobile.session.headerStart')}
          onOpenBoardSwitcher={handleOpenBoardSwitcher}
          onHeightChange={setChromeHeight}
          scrollY={scrollY}
          onPressTitle={handleScrollToTop}
        />
      ) : null}

      <SessionStartFab
        testID="pre-session-footer"
        bottomOffset={footerBottom}
        onHeightChange={setFooterHeight}
        label={isStarting ? t('mobile.session.preStarting') : t('mobile.session.preStart')}
        icon="play.fill"
        onPress={() => void handleStart()}
        disabled={!canStart}
        loading={isStarting}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scroll: {
    flex: 1,
  },
  // No horizontal padding: the largeTitle and SectionHeaders bring their own
  // 16px inset, and the cards self-inset via `cardInset`, so the chip rails
  // inside the generator card can bleed to the card edges.
  header: {
    gap: spacing[3],
  },
  screenTitle: {
    paddingHorizontal: spacing[4],
    paddingTop: 0,
    paddingBottom: spacing[2],
  },
  // Matches the 16px screen gutter the SectionHeaders use, so cards line up.
  cardInset: {
    paddingHorizontal: spacing[4],
  },
});
