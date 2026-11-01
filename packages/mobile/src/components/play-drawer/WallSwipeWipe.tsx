// Flat swipe progress from the trailing edge, with a 12 pt feather and a
// readable copy of the button's row. Shared-value transforms and opacity keep
// dragging on the UI thread without a React render per frame. Driving frost
// belongs to the button after the swipe succeeds.

import type { ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated';
import { withAlpha } from '../../theme/colors';

/** How far the flat fill fades in before the window's edge. */
export const WIPE_EDGE_FEATHER = 12;

type WallSwipeWipeProps = {
  progress: SharedValue<number>;
  /** The peek's fade under Reduce Motion; 1 otherwise. */
  opacity: SharedValue<number>;
  width: number;
  /** The flat fill with no frost: the live amber. */
  fill: string;
  /** The button's row, in the colours it takes on the flat fill. */
  children?: ReactNode;
  /** The button's row layout (padding and gap), for `children`. */
  rowStyle?: StyleProp<ViewStyle>;
};

// Not memoised: the button hands it a fresh copy of its row on every render.
export function WallSwipeWipe({ progress, opacity, width, fill, children, rowStyle }: WallSwipeWipeProps) {
  const clear = withAlpha(fill, 0);
  const clipStyle = useAnimatedStyle(() => ({
    opacity: progress.value > 0 ? opacity.value : 0,
    transform: [{ translateX: width * (1 - progress.value) }],
  }));
  const contentStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: -width * (1 - progress.value) }],
  }));
  const outerEdgeStyle = useAnimatedStyle(() => ({
    opacity: progress.value > 0 ? opacity.value : 0,
    transform: [{ translateX: width * (1 - progress.value) - WIPE_EDGE_FEATHER }],
  }));
  return (
    <>
      <Animated.View
        pointerEvents="none"
        style={[
          styles.edge,
          { experimental_backgroundImage: `linear-gradient(to right, ${clear} 0%, ${fill} 100%)` },
          outerEdgeStyle,
        ]}
        testID="play-drawer-wall-control-wipe-edge"
      />
      <Animated.View
        pointerEvents="none"
        style={[styles.fill, styles.clip, clipStyle]}
        // The row's copy is drawing only: the button itself speaks.
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        testID="play-drawer-wall-control-wipe"
      >
        <Animated.View style={[styles.content, { width }, contentStyle]}>
          <View style={[styles.fill, { backgroundColor: fill }]} />
        </Animated.View>
        {children ? (
          <Animated.View style={[styles.content, { width }, rowStyle, contentStyle]}>{children}</Animated.View>
        ) : null}
      </Animated.View>
    </>
  );
}

const styles = StyleSheet.create({
  fill: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
  },
  clip: {
    overflow: 'hidden',
  },
  content: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
  },
  edge: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    width: WIPE_EDGE_FEATHER,
  },
});
