import { Easing, type WithTimingConfig } from 'react-native-reanimated';
import type { MotionConfig } from './animations';

/**
 * Turn a (pure-data) `MotionConfig` from `theme.motion` into a reanimated
 * `withTiming` config, constructing the M3 `Easing.bezier` curve here so the token
 * modules (`animations.ts`, the theme, `makeThemeMock`) stay reanimated-free. Liquid
 * Glass configs carry no curve, so they fall through to reanimated's default ease.
 *
 *   animatedValue.value = withTiming(target, timingFor(theme.motion.emphasized));
 */
export function timingFor(config: MotionConfig): WithTimingConfig {
  if (!config.easingBezier) {
    return { duration: config.duration };
  }
  const [x1, y1, x2, y2] = config.easingBezier;
  return { duration: config.duration, easing: Easing.bezier(x1, y1, x2, y2) };
}
