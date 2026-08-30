// Shared props for the platform-split Button. The implementation is split across
// Button.ios.tsx (native @expo/ui SwiftUI Button — Liquid Glass) and
// Button.android.tsx (native @expo/ui Jetpack Compose Button family — Material 3).
// The split keeps each platform's @expo/ui native tree — which resolves native
// views at module load — off the other platform's bundle. The public API is
// identical to the previous react-native-paper / PressableSurface implementation,
// so every one of the ~28 call sites is unchanged unless it opts into a new prop.

import type { ViewStyle } from 'react-native';
import type { IconName } from './icon-map';

export type ButtonVariant = 'filled' | 'outlined' | 'text' | 'tonal';
export type ButtonSize = 'small' | 'medium' | 'large';

/**
 * The background the button sits on. Defaults to the nearest
 * `ButtonSurfaceProvider` ('surface' — an opaque sheet/card). A region that draws
 * buttons OVER board art / a scrim declares `content`, which makes the
 * middle/low-emphasis tiers drop their translucent Liquid Glass for a solid,
 * legible capsule. The filled CTA is solid on EVERY surface, so it never depends
 * on this.
 */
export type ButtonSurface = 'surface' | 'content';

/**
 * Native semantic role. `destructive` paints the system red and adds the
 * destructive VoiceOver trait (iOS) / error tokens (Android); `cancel` gets iOS
 * cancel semantics (no Android visual change). Mirrors SwiftUI's `ButtonRole`.
 */
export type ButtonRole = 'default' | 'destructive' | 'cancel';

export type ButtonProps = {
  title: string;
  onPress: () => void;
  accessibilityLabel?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName;
  disabled?: boolean;
  loading?: boolean;
  haptic?: boolean;
  tintColor?: string;
  /**
   * Floor for the button's height, in dp. iOS already floors every button at the
   * 44pt target; Compose derives its height from `contentPadding` alone, so a
   * `small` filled button lands at 40 there. Pass this where the button sits in a
   * row of 44dp controls and must not be the one under the touch floor.
   */
  minHeight?: number;
  /** See {@link ButtonSurface}. Per-button override of the surrounding provider. */
  over?: ButtonSurface;
  /** See {@link ButtonRole}. */
  role?: ButtonRole;
  /** Native test identifier (used by Maestro screenshot flows). */
  testID?: string;
  style?: ViewStyle;
};

/**
 * Padding + font + icon sizing per size step. iOS derives the button size from
 * `controlSize` + a Dynamic-Type `textStyle`; Android maps the padding onto
 * Compose `contentPadding` (Compose has no discrete height buckets — the same
 * single-height approximation react-native-paper used). Kept as one table so the
 * two platforms can't drift on the small/medium/large ladder.
 */
export const sizeConfig = {
  small: { paddingHorizontal: 12, paddingVertical: 6, fontSize: 14, iconSize: 16 },
  medium: { paddingHorizontal: 16, paddingVertical: 10, fontSize: 16, iconSize: 20 },
  large: { paddingHorizontal: 20, paddingVertical: 14, fontSize: 17, iconSize: 22 },
} as const;
