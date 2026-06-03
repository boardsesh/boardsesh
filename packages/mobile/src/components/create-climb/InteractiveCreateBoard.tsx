import React, { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { View, StyleSheet, Pressable, type LayoutChangeEvent } from 'react-native';
import Animated from 'react-native-reanimated';
import { GestureDetector } from 'react-native-gesture-handler';
import type { LitUpHoldsMap } from '@boardsesh/shared-schema';
import { Text } from '../Text';
import { useZoomPanGesture } from '../play-drawer/use-zoom-pan-gesture';
import { overlays } from '../../theme/tokens';
import type { BoardHoldTarget } from '../../lib/create-board-holds';
import { HoldTargetLayer } from './HoldTargetLayer';
import { PaintedHoldsLayer } from './PaintedHoldsLayer';
import { buildHoldHitTargets } from './holdLayout';
import { useZoomedHoldTapGesture, PAN_ACTIVATION_OFFSET } from './use-zoomed-hold-tap-gesture';

type InteractiveCreateBoardProps = {
  /**
   * Board photo layer supplied by the caller so this component stays
   * board-family-agnostic: Aurora passes BoardImageNative, MoonBoard passes the
   * stacked MoonBoard background.
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
  /** Exact on-screen board size. The drawer passes this so the board renders on
   *  the first frame; full-screen callers can omit it and use onLayout sizing. */
  renderWidth?: number;
  renderHeight?: number;
  /** Optional overlay (e.g. heatmap) drawn between the background and the holds. */
  overlay?: ReactNode;
};

/**
 * The no-SVG interactive board editor. Painted holds and tap targets are plain
 * RN views placed inside the zoom-transformed board, so RNGH hit-tests them in
 * board-local space at any zoom level.
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
  renderWidth,
  renderHeight,
  overlay,
}: InteractiveCreateBoardProps) {
  const { t } = useTranslation('common');
  const [measuredSize, setMeasuredSize] = useState({ width: 0, height: 0 });
  const hasFixedRenderSize = renderWidth !== undefined && renderHeight !== undefined;
  const boardRenderWidth = renderWidth ?? measuredSize.width;
  const boardRenderHeight = renderHeight ?? measuredSize.height;

  const {
    pinchGesture,
    zoomPanGesture,
    isZoomed,
    scaleSV,
    translateXSV,
    translateYSV,
    containerWidthSV,
    containerHeightSV,
    resetZoom,
    animatedZoomStyle,
  } = useZoomPanGesture({
    enabled: true,
    containerWidth: boardRenderWidth,
    containerHeight: boardRenderHeight,
    panActivationOffset: PAN_ACTIVATION_OFFSET,
  });

  const holdById = useMemo(() => {
    const map = new Map<number, BoardHoldTarget>();
    for (const hold of holdTargets) map.set(hold.id, hold);
    return map;
  }, [holdTargets]);

  const hitTargets = useMemo(
    () => buildHoldHitTargets(holdTargets, boardWidth, boardHeight, boardRenderWidth, boardRenderHeight, mirrored),
    [holdTargets, boardWidth, boardHeight, boardRenderWidth, boardRenderHeight, mirrored],
  );

  const overlayGesture = useZoomedHoldTapGesture({
    zoomPanGesture,
    scaleSV,
    translateXSV,
    translateYSV,
    containerWidthSV,
    containerHeightSV,
    hitTargets,
    onTap: onPaint,
    onLongPress: onLongPressHold,
  });

  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setMeasuredSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
  }, []);

  const clipStyle = useMemo(
    () =>
      hasFixedRenderSize
        ? [styles.clip, { width: renderWidth, height: renderHeight }]
        : [styles.clip, styles.flexibleClip, { aspectRatio: boardWidth / boardHeight }],
    [hasFixedRenderSize, renderWidth, renderHeight, boardWidth, boardHeight],
  );

  return (
    <View style={styles.root}>
      <GestureDetector gesture={pinchGesture}>
        <View style={clipStyle} onLayout={hasFixedRenderSize ? undefined : handleLayout}>
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
              measuredWidth={boardRenderWidth}
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
              measuredWidth={boardRenderWidth}
              mirrored={mirrored}
            />
          </Animated.View>

          {isZoomed ? (
            <GestureDetector gesture={overlayGesture}>
              <View style={StyleSheet.absoluteFill} />
            </GestureDetector>
          ) : null}

          {isZoomed ? (
            <Pressable style={styles.resetButton} onPress={resetZoom} hitSlop={8} accessibilityRole="button">
              <Text variant="footnote" style={styles.resetLabel}>
                {t('board.resetZoom')}
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
    alignItems: 'center',
    justifyContent: 'center',
  },
  clip: {
    overflow: 'hidden',
  },
  flexibleClip: {
    width: '100%',
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
