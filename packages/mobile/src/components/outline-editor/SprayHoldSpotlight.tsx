import React, { useEffect, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSequence,
  withSpring,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';
import { overlays } from '../../theme/tokens';
import { brandColorsDark } from '../../theme/colors';
import { springs } from '../../theme/animations';
import { holdPathData } from './spray-hold-path';
import { RING, useZoomStrokeStep } from './SprayHoldSvgLayer';
import type { SpraySpotlightPulse } from './spray-spotlight';

/** How far past the hold's own reach the box extends, so the add ripple has room to grow. */
const RIPPLE_REACH = 2.2;
/** Stroke widths in screen points at 1x, divided by the zoom step like every ring. */
const STROKE = { ring: 2.5, ringHalo: 4.5, ripple: 1.5, undoHalo: 8 } as const;
/** The undo halo's whole life: in and out. */
const UNDO_PULSE_MS = 300;
/** The light violet: over a dimmed photograph it is the one that reads, in either scheme. */
const HALO_VIOLET = brandColorsDark.primary;
// The static highlight Reduce Motion gets in place of the pulse. Durations of
// 0 and `ReduceMotion.Never` so the system setting does not swallow the
// highlight itself along with the motion.
const INSTANT = { duration: 0, reduceMotion: ReduceMotion.Never } as const;

type SprayHoldSpotlightProps = {
  /** The latest moment to mark, or null before the first. */
  pulse: SpraySpotlightPulse | null;
  reduceMotion: boolean;
  /** The board's live zoom, for the stroke widths. */
  scaleSV: SharedValue<number>;
  /** Board px per render px. */
  boardScale: number;
};

/**
 * The one spotlight the editor animates: a toggled hold's ring pops back to
 * size (snappy spring) in the style it is switching to, an added one bounces in and throws a ripple, and an
 * undone one gets a short violet halo.
 *
 * One hold at a time, in one small box positioned at that hold, and every
 * frame is a UI-thread transform or opacity on it. The ring layer underneath
 * never re-renders for any of this. With Reduce Motion the tap moments show
 * nothing extra (the ring layer already changed) and the undo halo is a static
 * highlight for the same 300 ms.
 *
 * Lives inside the board's zoom transform, like the rings.
 */
export const SprayHoldSpotlight = React.memo(function SprayHoldSpotlight({
  pulse,
  reduceMotion,
  scaleSV,
  boardScale,
}: SprayHoldSpotlightProps) {
  const zoomStep = useZoomStrokeStep(scaleSV);
  const offDash = useMemo(() => RING.offDash.map((dash) => dash / zoomStep), [zoomStep]);
  const ringScaleSV = useSharedValue(1);
  const ringOpacitySV = useSharedValue(0);
  const rippleScaleSV = useSharedValue(1);
  const rippleOpacitySV = useSharedValue(0);
  const haloScaleSV = useSharedValue(1);
  const haloOpacitySV = useSharedValue(0);

  const shape = useMemo(() => {
    if (!pulse || boardScale <= 0) return null;
    const { hold } = pulse;
    let reach = hold.r;
    if (hold.outline) {
      for (let index = 0; index + 1 < hold.outline.length; index += 2) {
        reach = Math.max(reach, Math.hypot(hold.outline[index], hold.outline[index + 1]) * hold.r);
      }
    }
    const extent = reach * RIPPLE_REACH;
    const sizeRender = (extent * 2) / boardScale;
    return {
      extent,
      sizeRender,
      left: hold.cx / boardScale - sizeRender / 2,
      top: hold.cy / boardScale - sizeRender / 2,
      path: holdPathData({ cx: 0, cy: 0, r: hold.r, outline: hold.outline }),
    };
  }, [pulse, boardScale]);

  const pulseKey = pulse?.key ?? 0;
  const pulseKind = pulse?.kind ?? null;
  useEffect(() => {
    if (pulseKind == null) return;
    ringOpacitySV.value = 0;
    rippleOpacitySV.value = 0;
    haloOpacitySV.value = 0;
    if (pulseKind === 'undo') {
      if (reduceMotion) {
        haloScaleSV.value = 1;
        haloOpacitySV.value = withSequence(withTiming(1, INSTANT), withDelay(UNDO_PULSE_MS, withTiming(0, INSTANT)));
        return;
      }
      haloScaleSV.value = 1;
      haloScaleSV.value = withSequence(withTiming(1.15, { duration: 90 }), withTiming(1, { duration: 210 }));
      haloOpacitySV.value = withSequence(withTiming(1, { duration: 90 }), withTiming(0, { duration: 210 }));
      return;
    }
    // A tap already changed the ring layer; with Reduce Motion that is the whole answer.
    if (reduceMotion) return;
    if (pulseKind === 'toggleOn' || pulseKind === 'toggleOff') {
      ringScaleSV.value = 1.3;
      ringScaleSV.value = withSpring(1, springs.snappy);
      ringOpacitySV.value = 1;
      ringOpacitySV.value = withDelay(120, withTiming(0, { duration: 200 }));
      return;
    }
    ringScaleSV.value = 0.5;
    ringScaleSV.value = withSpring(1, springs.bouncy);
    ringOpacitySV.value = 1;
    ringOpacitySV.value = withDelay(380, withTiming(0, { duration: 200 }));
    rippleScaleSV.value = 1;
    rippleScaleSV.value = withTiming(RIPPLE_REACH, { duration: 450 });
    rippleOpacitySV.value = 0.8;
    rippleOpacitySV.value = withTiming(0, { duration: 450 });
    // `pulseKey` is the trigger: a new key replays even the same kind on the same hold.
  }, [
    pulseKey,
    pulseKind,
    reduceMotion,
    ringScaleSV,
    ringOpacitySV,
    rippleScaleSV,
    rippleOpacitySV,
    haloScaleSV,
    haloOpacitySV,
  ]);

  const ringStyle = useAnimatedStyle(() => ({
    opacity: ringOpacitySV.value,
    transform: [{ scale: ringScaleSV.value }],
  }));
  const rippleStyle = useAnimatedStyle(() => ({
    opacity: rippleOpacitySV.value,
    transform: [{ scale: rippleScaleSV.value }],
  }));
  const haloStyle = useAnimatedStyle(() => ({
    opacity: haloOpacitySV.value,
    transform: [{ scale: haloScaleSV.value }],
  }));

  if (!shape || !pulse) return null;

  const viewBox = `${-shape.extent} ${-shape.extent} ${shape.extent * 2} ${shape.extent * 2}`;
  const box = { left: shape.left, top: shape.top, width: shape.sizeRender, height: shape.sizeRender };

  return (
    <View pointerEvents="none" style={[styles.box, box]}>
      {pulse.kind === 'undo' ? (
        <Animated.View style={[StyleSheet.absoluteFill, haloStyle]}>
          <Svg width={shape.sizeRender} height={shape.sizeRender} viewBox={viewBox}>
            <Path
              d={shape.path}
              fill={HALO_VIOLET}
              fillOpacity={0.25}
              stroke={HALO_VIOLET}
              strokeWidth={STROKE.undoHalo / zoomStep}
              vectorEffect="non-scaling-stroke"
            />
          </Svg>
        </Animated.View>
      ) : (
        <>
          {pulse.kind === 'add' ? (
            <Animated.View style={[StyleSheet.absoluteFill, rippleStyle]}>
              <Svg width={shape.sizeRender} height={shape.sizeRender} viewBox={viewBox}>
                <Path
                  d={shape.path}
                  fill="none"
                  stroke={overlays.onScrim}
                  strokeWidth={STROKE.ripple / zoomStep}
                  vectorEffect="non-scaling-stroke"
                />
              </Svg>
            </Animated.View>
          ) : null}
          <Animated.View style={[StyleSheet.absoluteFill, ringStyle]}>
            <Svg width={shape.sizeRender} height={shape.sizeRender} viewBox={viewBox}>
              {pulse.kind === 'toggleOff' ? (
                // The OFF ghost, exactly as the ring layer draws it: switching a
                // hold off must never flash a solid ON ring.
                <Path
                  d={shape.path}
                  fill="none"
                  stroke={overlays.onScrim}
                  strokeOpacity={RING.offOpacity}
                  strokeWidth={RING.offWidth / zoomStep}
                  strokeDasharray={offDash}
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                />
              ) : (
                <>
                  <Path
                    d={shape.path}
                    fill="none"
                    stroke={overlays.scrim}
                    strokeWidth={STROKE.ringHalo / zoomStep}
                    vectorEffect="non-scaling-stroke"
                  />
                  <Path
                    d={shape.path}
                    fill="none"
                    stroke={overlays.onScrim}
                    strokeWidth={STROKE.ring / zoomStep}
                    vectorEffect="non-scaling-stroke"
                  />
                </>
              )}
            </Svg>
          </Animated.View>
        </>
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  box: {
    position: 'absolute',
  },
});
