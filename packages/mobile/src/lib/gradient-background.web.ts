import type { ViewStyle } from 'react-native';

/** React Native Web 0.21 does not map experimental_backgroundImage to CSS. */
export function gradientBackground(gradient: string): ViewStyle & { backgroundImage: string } {
  return { backgroundImage: gradient };
}
