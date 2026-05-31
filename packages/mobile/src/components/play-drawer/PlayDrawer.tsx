import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { View, Pressable, StyleSheet } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  BottomSheetModal,
  BottomSheetBackdrop,
  BottomSheetScrollView,
  type BottomSheetBackdropProps,
} from '@gorhom/bottom-sheet';
import type { BoardName, Climb } from '@boardsesh/shared-schema';
import type { ClimbQueueItem } from '@boardsesh/queue';
import { randomUUID } from 'expo-crypto';
import { computeNavigationState, boardSupportsMirroring } from '@boardsesh/play-view';
import type { ActiveSubDrawer } from '@boardsesh/play-view';
import { SwipeBoardCarousel } from './SwipeBoardCarousel';
import { PlayDrawerHeader } from './PlayDrawerHeader';
import { PlayDrawerActionBar } from './PlayDrawerActionBar';
import { PlayDrawerTickFab } from './PlayDrawerTickFab';
import { QuickTickBar } from './QuickTickBar';
import { DeferredSections } from './DeferredSections';
import { QueueSheet } from './QueueSheet';
import { AngleSelectorSheet } from './AngleSelectorSheet';
import { LogAscentSheet } from '../LogAscentSheet';
import { ClimbActionsSheet } from '../ClimbActionsSheet';
import { Icon } from '../Icon';
import { useQueue } from '../../providers/queue-provider';
import { useOptionalBluetoothContext } from '../../providers/bluetooth-provider';
import { useToggleFavorite } from '../../lib/graphql/hooks';
import { useGradeFormat } from '../../hooks/use-grade-format';
import { getBoardRenderData } from '../../lib/board-details';
import { hapticSuccess } from '../../lib/haptics';
import { usePlayDrawerWakeLock } from './use-play-drawer-wake-lock';
import { iosSystemColors } from '../../theme/ios-colors';
import { spacing, sheetStyles } from '../../theme/tokens';
import { timing } from '../../theme/animations';

