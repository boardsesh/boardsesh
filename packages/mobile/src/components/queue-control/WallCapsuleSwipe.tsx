import type { ReactNode } from 'react';
import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated from 'react-native-reanimated';
import type { useWallCapsuleDismiss } from './use-wall-capsule-dismiss';

type WallCapsuleSwipeProps = {
  /** From `useWallCapsuleDismiss`: the pan, its slide and the width it reads. */
  swipe: Pick<ReturnType<typeof useWallCapsuleDismiss>, 'gesture' | 'animatedStyle' | 'onLayout'>;
  /** Extra sizing, e.g. the Material band's full width. */
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
};

/**
 * A left swipe hides a header capsule: the only sighted Hide, since the capsules
 * carry no × (#7281). A native title view is reparented into UIKit's bar, so the
 * capsule gets its own bounded gesture root, which keeps swipes working there
 * without making the intrinsic title fill the width.
 */
export function WallCapsuleSwipe({ swipe, style, children }: WallCapsuleSwipeProps) {
  const containerStyle = [styles.container, style];
  return (
    <GestureHandlerRootView style={containerStyle}>
      <GestureDetector gesture={swipe.gesture} touchAction="pan-y">
        <Animated.View style={[containerStyle, swipe.animatedStyle]} onLayout={swipe.onLayout}>
          {children}
        </Animated.View>
      </GestureDetector>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  container: {
    flexShrink: 1,
    minWidth: 0,
    maxWidth: '100%',
  },
});
