import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { View, Pressable, StyleSheet, type LayoutChangeEvent } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  BottomSheetModal,
  BottomSheetBackdrop,
  BottomSheetHandle,
  BottomSheetScrollView,
  type BottomSheetBackdropProps,
  type BottomSheetHandleProps,
} from '@gorhom/bottom-sheet';
import type { BoardName, Climb } from '@boardsesh/shared-schema';
import { randomUUID } from 'expo-crypto';
import { computeNavigationStateWithSuggestions, boardSupportsMirroring } from '@boardsesh/play-view';
import { climbToQueueItem } from '../../lib/climb-to-queue-item';
import type { ActiveSubDrawer } from '@boardsesh/play-view';
import { SwipeBoardCarousel } from './SwipeBoardCarousel';
import { PlayDrawerHeader } from './PlayDrawerHeader';
import { PlayDrawerActionBar } from './PlayDrawerActionBar';
import { LogAscentSheet } from '../LogAscentSheet';
import { DeferredSections } from './DeferredSections';
import { AngleSelectorSheet } from './AngleSelectorSheet';
import { ClimbActionsSheet } from '../ClimbActionsSheet';
import { Icon } from '../Icon';
import { useQueue } from '../../providers/queue-provider';
import { useDrawerHost } from '../../providers/drawer-host-provider';
import { useTheme } from '../../providers/theme-provider';
import { useOptionalBluetoothContext } from '../../providers/bluetooth-provider';
import { useToast } from '../../providers/toast-provider';
import { useToggleFavorite } from '../../lib/graphql/hooks';
import { useGradeFormat } from '../../hooks/use-grade-format';
import { useShareClimb } from '../../hooks/use-share-climb';
import { getBoardRenderData } from '../../lib/board-details';
import { hapticSuccess } from '../../lib/haptics';
import { usePlayDrawerWakeLock } from './use-play-drawer-wake-lock';
import { iosSystemColors } from '../../theme/ios-colors';
import { spacing, sheetStyles } from '../../theme/tokens';

type BoardConfig = {
  boardName: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle: number;
};

export type PlayDrawerOpenOptions = {
  /**
   * When `true` (default), the opened climb is dispatched through
   * `setCurrentClimb`, which both makes it the active climb and appends
   * it to the queue. Pass `false` when the drawer is being opened for a
   * climb that's already current (e.g. from the persistent queue bar),
   * to avoid duplicating that climb at the end of the queue — the queue
   * item wrapper carries a fresh uuid, so the reducer's idempotency
   * guards key off uuid and don't catch the duplicate.
   */
  setAsCurrent?: boolean;
};

export type PlayDrawerHandle = {
  open: (climb: Climb, options?: PlayDrawerOpenOptions) => void;
  close: () => void;
};

type PlayDrawerProps = {
  boardConfig: BoardConfig;
  onAngleChange?: (angle: number) => void;
};

