import { Platform } from 'react-native';

/**
 * Shared stack header defaults for the Liquid Glass look. Applied as a stack's
 * `screenOptions` so every pushed child screen matches the root tabs:
 *
 * - A transparent blur header on iOS (the list/scroll view insets content below
 *   it via `contentInsetAdjustmentBehavior="automatic"`). On Android that prop
 *   is a no-op and, under mandatory edge-to-edge, a transparent header draws
 *   content under the status bar — so Android keeps a solid header.
 * - A chevron-only back button (`minimal`), not the default "< previous title".
 *
 * Per-field `as const` keeps the two string enums assignable to the native-stack
 * option types without importing them; `contentStyle` stays a plain object so it
 * remains assignable to `StyleProp<ViewStyle>`.
 */
export const glassStackScreenOptions = {
  headerLargeTitle: false,
  headerTransparent: Platform.OS === 'ios',
  headerBlurEffect: 'systemMaterial' as const,
  headerBackButtonDisplayMode: 'minimal' as const,
  contentStyle: { backgroundColor: 'transparent' },
};
