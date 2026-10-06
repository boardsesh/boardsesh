import React, { type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  ReduceMotion,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { overlays } from '../../theme/tokens';
import { LOUPE_SIZE_PT, loupeInnerTransform, stepLoupe, type LoupeTrack } from './spray-gesture-math';
import type { SprayLoupeFeed } from './spray-loupe-feed';

/** The loupe fades rather than pops, quickly enough to keep up with a finger. */
const FADE_IN_MS = 90;
const FADE_OUT_MS = 120;
/** The white edge round the circle, in points. */
const EDGE_WIDTH = 2;
/** The centre dot's diameter, in points. */
const CENTRE_DOT_PT = 4;
/** The crosshair's arms stop this far short of the centre, so the dot sits in a gap. */
const CROSSHAIR_GAP_PT = 6;
/** How long each crosshair arm is, in points. */
const CROSSHAIR_ARM_PT = 14;

type SprayLoupeProps = {
  /** Written by whichever gesture overlay owns the touch. See `SprayLoupeFeed`. */
  feed: SprayLoupeFeed;
  /** How many times the content is magnified; the content's own ring layers read it too. */
  magnificationSV: SharedValue<number>;
  /** Where the board clip's top-left sits in the host, in points. */
  clipOffsetX: number;
  clipOffsetY: number;
  /** The host the loupe is placed in, in points. */
  hostWidth: number;
  hostHeight: number;
  /** The loupe never rises above this, in the host's points. */
  topSafe: number;
  /** The unzoomed board's size: the content is laid out at this size. */
  renderWidth: number;
  renderHeight: number;
  /**
   * A copy of the board, laid out at `renderWidth` × `renderHeight` in render
   * px: the photo, then whatever rings and previews should show through.
   * Memoise it — the loupe is `React.memo`'d so that a screen render does not
   * repaint a second ring layer.
   */
  children: ReactNode;
};

/**
 * A magnifier over the finger, so a thumb never hides the spot it is placing,
 * drawing or moving (SW spec 2.5).
 *
 * A {@link LOUPE_SIZE_PT} circle that sits above the touch, or beside it near
 * the top of the board (`loupePlacement`), showing a second copy of the board
 * at `magnificationSV` with a hairline crosshair on the exact point under the
 * finger. It is mounted in the screen, not inside the board's clip, so it can
 * overhang the board's edge.
 *
 * Always mounted, at opacity 0. Everything that moves — the circle's place,
 * the content's translate and scale, the fade — is a shared value read by an
 * animated style, so a gesture repaints it on the UI thread and React never
 * re-renders it. A touch only shows it once it has lasted 120 ms or moved
 * 4 pt, so a tap never flashes it; a gesture that is already long (a 400 ms
 * pick-up) shows it at once.
 *
 * Purely visual: no touches, nothing for a screen reader.
 */
export const SprayLoupe = React.memo(function SprayLoupe({
  feed,
  magnificationSV,
  clipOffsetX,
  clipOffsetY,
  hostWidth,
  hostHeight,
  topSafe,
  renderWidth,
  renderHeight,
  children,
}: SprayLoupeProps) {
  const opacitySV = useSharedValue(0);
  /** The circle's centre in the host. Written only by the reaction below. */
  const centreXSV = useSharedValue(0);
  const centreYSV = useSharedValue(0);
  /** What the loupe remembers about the touch it follows. Written only by the reaction below. */
  const trackSV = useSharedValue<LoupeTrack>({ startX: 0, startY: 0, side: 'above', shown: false });

  useAnimatedReaction(
    () => ({ touchDownAt: feed.touchDownAtSV.value, x: feed.xSV.value, y: feed.ySV.value }),
    (current, previous) => {
      const step = stepLoupe(
        previous,
        current,
        trackSV.value,
        Date.now(),
        { clipOffsetX, clipOffsetY, width: hostWidth, height: hostHeight, topSafe },
        LOUPE_SIZE_PT,
      );
      trackSV.value = step.track;
      if (step.placement) {
        centreXSV.value = step.placement.x;
        centreYSV.value = step.placement.y;
      }
      const fadeIn = { duration: FADE_IN_MS, reduceMotion: ReduceMotion.System };
      switch (step.fade) {
        case 'out':
          opacitySV.value = withTiming(0, { duration: FADE_OUT_MS, reduceMotion: ReduceMotion.System });
          return;
        case 'in':
          opacitySV.value = withTiming(1, fadeIn);
          return;
        case 'inAfterDelay':
          // Fades in once the delay is up, unless the finger lifts (the fade-out
          // replaces this) or moves (an `in` step) first. The delay is never
          // skipped for Reduce Motion — it is what keeps a tap from flashing the
          // loupe, not motion — only the fade is.
          opacitySV.value = withDelay(step.delayMs, withTiming(1, fadeIn), ReduceMotion.Never);
          return;
        case 'keep':
          return;
      }
    },
    [feed, clipOffsetX, clipOffsetY, hostWidth, hostHeight, topSafe],
  );

  const circleStyle = useAnimatedStyle(() => ({
    opacity: opacitySV.value,
    transform: [
      { translateX: centreXSV.value - LOUPE_SIZE_PT / 2 },
      { translateY: centreYSV.value - LOUPE_SIZE_PT / 2 },
    ],
  }));

  const contentStyle = useAnimatedStyle(() => {
    const magnification = magnificationSV.value;
    const inner = loupeInnerTransform(
      feed.renderXSV.value,
      feed.renderYSV.value,
      magnification,
      LOUPE_SIZE_PT,
      renderWidth,
      renderHeight,
    );
    return {
      transform: [{ translateX: inner.translateX }, { translateY: inner.translateY }, { scale: magnification }],
    };
  }, [feed, renderWidth, renderHeight]);

  if (renderWidth <= 0 || renderHeight <= 0) return null;

  return (
    <Animated.View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.circle, circleStyle]}
    >
      <Animated.View style={[styles.content, { width: renderWidth, height: renderHeight }, contentStyle]}>
        {children}
      </Animated.View>
      <View style={[styles.arm, styles.armHorizontal, styles.armLeft]} />
      <View style={[styles.arm, styles.armHorizontal, styles.armRight]} />
      <View style={[styles.arm, styles.armVertical, styles.armTop]} />
      <View style={[styles.arm, styles.armVertical, styles.armBottom]} />
      <View style={styles.centreDot} />
      {/* The edge last, so the content never paints over it. */}
      <View style={styles.edge} />
    </Animated.View>
  );
});

