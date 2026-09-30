import React, { useEffect, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';
import { brandColorsDark } from '../../theme/colors';
import { holdRole, type SprayEditorHold } from './spray-hold-editor-reducer';
import { holdPathData } from './spray-hold-path';
import { useZoomStrokeStep } from './SprayHoldSvgLayer';

/** The sweep's run down the wall. */
export const PUBLISH_SWEEP_MS = 450;
/** The fade once it has reached the bottom. */
const SWEEP_FADE_MS = 200;
/** Stroke widths in screen points at 1x, divided by the zoom step like every ring. */
const STROKE = { line: 3, glow: 8 } as const;
const SWEEP_VIOLET = brandColorsDark.primary;

type SprayPublishSweepProps = {
  holds: readonly SprayEditorHold[];
  scaleSV: SharedValue<number>;
  boardWidth: number;
  boardHeight: number;
  renderWidth: number;
  renderHeight: number;
};

/**
 * The publish moment: every ON ring turns violet in one sweep from the top of
 * the wall to the bottom, then fades.
 *
 * Mounted only for the celebration. The ON rings are one path (two with the
 * glow), drawn once; the sweep is the height of one clipping view, animated on
 * the UI thread, so nothing re-renders while it runs. Reduce Motion never
 * mounts it: the capsule's checkmark carries the moment alone.
 */
export const SprayPublishSweep = React.memo(function SprayPublishSweep({
  holds,
  scaleSV,
  boardWidth,
  boardHeight,
  renderWidth,
  renderHeight,
}: SprayPublishSweepProps) {
  const zoomStep = useZoomStrokeStep(scaleSV);
  const progressSV = useSharedValue(0);
  const opacitySV = useSharedValue(1);

  const onPath = useMemo(() => {
    let path = '';
    for (const hold of holds) {
      if (holdRole(hold) === 'on') path += holdPathData(hold);
    }
    return path;
  }, [holds]);

  useEffect(() => {
    progressSV.value = withTiming(1, { duration: PUBLISH_SWEEP_MS, easing: Easing.out(Easing.cubic) });
    opacitySV.value = withDelay(PUBLISH_SWEEP_MS, withTiming(0, { duration: SWEEP_FADE_MS }));
  }, [progressSV, opacitySV]);

  const clipStyle = useAnimatedStyle(
    () => ({ height: progressSV.value * renderHeight, opacity: opacitySV.value }),
    [renderHeight],
  );

  if (renderWidth <= 0 || renderHeight <= 0 || !onPath) return null;

  return (
    <Animated.View pointerEvents="none" style={[styles.clip, { width: renderWidth }, clipStyle]}>
      <View style={{ width: renderWidth, height: renderHeight }}>
        <Svg width={renderWidth} height={renderHeight} viewBox={`0 0 ${boardWidth} ${boardHeight}`}>
          <Path
            d={onPath}
            fill="none"
            stroke={SWEEP_VIOLET}
            strokeOpacity={0.35}
            strokeWidth={STROKE.glow / zoomStep}
            vectorEffect="non-scaling-stroke"
          />
          <Path
            d={onPath}
            fill="none"
            stroke={SWEEP_VIOLET}
            strokeWidth={STROKE.line / zoomStep}
            vectorEffect="non-scaling-stroke"
          />
        </Svg>
      </View>
    </Animated.View>
  );
});

const styles = StyleSheet.create({
  clip: {
    position: 'absolute',
    left: 0,
    top: 0,
    overflow: 'hidden',
  },
});
