// The cover over the status bar once the play drawer scrolls.
//
// The drawer's scroll container fills the whole window, so its content passes
// under the clock and the Dynamic Island as soon as it moves. This strip, the
// height of the top inset, covers it. It fades in over the first few points of
// scroll, so at rest the glass behind the header is untouched.

import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { Extrapolation, interpolate, useAnimatedStyle, type SharedValue } from 'react-native-reanimated';
import { useTheme } from '../../providers/theme-provider';
import { playDrawerMaterialTint } from '../../theme/colors';

// Scroll distance over which the cover goes from clear to solid.
const FADE_DISTANCE_PT = 12;

type PlayDrawerStatusBarScrimProps = {
  /** The top safe-area inset the strip covers. */
  height: number;
  /** The drawer's scroll offset, written by its onScroll. */
  scrollY: SharedValue<number>;
};

function PlayDrawerStatusBarScrimComponent({ height, scrollY }: PlayDrawerStatusBarScrimProps) {
  const { systemColors, colorScheme } = useTheme();
  const fadeStyle = useAnimatedStyle(() => ({
    opacity: interpolate(scrollY.value, [0, FADE_DISTANCE_PT], [0, 1], Extrapolation.CLAMP),
  }));

  // The route's backstop colour under the drawer's material tint (app/play.tsx
  // paints the same pair behind the whole drawer), so the strip matches the
  // surface instead of reading as a grey band. A plain tint, not a second
  // GlassSurface: Liquid Glass in a strip this short renders clear.
  return (
    <Animated.View
      pointerEvents="none"
      style={[styles.scrim, { height, backgroundColor: systemColors.secondaryBackground }, fadeStyle]}
    >
      <View style={[StyleSheet.absoluteFill, { backgroundColor: playDrawerMaterialTint[colorScheme] }]} />
    </Animated.View>
  );
}

export const PlayDrawerStatusBarScrim = memo(PlayDrawerStatusBarScrimComponent);

const styles = StyleSheet.create({
  scrim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
  },
});
