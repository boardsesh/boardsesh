import type { ViewStyle } from 'react-native';

/** Native gradients; the browser twin uses the CSS property React Native Web supports. */
export function gradientBackground(gradient: string): ViewStyle {
  return { experimental_backgroundImage: gradient };
}
