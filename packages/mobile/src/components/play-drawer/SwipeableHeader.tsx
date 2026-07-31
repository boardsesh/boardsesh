import { memo, type ReactNode } from 'react';
import { View, StyleSheet } from 'react-native';
import Animated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated';
import { computePeekOffset, type PeekDirection } from '@boardsesh/play-view';

type SwipeableHeaderProps = {
  /** The carousel's swipe offset — the header rides the EXACT same value as the
   *  board, so the title/grade slide in lockstep with the climb. */
  swipeTranslateX: SharedValue<number>;
  /** The header's own width (screen width). The current header flings past this
   *  and the peek slides in by it, so each clears the viewport. */
  viewportWidth: number;
  /** The current climb's header. */
  current: ReactNode;
  /** The climb being swiped toward (next/prev), sliding in edge-adjacent from the
   *  swipe direction. Null at a queue boundary. */
  peek: ReactNode;
};

/**
 * Wraps the play-drawer's title + grade so they swipe with the board: the current
 * header slides horizontally off the same `swipeTranslateX` as the board, and the
 * next climb's header slides in edge-adjacent via `computePeekOffset`. Off at rest
 * (peek off-screen, current centred), so it's invisible until a swipe.
 */
export const SwipeableHeader = memo(function SwipeableHeader({
  swipeTranslateX,
  viewportWidth,
  current,
  peek,
}: SwipeableHeaderProps) {
  const currentStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: swipeTranslateX.value }],
  }));

  const peekStyle = useAnimatedStyle(() => {
    const tx = swipeTranslateX.value;
    if (tx === 0) {
      return { opacity: 0, transform: [{ translateX: viewportWidth }] };
    }
    const direction: PeekDirection = tx < 0 ? 'next' : 'prev';
    return {
      opacity: 1,
      transform: [{ translateX: computePeekOffset({ direction, swipeOffset: tx, viewportWidth }) }],
    };
  });

  return (
    <View style={styles.container}>
      <Animated.View
        style={[styles.peekLayer, peekStyle]}
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        {peek}
      </Animated.View>
      <Animated.View style={[styles.currentLayer, currentStyle]}>{current}</Animated.View>
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    position: 'relative',
  },
  // Above the peek so the current title is the top card; in normal flow so it
  // defines the header's height.
  currentLayer: {
    zIndex: 1,
  },
  // Pinned over the header slot, below the current card. Off-screen at rest.
  peekLayer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 0,
  },
});
