import { useNativeRootHeader } from '../../../hooks/use-native-root-header';
import { usePrivacySettings } from '../../../lib/graphql/hooks/use-privacy';
import { AudiencePicker, SESSION_AUDIENCES } from '../../privacy/AudiencePicker';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { FlashList, type FlashListRef } from '@shopify/flash-list';
import { ScrollView as GestureScrollView } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { toBoardName } from '@boardsesh/board-config';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import type { BoardName, Climb } from '@boardsesh/shared-schema';
import type { ClimbQueueItem } from '@boardsesh/queue';
import { track } from '../../../lib/analytics';
import { setWorkoutRun } from '../../../lib/workout-run-store';
import { armRestTimerForWorkout } from '../../../lib/rest-timer-effective';
import { nowMs } from '../../../lib/clock';
import { Card } from '../../Card';
import { SectionHeader } from '../../SectionHeader';
import { Text } from '../../Text';
import { ScreenTitle } from '../../ScreenTitle';
import type { QueueItemRowBoard } from '../../QueueItemRow';
import { useTheme } from '../../../providers/theme-provider';
import { spacing } from '../../../theme/tokens';
import { useAuth } from '../../../providers/auth-provider';
import { useQueueActions } from '../../../providers/queue-provider';
import { useToast } from '../../../providers/toast-provider';
import { useDrawerHost } from '../../../providers/drawer-host-provider';
import { useBottomChromeMetrics } from '../../../hooks/use-bottom-chrome-metrics';
import { reportError } from '../../../lib/error-reporting';
import { RecordTopChrome } from '../RecordTopChrome';
import { SESSION_START_FAB_HEIGHT, SessionStartFab } from '../SessionStartFab';
import { BoardSummaryCard } from '../../boards/BoardSummaryCard';
import { useBoardShortcutNavigation } from '../../../lib/boards/use-board-shortcut-navigation';
import { RestTimerArmRow } from '../RestTimerArmRow';
import { SessionVisibilityRow } from '../SessionVisibilityRow';
import { summarizePlanFill } from '@boardsesh/playlist-generator';
import { SCREENSHOT_WORKOUT } from '../../../lib/screenshot-mode';
import { GeneratorPickerCard } from './GeneratorPickerCard';
import {
  NO_WORKOUT,
  buildDefaultOptions,
  firstWorkoutType,
  hasWorkoutBlocks,
  selectionWorkoutTypes,
  singleBlockSelection,
  type GeneratorSelection,
} from './workout-blocks';
import { WorkoutPreviewListRow } from './WorkoutPreviewListRow';
import { WorkoutPreviewSummary } from './WorkoutPreviewSummary';
import { useWorkoutPreview } from './use-workout-preview';
import { buildPreviewListRows, type PreviewListRow } from './workout-preview-sections';
import { OnboardingTipBanner } from '../../onboarding/OnboardingTipBanner';
import { hasSeenTip, markTipSeen } from '../../../lib/onboarding/onboarding-storage';
import { ONBOARDING_TIP_CREW_KEY, ONBOARDING_TIP_WORKOUT_KEY } from '@boardsesh/key-value-storage';

// Screenshot mode starts with one open block of the preset type, so the Record
// screen renders a block card and its generated preview on load without
// Maestro driving the picker. No blocks in normal builds. A mid-grade target, as
// the DEFAULT_*_OPTIONS leave `targetGrade` out. Blocks added later get uuids,
// so this fixed id can't collide.
function initialGeneratorSelection(): GeneratorSelection {
  if (process.env.EXPO_PUBLIC_SCREENSHOT_MODE !== '1' || !SCREENSHOT_WORKOUT) return NO_WORKOUT;
  return singleBlockSelection(buildDefaultOptions(SCREENSHOT_WORKOUT, 15), 'screenshot-block');
}

type PreSessionViewProps = {
  /** Render the floating glass chrome (large title + board pill). True in the
   *  Record tab; false in the overlay host, where the header strip owns the top. */
  showChrome?: boolean;
  /** The owning screen retains this form while session state becomes live. */
  onStartingChange?: (starting: boolean) => void;
  /** The owning screen completes the tab handoff after the queue is ready. */
  onStarted?: () => void;
  /** Keep Start disabled until the native tab has left this screen. */
  isOpeningClimbs?: boolean;
};

