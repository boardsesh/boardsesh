import React from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated';
import { overlays } from '../../theme/tokens';
import { useTheme } from '../../providers/theme-provider';

/** Line widths in screen points, held constant at any zoom. */
const RING_WIDTH_PT = 3;
const GHOST_WIDTH_PT = 2;
/** The highlight sits just outside the ring it is about, so the ring itself still shows. */
const RING_HIGHLIGHT_SCALE = 1.2;

type SprayHoverPreviewProps = {
  /**
   * Written by `SprayEditGestureOverlay`'s Pencil hover: `[id, cx, cy, r]` for
   * the ring under the Pencil, `[0, x, y, r]` for bare wall, empty for none. In
   * board px.
   */
  hoverSV: SharedValue<number[]>;
  scaleSV: SharedValue<number>;
  /** Board px per render px. */
  boardScale: number;
};

/**
 * What a Pencil tap would do, shown while the Pencil hovers above the glass
 * (iPad Pro M2 and later, and the Pencil Pro-capable iPads; elsewhere no hover
 * arrives and this never draws).
 *
 * Over a ring, a violet halo round it: a tap there switches it. Over bare wall,
 * a dashed circle the size a tap would add. Either way nothing is said in words:
 * the Pencil is a hair above the spot, and the answer has to be right there.
 *
 * Driven entirely by shared values, like `SelectedHoldOverlay`: two small views
 * positioned and sized on the UI thread, inside the board's zoom transform so
 * they track the photo at any zoom. Nothing re-renders while the Pencil moves.
 */
export const SprayHoverPreview = React.memo(function SprayHoverPreview({
  hoverSV,
  scaleSV,
  boardScale,
}: SprayHoverPreviewProps) {
  const { brandColors } = useTheme();

  const ringStyle = useAnimatedStyle(() => {
    const hover = hoverSV.value;
    if (hover.length < 4 || hover[0] === 0 || boardScale <= 0) return { opacity: 0 };
    return circleStyle(hover, boardScale, RING_HIGHLIGHT_SCALE, RING_WIDTH_PT / Math.max(1, scaleSV.value));
  }, [boardScale]);

  const ghostStyle = useAnimatedStyle(() => {
    const hover = hoverSV.value;
    if (hover.length < 4 || hover[0] !== 0 || boardScale <= 0) return { opacity: 0 };
    return circleStyle(hover, boardScale, 1, GHOST_WIDTH_PT / Math.max(1, scaleSV.value));
  }, [boardScale]);

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <Animated.View style={[styles.circle, { borderColor: brandColors.primaryFill }, ringStyle]} />
      <Animated.View style={[styles.circle, styles.ghost, { borderColor: overlays.onScrim }, ghostStyle]} />
    </View>
  );
});

/** A circle round the hover point, in render px. Same file as its callers, so the worklet call is safe. */
function circleStyle(hover: readonly number[], boardScale: number, radiusScale: number, borderWidth: number) {
  'worklet';
  const radius = (hover[3] / boardScale) * radiusScale;
  return {
    opacity: 1,
    width: radius * 2,
    height: radius * 2,
    borderRadius: radius,
    borderWidth,
    transform: [{ translateX: hover[1] / boardScale - radius }, { translateY: hover[2] / boardScale - radius }],
  };
}

const styles = StyleSheet.create({
  circle: {
    position: 'absolute',
    left: 0,
    top: 0,
    opacity: 0,
  },
  ghost: {
    borderStyle: 'dashed',
  },
});
