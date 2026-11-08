import type { ReactNode } from 'react';
import { StyleSheet } from 'react-native';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import { tabBarHiddenProgress } from '../../lib/tab-bar-hide-progress';
import { MATERIAL_TAB_BAR_HEIGHT } from '../../theme/layout';

type TabBarHideFollowerProps = {
  children: ReactNode;
  /**
   * The child's own z rung (zIndex and elevation). A z value only ranks among
   * siblings, so it has to sit on this wrapper, the child's new root sibling.
   */
  zIndex?: number;
};

/**
 * Moves floating chrome down with the Android nav bar as it hides on scroll, by
 * the bar's 64dp, so the MiniPlayer card, the rest pill, the connectivity banner,
 * the Discover create button, the Start button, snackbars and toasts keep their
 * gaps above it.
 *
 * A full-size, touch-transparent layer over the same parent: its children keep
 * the `bottom` they already compute from the bottom-chrome metrics, which stay
 * at the shown bar. Only a transform moves, never `bottom` or layout. The value
 * stays 0 everywhere the bar cannot hide, so this is inert there. iOS and the
 * web use `TabBarHideFollower.tsx`, which renders its children as they are.
 */
export function TabBarHideFollower({ children, zIndex }: TabBarHideFollowerProps) {
  const followStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: tabBarHiddenProgress.value * MATERIAL_TAB_BAR_HEIGHT }],
  }));
  return (
    <Animated.View
      pointerEvents="box-none"
      style={[StyleSheet.absoluteFill, zIndex === undefined ? null : { zIndex, elevation: zIndex }, followStyle]}
    >
      {children}
    </Animated.View>
  );
}
