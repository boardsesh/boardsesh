import React, { useCallback, useMemo, useState, type ReactNode } from 'react';
import { View, StyleSheet, Pressable, type LayoutChangeEvent } from 'react-native';
import Animated from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import type { LitUpHoldsMap } from '@boardsesh/shared-schema';
import { Text } from '../Text';
import { useZoomPanGesture } from '../play-drawer/use-zoom-pan-gesture';
import { overlays } from '../../theme/tokens';
import type { BoardHoldTarget } from '../../lib/create-board-holds';
import { HoldTargetLayer } from './HoldTargetLayer';
import { PaintedHoldsLayer } from './PaintedHoldsLayer';

type InteractiveCreateBoardProps = {
  /**
   * The board photo layer, supplied by the caller so this component stays
   * board-family-agnostic: Aurora passes `<BoardImageNative frames="" …/>`,
   * MoonBoard passes `<MoonBoardBackground …/>`. Rendered beneath the holds.
   */
  background: ReactNode;
  boardWidth: number;
  boardHeight: number;
  holdTargets: BoardHoldTarget[];
  litUpHoldsMap: LitUpHoldsMap;
  onPaint: (holdId: number) => void;
  onLongPressHold: (holdId: number) => void;
  mirrored?: boolean;
  showAllHolds?: boolean;
  /** Optional overlay (e.g. heatmap) drawn between the background and the holds. */
  overlay?: ReactNode;
};

/**
 * The no-SVG interactive board editor. The background is supplied by the caller
 * (Aurora board PNG via BoardImageNative, or the stacked MoonBoard webps);
 * painted holds and tap targets are plain RN Views placed INSIDE the
 * zoom-transformed Animated.View, so RNGH hit-tests them in board-local space
 * and taps land correctly at any zoom level with zero manual coordinate math.
 */
export const InteractiveCreateBoard = React.memo(function InteractiveCreateBoard({
  background,
  boardWidth,
  boardHeight,
  holdTargets,
  litUpHoldsMap,
  onPaint,
  onLongPressHold,
  mirrored = false,
  showAllHolds = false,
  overlay,
}: InteractiveCreateBoardProps) {
  const [size, setSize] = useState({ width: 0, height: 0 });

  const { pinchGesture, zoomPanGesture, isZoomed, resetZoom, animatedZoomStyle } = useZoomPanGesture({
    enabled: true,
    containerWidth: size.width,
    containerHeight: size.height,
  });

  const holdById = useMemo(() => {
    const map = new Map<number, BoardHoldTarget>();
    for (const hold of holdTargets) map.set(hold.id, hold);
    return map;
  }, [holdTargets]);

  // Pinch (2-finger) and pan (1-finger, no-ops until zoomed) run together. The
  // per-hold Tap/LongPress detectors are nested children, so a stationary tap
  // wins (paint) while a drag activates the pan. If a device shows the pan
  // stealing quick taps while zoomed, add `.activeOffsetX([-8,8]).activeOffsetY([-8,8])`
  // to zoomPanGesture in use-zoom-pan-gesture.
  const rootGesture = useMemo(() => Gesture.Simultaneous(pinchGesture, zoomPanGesture), [pinchGesture, zoomPanGesture]);

  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
  }, []);

  const containerStyle = useMemo(
    () => [styles.clip, { aspectRatio: boardWidth / boardHeight }],
    [boardWidth, boardHeight],
  );

  return (
    <View style={styles.root}>
      <GestureDetector gesture={rootGesture}>
        <View style={containerStyle} onLayout={handleLayout}>
          <Animated.View style={[styles.board, animatedZoomStyle]}>
            {background}
            {overlay ? (
              <View pointerEvents="none" style={StyleSheet.absoluteFill}>
                {overlay}
              </View>
            ) : null}
            <HoldTargetLayer
              holdTargets={holdTargets}
              boardWidth={boardWidth}
              boardHeight={boardHeight}
              measuredWidth={size.width}
              mirrored={mirrored}
              showAllHolds={showAllHolds}
              onPaint={onPaint}
              onLongPress={onLongPressHold}
            />
            <PaintedHoldsLayer
              litUpHoldsMap={litUpHoldsMap}
              holdById={holdById}
              boardWidth={boardWidth}
              boardHeight={boardHeight}
              measuredWidth={size.width}
              mirrored={mirrored}
            />
          </Animated.View>

          {isZoomed ? (
            <Pressable style={styles.resetButton} onPress={resetZoom} hitSlop={8} accessibilityRole="button">
              <Text variant="footnote" style={styles.resetLabel}>
                Reset zoom
              </Text>
            </Pressable>
          ) : null}
        </View>
      </GestureDetector>
    </View>
  );
});

const styles = StyleSheet.create({
  root: {
    width: '100%',
  },
  clip: {
    width: '100%',
    overflow: 'hidden',
  },
  board: {
    width: '100%',
    height: '100%',
  },
  resetButton: {
    position: 'absolute',
    top: 12,
    right: 12,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: overlays.scrim,
  },
  resetLabel: {
    color: overlays.onScrim,
  },
});
