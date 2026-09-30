import { useEffect, useRef } from 'react';
import { Animated, StyleSheet } from 'react-native';

type LedDotProps = {
  color: string;
  /** 6 in pills and badges, 8 in buttons and toasts. */
  size?: number;
  glow?: boolean;
  /** Breathes while something is in progress, like a Bluetooth scan. */
  pulse?: boolean;
};

/** A small status light. LED dots are interface elements, not icons. */
export function LedDot({ color, size = 6, glow = true, pulse = false }: LedDotProps) {
  const opacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (!pulse) {
      opacity.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.3, duration: 700, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 700, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse, opacity]);

  return (
    <Animated.View
      style={[
        styles.dot,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: color,
          shadowColor: color,
          shadowOpacity: glow ? 0.75 : 0,
          shadowRadius: size,
          opacity,
        },
      ]}
    />
  );
}

const styles = StyleSheet.create({
  dot: { shadowOffset: { width: 0, height: 0 } },
});
