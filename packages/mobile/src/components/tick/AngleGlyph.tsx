// The tick sheets' angle glyph: a 24pt cut of AngleBoardDiagram, sitting in
// front of the angle readout. A dashed vertical reference and a board edge that
// leans away from it by the picked angle, so "40°" reads as a wall rather than a
// bare number — the climber sees how steep, not just how many degrees.
//
// Decoration only. The slider (or the segments) beside it already speaks the
// angle, so the glyph is hidden from screen readers rather than read twice.
// Never mirrored for RTL: it draws a physical wall, which leans the same way in
// every language.
import React, { useEffect } from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import { Svg, Line } from 'react-native-svg';
import Animated, { useAnimatedProps, useSharedValue, withSpring } from 'react-native-reanimated';
import { useTheme } from '../../providers/theme-provider';
import { useReduceMotion } from '../../hooks/use-reduce-motion';
import { brandControlTint } from '../../theme/expo-ui-modifiers';
import { angleGlyphTip } from '../play-drawer/angle-board-diagram-geometry';

// Same reason as AngleBoardDiagram: animate the edge's x2/y2 rather than an SVG
// `rotate(deg, cx, cy)` transform, which reanimated's transform processor throws on.
const AnimatedLine = Animated.createAnimatedComponent(Line);

/** The glyph's drawing box, in viewBox units; the rendered size scales from it. */
const GLYPH_BOX = 24;
/** Never grows past this many times GLYPH_BOX, however large the OS text gets:
 *  past 36pt it would outweigh the number it labels. */
const GLYPH_MAX_SCALE = 1.5;
/** The hinge sits low and left so a 70° overhang still lands inside the box. */
const PIVOT = { x: 7, y: 21 };
/** Long enough to read as a wall, short enough that -5° and 70° keep their
 *  round caps inside the box (asserted in angle-board-diagram-geometry.test). */
const ARM = 16;
const REFERENCE_TIP = angleGlyphTip(0, PIVOT, ARM);

type AngleGlyphProps = {
  angle: number;
};

export const AngleGlyph = React.memo(function AngleGlyph({ angle }: AngleGlyphProps) {
  const { systemColors, brandColors, springs } = useTheme();
  const reduceMotion = useReduceMotion();
  // Grows with the OS text size, like the number beside it, up to the cap.
  const { fontScale } = useWindowDimensions();
  const size = Math.round(GLYPH_BOX * Math.min(Math.max(fontScale, 1), GLYPH_MAX_SCALE));

  // Seeded at the prop, so the glyph opens at the tick's angle without an intro swing.
  const rotation = useSharedValue(angle);
  useEffect(() => {
    if (reduceMotion) {
      rotation.value = angle;
      return;
    }
    // Snappy, not AngleBoardDiagram's gentle: the edge follows a slider thumb
    // stop by stop and has to keep up with it.
    rotation.value = withSpring(angle, springs.snappy);
  }, [angle, reduceMotion, rotation, springs.snappy]);

  const animatedEdgeProps = useAnimatedProps(() => {
    'worklet';
    // Inlined rather than calling angleGlyphTip: a plain JS function can't run
    // on the UI thread.
    const radians = (rotation.value * Math.PI) / 180;
    return {
      x2: PIVOT.x + Math.sin(radians) * ARM,
      y2: PIVOT.y - Math.cos(radians) * ARM,
    };
  });

  return (
    <View
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
      style={[styles.box, { width: size, height: size }]}
    >
      <Svg width={size} height={size} viewBox={`0 0 ${GLYPH_BOX} ${GLYPH_BOX}`}>
        {/* Vertical reference (0° = a vertical wall). `secondaryLabel`, not
            `tertiaryLabel`: the latter is under 3:1 on the opaque sheet. */}
        <Line
          x1={PIVOT.x}
          y1={PIVOT.y}
          x2={REFERENCE_TIP.x}
          y2={REFERENCE_TIP.y}
          stroke={systemColors.secondaryLabel}
          strokeWidth={1.5}
          strokeDasharray="2 2.5"
          strokeLinecap="butt"
        />
        {/* The board edge — the control tint, since it moves with the control. */}
        <AnimatedLine
          x1={PIVOT.x}
          y1={PIVOT.y}
          animatedProps={animatedEdgeProps}
          stroke={brandControlTint(brandColors)}
          strokeWidth={2.5}
          strokeLinecap="round"
        />
      </Svg>
    </View>
  );
});

const styles = StyleSheet.create({
  box: {
    flexShrink: 0,
  },
});
