import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Pressable,
  Text,
  StyleSheet,
  useWindowDimensions,
  type LayoutChangeEvent,
  type ViewStyle,
} from 'react-native';
import Animated, {
  useAnimatedStyle,
  useDerivedValue,
  useAnimatedReaction,
  useSharedValue,
  withTiming,
  runOnJS,
} from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useTranslation } from 'react-i18next';
import { computePeekOffset, type PeekDirection } from '@boardsesh/play-view';
import type { BoardName } from '@boardsesh/shared-schema';
import { BoardImageNative } from '../BoardImageNative';
import { Icon } from '../Icon';
import { useCarouselGesture } from './use-carousel-gesture';
import { useZoomPanGesture } from './use-zoom-pan-gesture';
import { computeContainedBoardSize } from './play-drawer-layout';
import { timing } from '../../theme/animations';
import { overlays } from '../../theme/tokens';

type BoardRenderData = {
  boardWidth: number;
  boardHeight: number;
};

type SwipeBoardCarouselProps = {
  boardName: BoardName;
  boardRenderData: BoardRenderData;
  layoutId: number;
  sizeId: number;
  setIds: string;
  currentFrames: string;
  /**
   * When playing a route, the per-frame BLE string to render for the ACTIVE
   * board only. Falls back to `currentFrames` when null/undefined (static climb
   * or idle). Peek boards and the zoom-reset identity stay keyed on
   * `currentFrames`, so per-frame ticks never disturb swipe navigation.
   */
  currentFrameOverride?: string | null;
  nextFrames: string | null;
  prevFrames: string | null;
  mirrored: boolean;
  canSwipeNext: boolean;
  canSwipePrevious: boolean;
  onSwipeNext: () => void;
  onSwipePrevious: () => void;
  // Fires whenever the local resetZoom callback identity is established or
  // changes — lets the parent stash it for the tick-FAB flow that needs to
  // reset zoom before opening the tick bar.
  onResetZoomReady?: (resetZoom: () => void) => void;
  enabled?: boolean;
};

