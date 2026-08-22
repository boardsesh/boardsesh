// Four corner brackets over the board while a browse latch is up — a viewfinder:
// you're looking THROUGH a lens, not driving the wall.
//
// Shape before colour, and zero pixels spent: the brackets are absolutely
// positioned inside the board section, so the board keeps its full height (the
// deleted preview banner's 32pt is a straight refund). Neutral stroke on purpose
// — the brand accent is fill-only in Velvet Send, so it can't carry a 2pt line,
// and the pill above already spends the accent on this exact state.

import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { FadeIn, useReducedMotion } from 'react-native-reanimated';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';

/** Arm length of each L. Long enough to read as a frame, short enough to stay out of the art. */
const BRACKET_ARM = 18;
const BRACKET_STROKE = 2;
/**
 * The frame is a SIBLING of the carousel inside the board section, and RN zIndex
 * only orders siblings — so this paints above the carousel's whole subtree,
 * `CAROUSEL_LAYER_Z` included (those values arbitrate inside the carousel's own
 * stacking context and say nothing about this overlay). Any positive value would
 * do; 1 is the honest one. What keeps it harmless is `pointerEvents="none"` plus
 * corner placement: the only carousel control it can reach is the reset-zoom
 * pill, whose top-right corner the top-right bracket can graze while zoomed —
 * a 2pt neutral stroke, and the control still takes every tap.
 */
const FRAME_Z = 1;

function BrowseFrameOverlayImpl() {
  const { systemColors } = useTheme();
  const reduceMotion = useReducedMotion();
  const stroke = { borderColor: systemColors.tertiaryLabel };

  return (
    // pointerEvents="none" throughout: the board's swipe, pinch and pan gestures
    // must hit-test exactly as they do without the frame.
    <Animated.View pointerEvents="none" entering={reduceMotion ? undefined : FadeIn.duration(150)} style={styles.frame}>
      <View style={[styles.corner, styles.topLeft, stroke]} />
      <View style={[styles.corner, styles.topRight, stroke]} />
      <View style={[styles.corner, styles.bottomLeft, stroke]} />
      <View style={[styles.corner, styles.bottomRight, stroke]} />
    </Animated.View>
  );
}

export const BrowseFrameOverlay = memo(BrowseFrameOverlayImpl);

const styles = StyleSheet.create({
  frame: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: FRAME_Z,
  },
  corner: {
    position: 'absolute',
    width: BRACKET_ARM,
    height: BRACKET_ARM,
  },
  topLeft: {
    top: spacing[2],
    left: spacing[2],
    borderTopWidth: BRACKET_STROKE,
    borderLeftWidth: BRACKET_STROKE,
  },
  topRight: {
    top: spacing[2],
    right: spacing[2],
    borderTopWidth: BRACKET_STROKE,
    borderRightWidth: BRACKET_STROKE,
  },
  bottomLeft: {
    bottom: spacing[2],
    left: spacing[2],
    borderBottomWidth: BRACKET_STROKE,
    borderLeftWidth: BRACKET_STROKE,
  },
  bottomRight: {
    bottom: spacing[2],
    right: spacing[2],
    borderBottomWidth: BRACKET_STROKE,
    borderRightWidth: BRACKET_STROKE,
  },
});
