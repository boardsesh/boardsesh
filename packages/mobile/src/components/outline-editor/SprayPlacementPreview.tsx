import React from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated';
import { overlays } from '../../theme/tokens';
import { useTheme } from '../../providers/theme-provider';
import { useZoomStrokeStep } from './SprayHoldSvgLayer';

/** Line width of the placed circle in screen points at 1x, divided by the zoom step like every ring. */
const PREVIEW_LINE_WIDTH = 3;
/** The violet wash inside it, as on the selected ring. */
const PREVIEW_FILL_OPACITY = 0.3;

type SprayPlacementPreviewProps = {
  /**
   * The hold a press and hold is placing, as `[x, y, r]` in board px, or empty
   * when nothing is being placed. Written by `SprayEditGestureOverlay` on the UI
   * thread as the finger slides, cleared by the screen once the hold is in.
   */
  placeHoldSV: SharedValue<number[]>;
  /**
   * The radius the box is drawn at, in board px — the wall's median, which is
   * what a placement uses. A different `r` in the shared value scales it.
   */
  radius: number;
  scaleSV: SharedValue<number>;
  /** Board px per render px. */
  boardScale: number;
};

/**
 * The circle a press and hold on bare wall is about to place, under the finger.
 *
 * Lives inside the board's zoom transform (`renderInTransform`) so it tracks the
 * photo; moved by an animated transform alone, so sliding it costs no render.
 * Drawn like the selected ring (white line, violet wash), because the moment it
 * lands it becomes the selected ring.
 */
export const SprayPlacementPreview = React.memo(function SprayPlacementPreview({
  placeHoldSV,
  radius,
  scaleSV,
  boardScale,
}: SprayPlacementPreviewProps) {
  const { brandColors } = useTheme();
  const zoomStep = useZoomStrokeStep(scaleSV);
  const diameter = boardScale > 0 && radius > 0 ? (radius * 2) / boardScale : 0;

  const positionStyle = useAnimatedStyle(() => {
    const placing = placeHoldSV.value;
    if (placing.length < 3 || diameter <= 0) {
      return { opacity: 0, transform: [{ translateX: 0 }, { translateY: 0 }, { scale: 1 }] };
    }
    return {
      opacity: 1,
      transform: [
        { translateX: placing[0] / boardScale - diameter / 2 },
        { translateY: placing[1] / boardScale - diameter / 2 },
        { scale: placing[2] / radius },
      ],
    };
  }, [boardScale, diameter, radius]);

  if (diameter <= 0) return null;

  const shape = { width: diameter, height: diameter, borderRadius: diameter / 2 };
  return (
    <Animated.View pointerEvents="none" style={[styles.box, shape, positionStyle]}>
      <View
        style={[
          StyleSheet.absoluteFill,
          shape,
          { backgroundColor: brandColors.primaryFill, opacity: PREVIEW_FILL_OPACITY },
        ]}
      />
      <View
        style={[
          StyleSheet.absoluteFill,
          shape,
          { borderColor: overlays.onScrim, borderWidth: PREVIEW_LINE_WIDTH / zoomStep },
        ]}
      />
    </Animated.View>
  );
});

const styles = StyleSheet.create({
  box: {
    position: 'absolute',
    left: 0,
    top: 0,
  },
});
