import React, { useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { View, StyleSheet, Pressable } from 'react-native';
import Animated from 'react-native-reanimated';
import { GestureDetector } from 'react-native-gesture-handler';
import type { LitUpHoldsMap } from '@boardsesh/shared-schema';
import { Text } from '../Text';
import { useZoomPanGesture } from '../play-drawer/use-zoom-pan-gesture';
import { overlays } from '../../theme/tokens';
import type { BoardHoldTarget } from '../../lib/create-board-holds';
import { HoldTargetLayer } from './HoldTargetLayer';
import { PaintedHoldsLayer } from './PaintedHoldsLayer';

type InteractiveCreateBoardProps = {
  /**
   * Board photo/background layer. Aurora passes BoardImageNative; MoonBoard
   * passes the stacked MoonBoard webp layers.
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
  renderWidth: number;
  renderHeight: number;
  /** Optional overlay (e.g. heatmap) drawn between the background and holds. */
  overlay?: ReactNode;
};

/**
 * No-SVG interactive board editor. It is sized by the drawer so it paints on the
 * first frame, and the one-finger pan overlay only mounts while zoomed so idle
 * vertical drags can still scroll or close the drawer.
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
  const { pinchGesture, zoomPanGesture, isZoomed, resetZoom, animatedZoomStyle } = useZoomPanGesture({
    enabled: true,
    containerWidth: renderWidth,
    containerHeight: renderHeight,
  });

  const holdById = useMemo(() => {
    const map = new Map<number, BoardHoldTarget>();
    for (const hold of holdTargets) map.set(hold.id, hold);
    return map;
  }, [holdTargets]);

  return (
    <View style={styles.root}>
      <GestureDetector gesture={pinchGesture}>
        <View style={[styles.clip, { width: renderWidth, height: renderHeight }]}>
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
              measuredWidth={renderWidth}
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
              measuredWidth={renderWidth}
              mirrored={mirrored}
            />
          </Animated.View>

          {isZoomed ? (
            <GestureDetector gesture={zoomPanGesture}>
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
    alignItems: 'center',
    justifyContent: 'center',
  },
  clip: {
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