function climbToQueueItem(climb: Climb): ClimbQueueItem {
  return {
    uuid: randomUUID(),
    climb: {
      uuid: climb.uuid,
      name: climb.name,
      frames: climb.frames,
      setter_username: climb.setter_username,
      angle: climb.angle,
      ascensionist_count: climb.ascensionist_count,
      difficulty: climb.difficulty,
      quality_average: climb.quality_average,
      stars: climb.stars,
      difficulty_error: climb.difficulty_error,
      benchmark_difficulty: climb.benchmark_difficulty,
      userAscents: climb.userAscents,
      userAttempts: climb.userAttempts,
    },
  };
}

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
  const insets = useSafeAreaInsets();
  const sheetRef = useRef<BottomSheetModal>(null);
  const [climb, setClimb] = useState<Climb | null>(null);
  const [showLogAscent, setShowLogAscent] = useState(false);
  const [isMirrored, setIsMirrored] = useState(false);
  const [isFavorited, setIsFavorited] = useState(false);
  const [isTickBarActive, setIsTickBarActive] = useState(false);
  const [isSheetOpen, setIsSheetOpen] = useState(false);
  const [activeSubDrawer, setActiveSubDrawer] = useState<ActiveSubDrawer>('none');
  const resetZoomRef = useRef<(() => void) | null>(null);

  const { state, setCurrentClimb, nextClimb, previousClimb, sessionId, addToQueue } = useQueue();
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
    () => computeNavigationState(state.queue, state.currentClimbQueueItem),
    [state.queue, state.currentClimbQueueItem],
  );

  const displayedClimb = climb ?? state.currentClimbQueueItem?.climb;

  // Auto-close tick bar when climb changes
  const displayedClimbUuid = displayedClimb?.uuid;
  useEffect(() => {
    setIsTickBarActive(false);
  }, [displayedClimbUuid]);

  // FAB animation: hide when tick bar is active
  const fabScale = useSharedValue(1);
  const fabOpacity = useSharedValue(1);

  useEffect(() => {
    fabScale.value = withTiming(isTickBarActive ? 0.5 : 1, { duration: timing.fast });
    fabOpacity.value = withTiming(isTickBarActive ? 0 : 1, { duration: timing.fast });
  }, [isTickBarActive, fabScale, fabOpacity]);

  const fabAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: fabScale.value }],
    opacity: fabOpacity.value,
  }));

  useImperativeHandle(ref, () => ({
    open: (selectedClimb: Climb, options?: PlayDrawerOpenOptions) => {
      setClimb(selectedClimb);
      setIsMirrored(false);
      setIsFavorited(false);
      setIsTickBarActive(false);
      setIsSheetOpen(true);
      setActiveSubDrawer('none');
      if (options?.setAsCurrent ?? true) {
        setCurrentClimb(climbToQueueItem(selectedClimb));
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
    // Capture the pre-toggle state so the mutation knows whether to add or
    // remove, then flip the heart optimistically.
    const currentlyFavorited = isFavorited;
    setIsFavorited((prev) => !prev);
    toggleFavoriteMutate({
      input: {
        boardName,
        climbUuid: displayedClimb.uuid,
        angle,
      },
      currentlyFavorited,
    });
  }, [displayedClimb, boardName, angle, isFavorited, toggleFavoriteMutate]);

  const handleLightbulb = useCallback(() => {
    if (!bluetooth) return;
    if (bluetooth.isConnected) void bluetooth.disconnect();
    else void bluetooth.connect();
  }, [bluetooth]);

  const handleOpenActions = useCallback(() => {
    setActiveSubDrawer('actions');
  }, []);

  const handleOpenQueue = useCallback(() => {
    setActiveSubDrawer('queue');
  }, []);

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

  const handleTickFabLongPress = useCallback(() => {
    setShowLogAscent(true);
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
      setCurrentClimb(queueItem);
    },
    [addToQueue, setCurrentClimb],
  );

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} opacity={0.5} />
    ),
    [],
  );

  const snapPoints = useMemo(() => ['100%'], []);

  const ascentCount = displayedClimb?.userAscents ?? 0;
  const supportsMirroring = boardSupportsMirroring(boardName, layoutId);
  const subDrawerOpen = activeSubDrawer !== 'none';

  return (
    <>
      <BottomSheetModal
        ref={sheetRef}
        snapPoints={snapPoints}
        topInset={insets.top}
        enablePanDownToClose
        enableContentPanningGesture={!subDrawerOpen}
        enableHandlePanningGesture={!subDrawerOpen}
        backdropComponent={renderBackdrop}
        onDismiss={handleClose}
        handleIndicatorStyle={sheetStyles.indicator}
        backgroundStyle={sheetStyles.background}
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
            <Icon name="close" size={20} color={iosSystemColors.systemGray} />
          </Pressable>

          {displayedClimb && (
            <>
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

                {/* Tick FAB */}
                <Animated.View
                  style={[styles.fabWrapper, fabAnimatedStyle]}
                  pointerEvents={isTickBarActive ? 'none' : 'auto'}
                >
                  <PlayDrawerTickFab
                    ascentCount={ascentCount}
                    onPress={handleTickFabPress}
                    onLongPress={handleTickFabLongPress}
                  />
                </Animated.View>

                {/* Quick Tick Bar (expanded mode) */}
                <QuickTickBar
                  visible={isTickBarActive}
                  climbUuid={displayedClimb.uuid}
                  boardName={boardName}
                  angle={angle}
                  isMirror={isMirrored}
                  isBenchmark={displayedClimb.benchmark_difficulty != null}
                  layoutId={layoutId}
                  sizeId={sizeId}
                  setIds={setIds}
                  sessionId={sessionId}
                  onDismiss={handleTickBarDismiss}
                />
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
                onPrevClick={handlePrev}
                onNextClick={handleNext}
                onMirror={handleMirror}
                onToggleFavorite={handleToggleFavorite}
                onLightbulb={handleLightbulb}
                onOpenActions={handleOpenActions}
                onOpenQueue={handleOpenQueue}
                currentAngle={angle}
                onOpenAngleSelector={handleOpenAngleSelector}
              />

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
              />
            </>
          )}
        </BottomSheetScrollView>
      </BottomSheetModal>

      {/* Sub-drawer: Queue */}
      {activeSubDrawer === 'queue' && (
        <QueueSheet
          visible={true}
          onClose={handleCloseSubDrawer}
          onClimbPress={(item) => {
            setClimb(item.climb);
            setCurrentClimb(item);
            handleCloseSubDrawer();
          }}
        />
      )}

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

      {/* Log Ascent sheet (full, via long-press) */}
      {displayedClimb && (
        <LogAscentSheet
          visible={showLogAscent}
          onDismiss={() => setShowLogAscent(false)}
          climbUuid={displayedClimb.uuid}
          climbName={displayedClimb.name}
          boardName={boardName}
          angle={angle}
          isMirror={isMirrored}
          isBenchmark={displayedClimb.benchmark_difficulty != null}
          layoutId={layoutId}
          sizeId={sizeId}
          setIds={setIds}
          sessionId={sessionId}
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
  fabWrapper: {
    position: 'absolute',
    bottom: 12,
    right: 16,
    zIndex: 10,
  },
});
