// The frost a swipe on the wall button wipes in (#7113), from the trailing
// edge, over `progress` of the width. Transforms and opacity only, read from
// shared values, so the finger drives it on the UI thread with no React render
// per frame.
//
//   [💡   Put on board  ‹‹ (me)]          at rest
//   [💡   Put on board ░▒▓█████]          mid-drag: the frost's soft edge, then the frost
//
// Two opposite shifts keep the frost still while its window opens: the clip
// slides in from the trailing edge and the frost inside slides back. The frost
// has a soft edge, not a hard vertical cut: in its own base colour it fades in
// over 12 pt before the window's edge, and the holds' colours fade in over
// 12 pt after it.
//
// The button hands its row again as `children`, in the frost's label colour:
// clipped with the frost, the words read on the frost where it covers them and
// on the tonal pill where it doesn't.

import { memo, type ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated';
import { withAlpha } from '../../theme/colors';
import { WallGlow } from './WallGlow';
import type { WallGlowLayer } from './use-wall-glow';

/** The soft edge: how far the frost fades in on each side of the window's edge. */
export const WIPE_EDGE_FEATHER = 12;

type WallSwipeWipeProps = {
  progress: SharedValue<number>;
  /** The peek's fade under Reduce Motion; 1 otherwise. */
  opacity: SharedValue<number>;
  width: number;
  /** The climb's frost, or null for the flat amber (a climb with no holds). */
  layer: WallGlowLayer | null;
  /** The flat fill with no frost: the live amber. */
  fill: string;
  /** The button's row, in the colours it takes on the frost. */
  children?: ReactNode;
  /** The button's row layout (padding and gap), for `children`. */
  rowStyle?: StyleProp<ViewStyle>;
};

function WallSwipeWipeComponent({ progress, opacity, width, layer, fill, children, rowStyle }: WallSwipeWipeProps) {
  const edgeColor = layer ? layer.surface.base : fill;
  const clear = withAlpha(edgeColor, 0);
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
          { experimental_backgroundImage: `linear-gradient(to right, ${clear} 0%, ${edgeColor} 100%)` },
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
          {layer ? <WallGlow layer={layer} width={width} /> : <View style={[styles.fill, { backgroundColor: fill }]} />}
        </Animated.View>
        {layer ? (
          <View
            style={[
              styles.edge,
              { experimental_backgroundImage: `linear-gradient(to right, ${edgeColor} 0%, ${clear} 100%)` },
            ]}
          />
        ) : null}
        {children ? (
          <Animated.View style={[styles.content, { width }, rowStyle, contentStyle]}>{children}</Animated.View>
        ) : null}
      </Animated.View>
    </>
  );
}

export const WallSwipeWipe = memo(WallSwipeWipeComponent);

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