export const PlayDrawer = forwardRef<PlayDrawerHandle, PlayDrawerProps>(function PlayDrawer(
  { boardConfig, onAngleChange },
  ref,
) {
  const { t } = useTranslation('session');
  const { systemColors } = useTheme();
  const insets = useSafeAreaInsets();
  const sheetRef = useRef<BottomSheetModal>(null);
  const [climb, setClimb] = useState<Climb | null>(null);
  const [isMirrored, setIsMirrored] = useState(false);
  const [isFavorited, setIsFavorited] = useState(false);
  const [isTickBarActive, setIsTickBarActive] = useState(false);
  const [isSheetOpen, setIsSheetOpen] = useState(false);
  const [activeSubDrawer, setActiveSubDrawer] = useState<ActiveSubDrawer>('none');
  const resetZoomRef = useRef<(() => void) | null>(null);

  // Measured heights driving the peek snap-point. The peek opens the drawer
  // just far enough to reveal the Beta Videos section header. Because board
  // carousel height varies by board/layout and the gorhom handle owns its own
  // padding, every contributor is measured at runtime rather than hardcoded.
  const [handleHeight, setHandleHeight] = useState(0);
  const [aboveFoldHeight, setAboveFoldHeight] = useState(0);
  const [betaHeaderHeight, setBetaHeaderHeight] = useState(0);

  const setHeightIfChanged = (setter: (updater: (prev: number) => number) => void, measured: number) => {
    setter((prev) => (Math.abs(prev - measured) > 2 ? Math.round(measured) : prev));
  };
  const handleHandleLayout = useCallback((event: LayoutChangeEvent) => {
    setHeightIfChanged(setHandleHeight, event.nativeEvent.layout.height);
  }, []);
  const handleAboveFoldLayout = useCallback((event: LayoutChangeEvent) => {
    setHeightIfChanged(setAboveFoldHeight, event.nativeEvent.layout.height);
  }, []);
  const handleBetaHeaderLayout = useCallback((measured: number) => {
    setHeightIfChanged(setBetaHeaderHeight, measured);
  }, []);

  // Tracks the last climb the corrective snap fired for. Without this, every
  // aboveFold re-measurement on climb-switch would yank a user-expanded sheet
  // back to peek; gating on UUID means the snap fires exactly once per climb
  // and leaves manual user expansion alone afterwards.
  const lastSnappedClimbUuidRef = useRef<string | null>(null);

  const { state, setCurrentClimb, nextClimb, previousClimb, playlistSuggestionSource, sessionId, addToQueue } =
    useQueue();
  const { openQueueSheet } = useDrawerHost();
  const bluetooth = useOptionalBluetoothContext();
  const { mutate: toggleFavoriteMutate } = useToggleFavorite();
  const { formatGrade } = useGradeFormat();

  const { boardName, layoutId, sizeId, setIds, angle } = boardConfig;

  usePlayDrawerWakeLock(isSheetOpen);

  const boardRenderData = useMemo(() => {
    const parsedSetIds = setIds.split(',').map(Number);
    return getBoardRenderData({
      boardName: boardName as BoardName,
      layoutId,
      sizeId,
      setIds: parsedSetIds,
    });
  }, [boardName, layoutId, sizeId, setIds]);

  const navigationState = useMemo(
    () => computeNavigationStateWithSuggestions(state.queue, state.currentClimbQueueItem, playlistSuggestionSource),
    [state.queue, state.currentClimbQueueItem, playlistSuggestionSource],
  );

  const displayedClimb = climb ?? state.currentClimbQueueItem?.climb;

  // Auto-close tick bar when climb changes
  const displayedClimbUuid = displayedClimb?.uuid;
  useEffect(() => {
    setIsTickBarActive(false);
  }, [displayedClimbUuid]);

  const { showToast } = useToast();

  const shareClimb = useShareClimb({
    climb: displayedClimb ?? null,
    boardName,
    layoutId,
    sizeId,
    setIds,
    angle,
  });

  // Android can throw on share cancellation; surface anything we didn't expect
  // rather than silently swallowing the rejection.
  const handleShare = useCallback(() => {
    shareClimb().catch((error) => {
      console.warn('[playDrawer] share failed:', error);
      showToast(t('playView.shareError'), 'error');
    });
  }, [shareClimb, showToast, t]);

  useImperativeHandle(ref, () => ({
    open: (selectedClimb: Climb, options?: PlayDrawerOpenOptions) => {
      setClimb(selectedClimb);
      setIsMirrored(false);
      setIsFavorited(false);
      setIsTickBarActive(false);
      setIsSheetOpen(true);
      setActiveSubDrawer('none');
      lastSnappedClimbUuidRef.current = null;
      if (options?.setAsCurrent ?? true) {
        // Fresh activation from the list/search clears any playlist suggestion
        // source (web passes the same null option on every non-playlist set).
        setCurrentClimb(climbToQueueItem(selectedClimb), { playlistSuggestionSource: null });
      }
      sheetRef.current?.present();
    },
    close: () => {
      sheetRef.current?.dismiss();
    },
  }));

  const handleClose = useCallback(() => {
    setClimb(null);
    setIsMirrored(false);
    setIsTickBarActive(false);
    setIsSheetOpen(false);
    setActiveSubDrawer('none');
    lastSnappedClimbUuidRef.current = null;
  }, []);

  const handlePrev = useCallback(() => {
    setClimb(null);
    previousClimb();
    setIsMirrored(false);
    setIsFavorited(false);
  }, [previousClimb]);

  const handleNext = useCallback(() => {
    setClimb(null);
    nextClimb();
    setIsMirrored(false);
    setIsFavorited(false);
  }, [nextClimb]);

  const handleMirror = useCallback(() => {
    setIsMirrored((prev) => !prev);
  }, []);

  const handleToggleFavorite = useCallback(() => {
    if (!displayedClimb) return;
    hapticSuccess();
    setIsFavorited((prev) => !prev);
    toggleFavoriteMutate({
      input: {
        boardName,
        climbUuid: displayedClimb.uuid,
        angle,
      },
    });
  }, [displayedClimb, boardName, angle, toggleFavoriteMutate]);

  const handleLightbulb = useCallback(() => {
    if (!bluetooth) return;
    if (bluetooth.isConnected) void bluetooth.disconnect();
    else void bluetooth.connect();
  }, [bluetooth]);

  const handleOpenActions = useCallback(() => {
    setActiveSubDrawer('actions');
  }, []);

  const handleOpenQueue = useCallback(() => {
    openQueueSheet();
  }, [openQueueSheet]);

  const handleOpenAngleSelector = useCallback(() => {
    setActiveSubDrawer('angleSelector');
  }, []);

  const handleCloseSubDrawer = useCallback(() => {
    setActiveSubDrawer('none');
  }, []);

  const handleTickFabPress = useCallback(() => {
    resetZoomRef.current?.();
    setIsTickBarActive(true);
  }, []);

  // Long-press now opens the same QuickTickBar as a short press; LogAscentSheet
  // has been retired in favour of a single ticking surface (see PR #2366).
  const handleTickFabLongPress = useCallback(() => {
    resetZoomRef.current?.();
    setIsTickBarActive(true);
  }, []);

  const handleTickBarDismiss = useCallback(() => {
    setIsTickBarActive(false);
  }, []);

  const handleResetZoomReady = useCallback((resetFn: () => void) => {
    resetZoomRef.current = resetFn;
  }, []);

  const handleSimilarClimbPress = useCallback(
    (similarClimb: Climb) => {
      setClimb(similarClimb);
      setIsMirrored(false);
      setIsFavorited(false);
      setIsTickBarActive(false);
      const queueItem = climbToQueueItem(similarClimb);
      addToQueue(queueItem);
      setCurrentClimb(queueItem, { playlistSuggestionSource: null });
    },
    [addToQueue, setCurrentClimb],
  );

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} opacity={0.5} />
    ),
    [],
  );

  const backgroundStyle = { ...sheetStyles.background, backgroundColor: systemColors.secondaryBackground };

  // Custom handle component wraps gorhom's default in a View whose onLayout
  // reports the actual handle height (depends on indicator style + paddings).
  // Memoized so gorhom doesn't see a new component identity each render.
  const HandleComponent = useMemo(
    () => (props: BottomSheetHandleProps) => (
      <View onLayout={handleHandleLayout}>
        <BottomSheetHandle {...props} indicatorStyle={sheetStyles.indicator} />
      </View>
    ),
    [handleHandleLayout],
  );

  // Sum the contributors so the Beta Videos title is fully revealed at peek
  // with a small reveal margin below (the cue that there's more to scroll).
  //   handleHeight     — measured: gorhom sheet handle
  //   contentPadTop    — BottomSheetScrollView contentContainerStyle paddingTop
  //   aboveFoldHeight  — measured: drawer header + carousel + action bar
  //   deferredPadTop   — DeferredSections container.paddingTop (sits above Beta section)
  //   betaHeaderHeight — measured: Beta Videos CollapsibleSection header row
  //   revealMargin     — breathing room below the title so it doesn't hug the edge
  const peekHeight =
    handleHeight > 0 && aboveFoldHeight > 0 && betaHeaderHeight > 0
      ? handleHeight + spacing[2] + aboveFoldHeight + spacing[3] + betaHeaderHeight + spacing[3]
      : 0;

  const snapPoints = useMemo<(number | string)[]>(
    () => (peekHeight > 0 ? [peekHeight, '100%'] : ['100%']),
    [peekHeight],
  );

  // First-frame measurement may land after the sheet has already presented at
  // 100% — this single corrective snap settles into peek without a perceptible
  // full-screen flash on subsequent climb opens. Guarded by a per-climb ref so
  // it fires exactly once per climb (won't yank a user who has manually pulled
  // the sheet to 100% while reading; subsequent height re-measurements no-op).
  useEffect(() => {
    if (peekHeight === 0 || !isSheetOpen || !displayedClimbUuid) return;
    if (lastSnappedClimbUuidRef.current === displayedClimbUuid) return;
    lastSnappedClimbUuidRef.current = displayedClimbUuid;
    sheetRef.current?.snapToIndex(0);
  }, [peekHeight, isSheetOpen, displayedClimbUuid]);

  const ascentCount = displayedClimb?.userAscents ?? 0;
  const supportsMirroring = boardSupportsMirroring(boardName, layoutId);
  const subDrawerOpen = activeSubDrawer !== 'none';

  return (
    <>
      <BottomSheetModal
        ref={sheetRef}
        snapPoints={snapPoints}
        index={0}
        topInset={insets.top}
        enablePanDownToClose
        enableContentPanningGesture={!subDrawerOpen}
        enableHandlePanningGesture={!subDrawerOpen}
        backdropComponent={renderBackdrop}
        handleComponent={HandleComponent}
        onDismiss={handleClose}
        backgroundStyle={backgroundStyle}
      >
        <BottomSheetScrollView
          style={styles.content}
          contentContainerStyle={{ paddingTop: spacing[2], paddingBottom: insets.bottom }}
        >
          <Pressable
            onPress={() => sheetRef.current?.dismiss()}
            accessibilityRole="button"
            accessibilityLabel={t('playView.closeAria')}
            style={styles.closeButton}
          >
            <Icon name="chevron.down" size={20} color={iosSystemColors.systemGray} />
          </Pressable>

          {displayedClimb && (
            <>
              <View onLayout={handleAboveFoldLayout}>
                <PlayDrawerHeader
                  name={displayedClimb.name}
                  difficulty={formatGrade(displayedClimb.difficulty) ?? displayedClimb.difficulty}
                  rawDifficulty={displayedClimb.difficulty}
                  qualityAverage={displayedClimb.quality_average}
                  ascensionistCount={displayedClimb.ascensionist_count}
                  stars={displayedClimb.stars}
                  setterUsername={displayedClimb.setter_username}
                />

                <View style={styles.boardSection}>
                  {boardRenderData && (
                    <SwipeBoardCarousel
                      boardName={boardName as BoardName}
                      boardRenderData={boardRenderData}
                      layoutId={layoutId}
                      sizeId={sizeId}
                      setIds={setIds}
                      currentFrames={displayedClimb.frames}
                      nextFrames={navigationState.nextItem?.climb.frames ?? null}
                      prevFrames={navigationState.prevItem?.climb.frames ?? null}
                      mirrored={isMirrored}
                      canSwipeNext={navigationState.canNext}
                      canSwipePrevious={navigationState.canPrevious}
                      onSwipeNext={handleNext}
                      onSwipePrevious={handlePrev}
                      onResetZoomReady={handleResetZoomReady}
                      enabled={!isTickBarActive}
                    />
                  )}
                </View>

                <PlayDrawerActionBar
                  canSwipePrevious={navigationState.canPrevious}
                  canSwipeNext={navigationState.canNext}
                  isMirrored={isMirrored}
                  supportsMirroring={supportsMirroring}
                  isFavorited={isFavorited}
                  remainingQueueCount={navigationState.remainingCount}
                  lightbulbActive={bluetooth?.isConnected ?? false}
                  lightbulbPending={bluetooth?.loading ?? false}
                  ascentCount={ascentCount}
                  onPrevClick={handlePrev}
                  onNextClick={handleNext}
                  onMirror={handleMirror}
                  onToggleFavorite={handleToggleFavorite}
                  onLightbulb={handleLightbulb}
                  onOpenActions={handleOpenActions}
                  onOpenQueue={handleOpenQueue}
                  onShare={handleShare}
                  onTickPress={handleTickFabPress}
                  onTickLongPress={handleTickFabLongPress}
                  currentAngle={angle}
                  onOpenAngleSelector={handleOpenAngleSelector}
                />
              </View>

              {/* Below-fold deferred sections */}
              <DeferredSections
                climb={displayedClimb}
                boardName={boardName}
                layoutId={layoutId}
                sizeId={sizeId}
                setIds={setIds}
                angle={angle}
                enabled={isSheetOpen}
                onSimilarClimbPress={handleSimilarClimbPress}
                onBetaHeaderLayout={handleBetaHeaderLayout}
              />
            </>
          )}
        </BottomSheetScrollView>
      </BottomSheetModal>

      {/* Sub-drawer: Climb actions */}
      {activeSubDrawer === 'actions' && (
        <ClimbActionsSheet
          visible={true}
          climb={displayedClimb ?? null}
          boardName={boardName}
          layoutId={layoutId}
          sizeId={sizeId}
          setIds={setIds}
          angle={angle}
          onAddToQueue={() => {
            if (displayedClimb) {
              addToQueue({
                uuid: randomUUID(),
                climb: displayedClimb,
              });
            }
          }}
          onToggleFavorite={handleToggleFavorite}
          onClose={handleCloseSubDrawer}
        />
      )}

      {/* Sub-drawer: Angle selector */}
      {activeSubDrawer === 'angleSelector' && (
        <AngleSelectorSheet
          visible={true}
          onClose={handleCloseSubDrawer}
          boardName={boardName}
          layoutId={layoutId}
          currentAngle={angle}
          onAngleChange={(newAngle) => {
            onAngleChange?.(newAngle);
            handleCloseSubDrawer();
          }}
        />
      )}

      {/* Tick sheet — sibling of the PlayDrawer modal so it renders above
          (gorhom `BottomSheetModal` with stackBehavior=push). Snap-point is
          60% so the climb image above stays visible while logging. */}
      {displayedClimb && (
        <LogAscentSheet
          visible={isTickBarActive}
          onDismiss={handleTickBarDismiss}
          climbUuid={displayedClimb.uuid}
          boardName={boardName}
          angle={angle}
          isMirror={isMirrored}
          isBenchmark={displayedClimb.benchmark_difficulty != null}
          layoutId={layoutId}
          sizeId={sizeId}
          setIds={setIds}
          sessionId={sessionId}
          consensusGradeName={displayedClimb.difficulty}
        />
      )}
    </>
  );
});

const styles = StyleSheet.create({
  content: {
    flex: 1,
  },
  closeButton: {
    position: 'absolute',
    top: 8,
    right: 8,
    zIndex: 2,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(120, 120, 128, 0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  boardSection: {
    flex: 1,
    position: 'relative',
    marginHorizontal: spacing[4],
  },
});