export const SwipeBoardCarousel = React.memo(function SwipeBoardCarousel({
  boardName,
  boardRenderData,
  layoutId,
  sizeId,
  setIds,
  currentFrames,
  currentFrameOverride,
  nextFrames,
  prevFrames,
  mirrored,
  canSwipeNext,
  canSwipePrevious,
  onSwipeNext,
  onSwipePrevious,
  onResetZoomReady,
  enabled = true,
}: SwipeBoardCarouselProps) {
  const { t } = useTranslation('session');
  const { width: screenWidth } = useWindowDimensions();
  // Measured box the board is laid out into. The board is sized to *fit* this
  // box (contain) so the play drawer's full-screen first view can keep the
  // action bar and a Beta-videos teaser on screen instead of the tall board
  // pushing them below the fold. Starts at 0; populated by onLayout. The zoom
  // hook mirrors these into shared values, so updating after first layout
  // doesn't rebuild the gestures.
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });

  const { boardWidth, boardHeight } = boardRenderData;
  const aspectRatio = boardWidth / boardHeight;
  // Contain the board within the measured box, preserving aspect ratio and
  // centering. Letterboxes (horizontally on tall boards, vertically on wide
  // ones) so the whole climb stays visible while the box drives the height.
  const boardBox = useMemo(
    () => computeContainedBoardSize(containerSize.width, containerSize.height, aspectRatio),
    [containerSize, aspectRatio],
  );
  const boardStyle = useMemo<ViewStyle | undefined>(
    () => (boardBox ? { width: boardBox.width, height: boardBox.height } : undefined),
    [boardBox],
  );
  // The carousel works in board-width units: a letterboxed (narrower) board
  // must slide off by its own width and the peek board must enter edge-adjacent.
  // Using screenWidth instead leaves a gap equal to the letterbox margins.
  const boardWidthForSwipe = boardBox?.width ?? screenWidth;

  const { pinchGesture, zoomPanGesture, isZoomed, isZoomedSV, resetZoom, animatedZoomStyle } = useZoomPanGesture({
    enabled,
    containerWidth: boardBox?.width ?? screenWidth,
    containerHeight: boardBox?.height ?? containerSize.height,
  });

  const onResetZoomReadyRef = useRef(onResetZoomReady);
  onResetZoomReadyRef.current = onResetZoomReady;

  useEffect(() => {
    onResetZoomReadyRef.current?.(resetZoom);
  }, [resetZoom, onResetZoomReadyRef]);

  // Reset zoom on climb change, but only if actually zoomed — otherwise it's
  // just a no-op withTiming(1→1) and a setState(false→false).
  const prevFramesRef = useRef(currentFrames);
  useEffect(() => {
    if (prevFramesRef.current !== currentFrames) {
      prevFramesRef.current = currentFrames;
      if (isZoomed) resetZoom();
    }
  }, [currentFrames, isZoomed, resetZoom]);

  const { gesture: swipeGesture, translateX } = useCarouselGesture({
    onSwipeNext,
    onSwipePrevious,
    canSwipeNext,
    canSwipePrevious,
    boardWidth: boardWidthForSwipe,
    enabled,
    isZoomedSV,
  });

  const resetButtonOpacity = useSharedValue(0);
  useEffect(() => {
    resetButtonOpacity.value = withTiming(isZoomed ? 1 : 0, { duration: timing.fast });
  }, [isZoomed, resetButtonOpacity]);

  const resetButtonStyle = useAnimatedStyle(() => ({
    opacity: resetButtonOpacity.value,
  }));

  const currentStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  const peekDirection = useDerivedValue<PeekDirection>(() => (translateX.value < 0 ? 'next' : 'prev'));

  const [jsDirection, setJsDirection] = useState<PeekDirection>('next');
  useAnimatedReaction(
    () => peekDirection.value,
    (direction) => {
      runOnJS(setJsDirection)(direction);
    },
    [peekDirection],
  );

  const peekStyle = useAnimatedStyle(() => {
    if (translateX.value === 0) {
      return { opacity: 0, transform: [{ translateX: boardWidthForSwipe }] };
    }
    const offset = computePeekOffset({
      direction: peekDirection.value,
      swipeOffset: translateX.value,
      viewportWidth: boardWidthForSwipe,
    });
    return { opacity: 1, transform: [{ translateX: offset }] };
  });

  const peekFrames = jsDirection === 'next' ? nextFrames : prevFrames;

  // Outer composition: pinch + swipe always. zoomPan is rendered separately
  // as a conditional overlay when zoomed (see below) so it doesn't claim
  // 1-finger touches in the idle state. That keeps swipe navigation working
  // and lets vertical drags fall through to BottomSheetScrollView.
  const composedGesture = React.useMemo(
    () => Gesture.Simultaneous(pinchGesture, swipeGesture),
    [pinchGesture, swipeGesture],
  );

  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setContainerSize((prev) =>
      Math.abs(prev.width - width) > 1 || Math.abs(prev.height - height) > 1 ? { width, height } : prev,
    );
  }, []);

  return (
    <GestureDetector gesture={composedGesture}>
      <View style={styles.container} onLayout={handleLayout}>
        <Animated.View style={[styles.boardWrapper, boardBox ? { width: boardBox.width } : null, currentStyle]}>
          <Animated.View style={animatedZoomStyle}>
            <BoardImageNative
              frames={currentFrameOverride ?? currentFrames}
              boardName={boardName}
              layoutId={layoutId}
              sizeId={sizeId}
              setIds={setIds}
              boardWidth={boardWidth}
              boardHeight={boardHeight}
              mirrored={mirrored}
              style={boardStyle}
            />
          </Animated.View>
        </Animated.View>

        <Animated.View style={[styles.peekWrapper, peekStyle]} pointerEvents="none">
          {peekFrames && (
            <BoardImageNative
              frames={peekFrames}
              boardName={boardName}
              layoutId={layoutId}
              sizeId={sizeId}
              setIds={setIds}
              boardWidth={boardWidth}
              boardHeight={boardHeight}
              mirrored={mirrored}
              style={boardStyle}
            />
          )}
        </Animated.View>

        {/* Pan-while-zoomed overlay: only mounted when zoomed so it doesn't
            claim 1-finger touches in the idle state (which would block
            BottomSheetScrollView scroll on the climb image). 2-finger pinches
            fall through to the outer GestureDetector via maxPointers(1). */}
        {isZoomed && (
          <GestureDetector gesture={zoomPanGesture}>
            <View style={styles.zoomPanOverlay} />
          </GestureDetector>
        )}

        <Animated.View style={[styles.resetZoomWrapper, resetButtonStyle]} pointerEvents={isZoomed ? 'auto' : 'none'}>
          <Pressable
            onPress={resetZoom}
            style={styles.resetZoomButton}
            accessibilityRole="button"
            accessibilityLabel={t('playView.resetZoom')}
            hitSlop={8}
          >
            <Icon name="crop.free" size={14} color={overlays.onScrim} />
            <Text style={styles.resetZoomLabel}>{t('playView.resetZoom')}</Text>
          </Pressable>
        </Animated.View>
      </View>
    </GestureDetector>
  );
});

const styles = StyleSheet.create({
  container: {
    flex: 1,
    width: '100%',
    overflow: 'hidden',
    justifyContent: 'center',
    alignItems: 'center',
  },
  boardWrapper: {
    width: '100%',
    alignItems: 'center',
  },
  peekWrapper: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
  },
  zoomPanOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  resetZoomWrapper: {
    position: 'absolute',
    top: 12,
    right: 12,
    zIndex: 10,
  },
  resetZoomButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: overlays.scrim,
  },
  resetZoomLabel: {
    color: overlays.onScrim,
    fontSize: 12,
    fontWeight: '500',
  },
});