const LOUPE_HALF = LOUPE_SIZE_PT / 2;

const styles = StyleSheet.create({
  // Android only clips children to a rounded box with overflow hidden AND the
  // radius on the same view.
  circle: {
    position: 'absolute',
    left: 0,
    top: 0,
    width: LOUPE_SIZE_PT,
    height: LOUPE_SIZE_PT,
    borderRadius: LOUPE_HALF,
    overflow: 'hidden',
    backgroundColor: overlays.loupeBackdrop,
  },
  content: {
    position: 'absolute',
    left: 0,
    top: 0,
  },
  edge: {
    position: 'absolute',
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
    borderRadius: LOUPE_HALF,
    borderWidth: EDGE_WIDTH,
    borderColor: overlays.onScrim,
  },
  arm: {
    position: 'absolute',
    backgroundColor: overlays.onScrim,
    opacity: 0.85,
  },
  armHorizontal: {
    top: LOUPE_HALF - StyleSheet.hairlineWidth / 2,
    width: CROSSHAIR_ARM_PT,
    height: StyleSheet.hairlineWidth,
  },
  armVertical: {
    left: LOUPE_HALF - StyleSheet.hairlineWidth / 2,
    width: StyleSheet.hairlineWidth,
    height: CROSSHAIR_ARM_PT,
  },
  armLeft: { left: LOUPE_HALF - CROSSHAIR_GAP_PT - CROSSHAIR_ARM_PT },
  armRight: { left: LOUPE_HALF + CROSSHAIR_GAP_PT },
  armTop: { top: LOUPE_HALF - CROSSHAIR_GAP_PT - CROSSHAIR_ARM_PT },
  armBottom: { top: LOUPE_HALF + CROSSHAIR_GAP_PT },
  centreDot: {
    position: 'absolute',
    left: LOUPE_HALF - CENTRE_DOT_PT / 2,
    top: LOUPE_HALF - CENTRE_DOT_PT / 2,
    width: CENTRE_DOT_PT,
    height: CENTRE_DOT_PT,
    borderRadius: CENTRE_DOT_PT / 2,
    backgroundColor: overlays.onScrim,
  },
});
