import { Platform } from 'react-native';

/**
 * Shared stack header defaults for the Liquid Glass look. Applied as a stack's
 * `screenOptions` so every pushed child screen matches the root tabs:
 *
 * - A transparent header on iOS (the list/scroll view insets content below it via
 *   `contentInsetAdjustmentBehavior="automatic"`). On Android that prop is a no-op
 *   and, under mandatory edge-to-edge, a transparent header draws content under
 *   the status bar — so Android keeps a solid header.
 * - A chevron-only back button (`minimal`), not the default "< previous title".
 *
 * No `headerBlurEffect` here: it depends on the device (iOS 26 owns the scroll edge
 * material, older iOS needs the legacy blur), so every consumer adds
 * `useHeaderBlurEffect()` from `src/hooks/use-header-blur-effect.ts`.
 *
 * Per-field `as const` keeps the string enum assignable to the native-stack
 * option types without importing them; `contentStyle` stays a plain object so it
 * remains assignable to `StyleProp<ViewStyle>`.
 */
export const glassStackScreenOptions = {
  headerLargeTitle: false,
  headerTransparent: Platform.OS === 'ios',
  headerBackButtonDisplayMode: 'minimal' as const,
  contentStyle: { backgroundColor: 'transparent' },
};
