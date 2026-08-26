import React, { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';
import { Svg, Line, Path, Text as SvgText } from 'react-native-svg';
import Animated, { useSharedValue, useAnimatedProps, withSpring } from 'react-native-reanimated';
import { useTheme } from '../../providers/theme-provider';
import { getAngleArcSweepFlag } from './angle-board-diagram-geometry';

type AngleBoardDiagramProps = {
  angle: number;
  size?: number;
  accessibilityLabel?: string;
};

// The board edge is a single <Line> whose far endpoint (x2/y2) we animate.
// Animating the numeric endpoints (rather than an SVG `transform` string) keeps
// us on react-native-svg's plain prop path: reanimated only special-cases
// `transform`/`transformOrigin`/colour props in its UI-thread prop updater, and
// its transform processor only understands single-argument RN transforms — it
// throws on SVG's three-argument `rotate(deg, cx, cy)`. Driving x2/y2 sidesteps
// that entirely and still rotates about the fixed pivot (x1/y1).
const AnimatedLine = Animated.createAnimatedComponent(Line);

/**
 * Visual teaching diagram for board angle (GitHub issue #1846).
 *
 * Angle is measured FROM VERTICAL: 0° is a vertical wall, larger values tilt
 * the board back (more overhung). The diagram fixes a dashed vertical reference
 * line and pivots a solid board edge away from it by `angle` degrees, with a
 * small arc and the numeric value spanning the gap between the two.
 *
 * The board-edge rotation is driven by a `useSharedValue(angle)` that a
 * `useEffect` animates whenever `angle` changes, read back through
 * `useAnimatedProps` on an Animated <Line>. Keeping the value-driven structure
 * lets a future PR attach a `Gesture.Pan()` to drag the board by writing the
 * same shared value, without restructuring this component.
 */
export function AngleBoardDiagram({
  angle,
  size = 160,
  accessibilityLabel,
}: AngleBoardDiagramProps): React.JSX.Element {
  const { systemColors, brandColors, springs } = useTheme();

  // Read reduce-motion once; default false so first paint animates normally on
  // devices where the (async) query hasn't resolved yet.
  const [reduceMotion, setReduceMotion] = useState(false);
  useEffect(() => {
    let cancelled = false;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((enabled) => {
        if (!cancelled) setReduceMotion(enabled);
      })
      .catch(() => {
        // Query can reject if the bridge is unavailable; stay on the default.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // The live rotation in degrees. Seeded at `angle` so the first paint matches
  // the prop without an intro animation.
  const rotation = useSharedValue(angle);
  useEffect(() => {
    if (reduceMotion) {
      rotation.value = angle;
      return;
    }
    rotation.value = withSpring(angle, springs.gentle);
  }, [angle, reduceMotion, rotation, springs.gentle]);

  // Geometry — pivot near the bottom. Board angles run -5–70°; at 70° a centred
  // pivot would push the board-edge tip off the right of the viewBox, so the
  // pivot sits left of centre and the arm is short enough that the worst-case
  // reach (sin(70°)·armLength) plus the label stays inside `size`.
  const pivotX = size * 0.3;
  const pivotY = size * 0.85;
  const armLength = size * 0.62;
  const verticalTipY = pivotY - armLength;

  // Static target positions for the arc + label, computed from the prop so the
  // numeric readout always reflects the requested angle even mid-animation.
  const radians = (angle * Math.PI) / 180;
  const arcRadius = armLength * 0.4;
  // Arc sweeps from the vertical reference to the board edge.
  const arcStartX = pivotX;
  const arcStartY = pivotY - arcRadius;
  const arcEndX = pivotX + Math.sin(radians) * arcRadius;
  const arcEndY = pivotY - Math.cos(radians) * arcRadius;
  // Arc spans <180° for every supported angle, so the large-arc flag is 0.
  // Slab angles sweep left/counter-clockwise; overhangs sweep right/clockwise.
  const arcSweepFlag = getAngleArcSweepFlag(angle);
  const arcPath = `M ${arcStartX} ${arcStartY} A ${arcRadius} ${arcRadius} 0 0 ${arcSweepFlag} ${arcEndX} ${arcEndY}`;

  // Label sits just outside the arc, bisecting the angle.
  const labelRadians = radians / 2;
  const labelDistance = arcRadius + size * 0.14;
  const labelX = pivotX + Math.sin(labelRadians) * labelDistance;
  const labelY = pivotY - Math.cos(labelRadians) * labelDistance;
  const fontSize = Math.max(11, size * 0.12);

  // Animate the board-edge endpoint. 0° points straight up (vertical wall);
  // larger angles tilt the tip right and down (overhung), pivoting about
  // (pivotX, pivotY). A future Gesture.Pan() can write `rotation` directly.
  const animatedBoardProps = useAnimatedProps(() => {
    'worklet';
    const rad = (rotation.value * Math.PI) / 180;
    return {
      x2: pivotX + Math.sin(rad) * armLength,
      y2: pivotY - Math.cos(rad) * armLength,
    };
  });

  return (
    <Svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      accessibilityRole="image"
      accessibilityLabel={accessibilityLabel}
    >
      {/* Dashed vertical reference (0° = vertical wall). */}
      <Line
        x1={pivotX}
        y1={pivotY}
        x2={pivotX}
        y2={verticalTipY}
        stroke={systemColors.separator}
        strokeWidth={1.5}
        strokeDasharray="4 4"
        strokeLinecap="round"
      />

      {/* Arc between the vertical reference and the board edge. */}
      <Path d={arcPath} stroke={systemColors.secondaryLabel} strokeWidth={1.5} fill="none" strokeLinecap="round" />

      {/* Numeric angle readout. */}
      <SvgText
        x={labelX}
        y={labelY}
        fill={systemColors.label}
        fontSize={fontSize}
        fontWeight="600"
        textAnchor="middle"
        alignmentBaseline="middle"
      >
        {`${Math.round(angle)}°`}
      </SvgText>

      {/* Board edge — the only animated element. Its far endpoint sweeps about
          the fixed pivot (x1/y1) so a future Gesture.Pan() can drive `rotation`. */}
      <AnimatedLine
        x1={pivotX}
        y1={pivotY}
        animatedProps={animatedBoardProps}
        stroke={brandColors.tint}
        strokeWidth={3.5}
        strokeLinecap="round"
      />
    </Svg>
  );
}