/**
 * First screen of the session overlay before a session is live: pick a board,
 * optionally generate a workout, review (and tweak) a live preview of the queue,
 * then tap Start. The preview is built/refreshed by `useWorkoutPreview`; Start
 * creates the session (the ONLY create path besides joining — sessions are never
 * created lazily) and queues the preview behind the live queue without moving the
 * current climb, then opens Climbs with the new session running.
 */
function previewKeyExtractor(row: PreviewListRow): string {
  return row.key;
}

function previewItemType(row: PreviewListRow): PreviewListRow['kind'] {
  return row.kind;
}

export function PreSessionView({
  showChrome = false,
  onStartingChange,
  onStarted,
  isOpeningClimbs = false,
}: PreSessionViewProps) {
  const nativeRootHeader = useNativeRootHeader();
  const { t } = useTranslation('session');
  const { t: tCommon } = useTranslation('common');
  const { systemColors, variant } = useTheme();
  const insets = useSafeAreaInsets();
  const bottomChrome = useBottomChromeMetrics();
  const { boardQuery, hasNoBoard, browseClimbs, openBoardSwitcher, retryBoard } =
    useBoardShortcutNavigation('/(tabs)/record');
  const { data: activeBoard } = boardQuery;
  const { isAuthenticated } = useAuth();
  const { startSession, appendQueueItems } = useQueueActions();
  const { openPlayDrawer } = useDrawerHost();
  const { showToast } = useToast();

  // Just-in-time feature tips on the Record tab, shown one at a time (never
  // stacked) once a board is active: the workout builder first, then crew
  // sessions. Each fires once — dismissing marks it seen; the next opens on the
  // following visit. Only on the tab (showChrome), not the overlay host.
  const [activeTip, setActiveTip] = useState<'workout' | 'crew' | null>(null);
  useEffect(() => {
    if (!showChrome || !activeBoard) return;
    let cancelled = false;
    void (async () => {
      if (!(await hasSeenTip(ONBOARDING_TIP_WORKOUT_KEY))) {
        if (!cancelled) setActiveTip('workout');
        return;
      }
      if (!(await hasSeenTip(ONBOARDING_TIP_CREW_KEY))) {
        if (!cancelled) setActiveTip('crew');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [showChrome, activeBoard]);
  const dismissTip = useCallback(() => {
    setActiveTip((current) => {
      if (current === 'workout') void markTipSeen(ONBOARDING_TIP_WORKOUT_KEY);
      else if (current === 'crew') void markTipSeen(ONBOARDING_TIP_CREW_KEY);
      return null;
    });
  }, []);

  // Measured chrome height (incl. the top safe-area inset) so the list pads its
  // top by it. Only used when the floating chrome renders (tab mode).
  const [chromeHeight, setChromeHeight] = useState(() => insets.top + 56);

  const [selection, setSelection] = useState<GeneratorSelection>(initialGeneratorSelection);
  const [isStarting, setIsStarting] = useState(false);
  const isStartPending = isStarting || isOpeningClimbs;
  // "Show this session live". Public by default and not remembered between
  // sessions: every Start opens on, and turning it off is a per-session choice.
  const [isPublic, setIsPublic] = useState(true);
  const { data: privacySettings } = usePrivacySettings();
  const [sessionAudience, setSessionAudience] = useState<(typeof SESSION_AUDIENCES)[number] | null>(null);
  const effectiveSessionAudience =
    sessionAudience ??
    (privacySettings?.defaultSessionAudience === 'invite_only'
      ? 'invite_only'
      : privacySettings?.defaultSessionAudience === 'followers'
        ? 'followers'
        : 'public');
  const handleVisibilityChange = useCallback(
    (next: boolean) => {
      // Start has already read the choice; a flip now would change nothing.
      if (isStartPending) return;
      setIsPublic(next);
      track(SHARED_EVENTS.SessionVisibilityChanged, { isPublic: next, phase: 'pre_session' });
    },
    [isStartPending],
  );
  const [activePreviewUuid, setActivePreviewUuid] = useState<string | null>(null);
  // Measured height of the Start capsule's container, so the list reserves exactly
  // its real height (+ the bottom offset) instead of a hardcoded clearance. Seeded
  // with the capsule's own constant so the first paint matches before onLayout
  // settles (Material's extended FAB is close enough and self-corrects on layout).
  const [footerHeight, setFooterHeight] = useState(SESSION_START_FAB_HEIGHT);

  const preview = useWorkoutPreview(selection, activeBoard ?? null, { isAuthenticated });
  const {
    items: previewItems,
    status,
    refreshingUuids,
    plannedCount,
    plannedSlots,
    plannedStages,
    startQueue,
    refreshSlot,
    shuffle,
    toStagedQueueItems,
  } = preview;
  // Stage and section headings interleaved with the climbs, in the order the session runs them.
  const previewRows = useMemo(() => buildPreviewListRows(previewItems, plannedStages), [previewItems, plannedStages]);
  // What Start will queue: the planned slots that found a climb, across every stage.
  const planSummary = useMemo(
    () =>
      summarizePlanFill(
        plannedSlots,
        previewItems.map((previewItem) => previewItem.slot),
      ),
    [plannedSlots, previewItems],
  );

  // Refreshes run one at a time, so Shuffle waits while any row regenerates.
  // Derived as a primitive so the list header keeps a stable, length-free dep.
  const isRefreshingAnyRow = refreshingUuids.size > 0;
  const hasPreviewItems = previewItems.length > 0;

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
      openPlayDrawer(item.climb as Climb, { previewQueueItem: item });
    },
    [openPlayDrawer],
  );

  const renderPreviewRow = useCallback(
    ({ item: row }: { item: PreviewListRow }) => (
      <WorkoutPreviewListRow
        row={row}
        board={previewBoard}
        activeUuid={activePreviewUuid}
        refreshingUuids={refreshingUuids}
        onPress={handlePreviewPress}
        onRefresh={refreshSlot}
      />
    ),
    [previewBoard, activePreviewUuid, refreshingUuids, handlePreviewPress, refreshSlot],
  );

  const handleStart = useCallback(async () => {
    if (!activeBoard || isStartPending) return;
    const hasWorkout = hasWorkoutBlocks(selection);
    const {
      items: generatedItems,
      run: generatedRun,
      filledSlotCount,
    } = hasWorkout ? toStagedQueueItems() : { items: [], run: null, filledSlotCount: 0 };
    if (hasWorkout && (status !== 'ready' || refreshingUuids.size > 0 || generatedItems.length === 0)) {
      return;
    }

    setIsStarting(true);
    onStartingChange?.(true);
    try {
      const newSessionId = await startSession(
        privacySettings?.enabled
          ? { audience: effectiveSessionAudience, isPublic: effectiveSessionAudience === 'public' }
          : { isPublic },
      );
      if (!newSessionId) {
        // startSession already toasted on failure; just bail.
        return;
      }

      if (hasWorkout) {
        // Queue the reviewed preview behind whatever's already going, leaving
        // the current climb alone so the wall doesn't repaint and hand-queued
        // climbs survive. `activateFirstWhenIdle` opts this path — and only this
        // path — into opening on climb #1 when nothing is current, which is what
        // starting a generated session means. Bulk adds that aren't "start my
        // session" (the playlist row) leave it off so they never take the wall.
        appendQueueItems(generatedItems, { activateFirstWhenIdle: true });
        // Remember which stage each queued climb belongs to, so the session
        // screen and the player can say "Warm-up · 2 of 5". Keyed by the same
        // queue-item uuids just appended; it never goes over the wire.
        if (generatedRun) {
          setWorkoutRun(newSessionId, generatedRun);
          // A timed block runs hands-free: its rest timer is on from Start.
          armRestTimerForWorkout(newSessionId, generatedRun, nowMs());
        }
        track(SHARED_EVENTS.SessionQueueGenerated, {
          // The first workout block's type, so single-workout funnels keep their
          // meaning. Never a warm-up: null if a queue ever starts with no workout block.
          workoutType: firstWorkoutType(selection),
          workoutTypes: selectionWorkoutTypes(selection),
          boardName: activeBoard.boardType,
          angle: activeBoard.angle,
          savedCount: generatedItems.length,
          // Planned slots with no climb. A 4x4 queues each slot once per round,
          // so the queued count would overshoot the plan.
          failedCount: Math.max(0, plannedCount - filledSlotCount),
          stageCount: generatedRun?.stages.length ?? 0,
          // Start builds the workout; a block added later sends 'in_session'.
          phase: 'pre_session',
        });
      }
      if (onStarted) onStarted();
      else browseClimbs();
    } catch (error) {
      reportError(error, { tags: { source: 'preSessionStart' } });
      showToast(t('mobile.session.preStartError'), 'error');
    } finally {
      setIsStarting(false);
      onStartingChange?.(false);
    }
  }, [
    activeBoard,
    selection,
    toStagedQueueItems,
    status,
    refreshingUuids,
    plannedCount,
    startSession,
    isPublic,
    privacySettings?.enabled,
    effectiveSessionAudience,
    appendQueueItems,
    browseClimbs,
    showToast,
    t,
    onStartingChange,
    onStarted,
    isStartPending,
  ]);

  const generatorPreviewReady =
    !hasWorkoutBlocks(selection) || (status === 'ready' && previewItems.length > 0 && refreshingUuids.size === 0);
  const canStart = activeBoard != null && !isStartPending && generatorPreviewReady;
  // The single source of the Start capsule's bottom offset: passed to SessionStartFab
  // AND used for the list reservation, so the FAB position and the last-row clearance
  // can't drift. The Material-vs-glass arbitration lives in computeBottomChromeMetrics
  // (see `preSessionFooterBottom`): on glass it is the safe-area inset PLUS the JS
  // queue-tray reserve. The on-device iPhone 17 Pro evidence for using the raw inset
  // only covers the native-tab-bar path, where that reserve is 0; reading the inset
  // alone puts the capsule back under the tray on the JS-tab-bar fallback (#3967).
  const footerBottom = bottomChrome.preSessionFooterBottom;

  // Inline status copy shown above an empty preview (loading / no results /
  // error). When rows are already present a rebuild keeps them mounted, so these
  // only render while the preview is empty. A plan with no slots at all is only
  // warm-ups with nothing after them: say so instead of blaming the filters.
  const showPreviewSection = hasWorkoutBlocks(selection);
  const previewStateMessage =
    previewItems.length > 0
      ? null
      : status === 'loading'
        ? t('mobile.session.preWorkoutPreviewGenerating')
        : status === 'error'
          ? t('mobile.session.preWorkoutPreviewError')
          : status === 'ready'
            ? plannedCount === 0
              ? t('mobile.session.preWorkoutPreviewNothingPlanned')
              : t('mobile.session.preWorkoutPreviewEmpty')
            : null;

  // Tab mode insets the list top by the measured floating-chrome height; the
  // overlay host renders its own header strip above, so no inset there.
  const listPaddingTop = showChrome ? chromeHeight : spacing[2];

  // Scrolls a block card that was just added or opened until its bottom clears
  // the Start capsule and the tab bar, without pushing its header off the top.
  const listRef = useRef<FlashListRef<PreviewListRow>>(null);
  const screenRef = useRef<View>(null);
  const revealInsetsRef = useRef({ top: 0, bottom: 0 });
  revealInsetsRef.current = { top: listPaddingTop, bottom: footerHeight + footerBottom + spacing[4] };
  const revealBlock = useCallback((cardView: View) => {
    const screen = screenRef.current;
    if (!screen) return;
    screen.measureInWindow((_screenX, screenY, _screenWidth, screenHeight) => {
      cardView.measureInWindow((_cardX, cardY, _cardWidth, cardHeight) => {
        const list = listRef.current;
        if (!list) return;
        const { top, bottom } = revealInsetsRef.current;
        const hiddenBelow = cardY + cardHeight - (screenY + screenHeight - bottom);
        const roomAbove = cardY - (screenY + top);
        const scrollBy = Math.min(hiddenBelow, roomAbove);
        if (scrollBy <= 0) return;
        list.scrollToOffset({ offset: list.getAbsoluteLastScrollOffset() + scrollBy, animated: true });
      });
    });
  }, []);

  const listHeader = useMemo(
    () => (
      <View style={styles.header}>
        {activeTip ? (
          <View style={styles.cardInset}>
            <OnboardingTipBanner
              text={
                activeTip === 'workout'
                  ? tCommon('mobile.onboarding.tips.workout')
                  : tCommon('mobile.onboarding.tips.crew')
              }
              dismissLabel={tCommon('actions.close')}
              onDismiss={dismissTip}
              icon={activeTip === 'crew' ? 'people' : 'lightbulb.fill'}
            />
          </View>
        ) : null}

        {/* Native and overlay headers already own the title. Material's app
            bar suppresses ScreenTitle through the theme feature flag. */}
        {showChrome && !nativeRootHeader ? (
          <ScreenTitle style={styles.screenTitle}>{t('mobile.session.headerStart')}</ScreenTitle>
        ) : null}

        {/* The chrome pill owns board identity but collapses on scroll, so this
            keeps the full config (name · size · angle) persistently visible when a
            board is set, and prompts to pick one when none is. */}
        <View style={styles.cardInset} testID="pre-session-board-summary">
          <BoardSummaryCard
            board={activeBoard}
            hasNoBoard={hasNoBoard}
            isRestoreError={!activeBoard && boardQuery.isError}
            onBrowseClimbs={browseClimbs}
            onChangeBoard={openBoardSwitcher}
            onRetry={retryBoard}
          />
        </View>

        {/* Arm the rest timer for the session you're about to start (#5378). The
            arm carries in on its own — RestTimerSessionSync binds it when the
            session id appears. */}
        <View style={styles.cardInset}>
          <RestTimerArmRow />
        </View>

        {/* Whether the session you're about to start shows up live for your
            crew and climbers on this board. Sent with Start. */}
        <View style={styles.cardInset}>
          {privacySettings?.enabled ? (
            <AudiencePicker
              resource
              confirmPublic={privacySettings.isPrivate}
              audience={effectiveSessionAudience}
              options={SESSION_AUDIENCES}
              onChange={setSessionAudience}
              disabled={isStartPending}
            />
          ) : (
            <SessionVisibilityRow isPublic={isPublic} onChange={handleVisibilityChange} disabled={isStartPending} />
          )}
        </View>

        <GeneratorPickerCard
          boardName={activeBoard ? toBoardName(activeBoard.boardType) : null}
          layoutId={activeBoard?.layoutId ?? null}
          sizeId={activeBoard?.sizeId ?? null}
          angle={activeBoard?.angle ?? null}
          selection={selection}
          onChange={setSelection}
          onRevealBlock={revealBlock}
        />

        {showPreviewSection ? (
          <View>
            <SectionHeader title={t('mobile.session.preWorkoutPreviewTitle')} />
            {previewBoard && hasPreviewItems ? (
              <WorkoutPreviewSummary
                summary={planSummary}
                boardName={previewBoard.boardName}
                onShuffle={shuffle}
                shuffleDisabled={status !== 'ready' || isRefreshingAnyRow || isStartPending}
                startQueue={startQueue}
              />
            ) : null}
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
      activeTip,
      dismissTip,
      boardQuery.isError,
      browseClimbs,
      hasNoBoard,
      openBoardSwitcher,
      retryBoard,
      handleVisibilityChange,
      isPublic,
      privacySettings?.enabled,
      effectiveSessionAudience,
      isStartPending,
      previewStateMessage,
      previewBoard,
      hasPreviewItems,
      planSummary,
      startQueue,
      shuffle,
      status,
      isRefreshingAnyRow,
      selection,
      setSelection,
      revealBlock,
      showPreviewSection,
      showChrome,
      nativeRootHeader,
      systemColors.secondaryLabel,
      t,
      tCommon,
      variant,
    ],
  );

  return (
    <View ref={screenRef} style={styles.container}>
      <FlashList
        ref={listRef}
        style={styles.scroll}
        data={previewRows}
        renderItem={renderPreviewRow}
        keyExtractor={previewKeyExtractor}
        getItemType={previewItemType}
        ListHeaderComponent={listHeader}
        // Use a gesture-handler scroll host so Android nested chip rails keep their
        // horizontal gestures while the preview rows stay virtualized.
        renderScrollComponent={GestureScrollView}
        // The floating chrome owns the top inset (tab mode), so pad manually by
        // the measured chrome height; never auto-inset under the (absent) header.
        contentInsetAdjustmentBehavior={showChrome && nativeRootHeader ? 'automatic' : 'never'}
        contentContainerStyle={{
          paddingTop: listPaddingTop,
          paddingBottom: footerHeight + footerBottom,
        }}
        scrollIndicatorInsets={{ top: showChrome ? chromeHeight : 0 }}
        showsVerticalScrollIndicator={false}
        nestedScrollEnabled
        keyboardShouldPersistTaps="handled"
      />

      {showChrome ? <RecordTopChrome title={t('mobile.session.headerStart')} onHeightChange={setChromeHeight} /> : null}

      <SessionStartFab
        testID="pre-session-footer"
        bottomOffset={footerBottom}
        onHeightChange={setFooterHeight}
        label={isStartPending ? t('mobile.session.preStarting') : t('mobile.session.preStart')}
        icon="play.fill"
        onPress={() => void handleStart()}
        disabled={!canStart}
        loading={isStartPending}
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
