import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, ScrollView, StyleSheet } from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';
import { Text, type TextProps } from './Text';

const PAUSE_MS = 1600;
const POINTS_PER_SECOND = 32;

type MarqueeProps = Pick<TextProps, 'variant' | 'tone' | 'color'> & { children: string };

/**
 * One line of text that stays one line. When it doesn't fit, it slides across
 * to show the end, rests, and slides back. With Reduce Motion on it just
 * trails off instead.
 */
export function Marquee({ children, ...textProps }: MarqueeProps) {
  const reduceMotion = useReducedMotion();
  const [boxWidth, setBoxWidth] = useState(0);
  const [textWidth, setTextWidth] = useState(0);
  const offset = useRef(new Animated.Value(0)).current;
  const overflow = boxWidth > 0 ? Math.max(0, Math.ceil(textWidth - boxWidth)) : 0;

  useEffect(() => {
    offset.setValue(0);
    if (overflow === 0 || reduceMotion) return;
    const duration = (overflow / POINTS_PER_SECOND) * 1000;
    const slide = (toValue: number) =>
      Animated.timing(offset, { toValue, duration, easing: Easing.inOut(Easing.quad), useNativeDriver: true });
    const loop = Animated.loop(
      Animated.sequence([Animated.delay(PAUSE_MS), slide(-overflow), Animated.delay(PAUSE_MS), slide(0)]),
    );
    loop.start();
    return () => loop.stop();
  }, [overflow, reduceMotion, children]);

  if (reduceMotion) {
    return (
      <Text {...textProps} numberOfLines={1} style={styles.box}>
        {children}
      </Text>
    );
  }

  return (
    // A scroll view lets the text run past the edge at its full width; it's
    // never scrolled by hand, only slid.
    <ScrollView
      horizontal
      scrollEnabled={false}
      showsHorizontalScrollIndicator={false}
      style={styles.box}
      onLayout={(event) => setBoxWidth(event.nativeEvent.layout.width)}
      accessible
      accessibilityRole="header"
      accessibilityLabel={children}
    >
      <Animated.View
        style={{ transform: [{ translateX: offset }] }}
        onLayout={(event) => setTextWidth(event.nativeEvent.layout.width)}
      >
        <Text {...textProps} numberOfLines={1}>
          {children}
        </Text>
      </Animated.View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  box: { flex: 1, minWidth: 0 },
});
