// Button — iOS implementation, real SwiftUI via @expo/ui/swift-ui.
//
// One SwiftUI `Button` inside its own `Host`. The emphasis tier picks the native
// button style:
//   filled       → borderedProminent + brand tint. SOLID violet on EVERY surface
//                  and EVERY iOS version — the brand CTA never goes translucent, so
//                  it can't wash out over board art or in near-black dark mode, and
//                  it never touches the iOS-26 `#available` glass gate.
//   outlined/    → glass-as-guest: a neutral Liquid Glass capsule on an opaque
//   tonal          surface on iOS 26 (`buttonStyle('glass')`); an EXPLICIT
//                  `bordered` fallback on iOS < 26 (we branch on
//                  `useGlassCapability()` rather than trusting @expo/ui's implicit
//                  glass→`.automatic` degradation, which is a borderless/plain
//                  button, not a solid); and a solid dark-scrim capsule when the
//                  surrounding region declares `over="content"` (board art).
//                  `tonal` aliases `outlined` on iOS (HIG has no tonal idiom).
//   text         → borderless, accent-tinted label.
//
// The native control supplies press feedback, the ≥44pt tap target (floored via
// `frame`), disabled dimming, and the destructive/cancel role + VoiceOver traits.
// We bridge only the brand accent (`expo-ui-modifiers`). `loading` has no native
// equivalent, so it swaps the leading icon for an indeterminate `ProgressView` and
// disables the button. The press/haptic guard lives in Button.logic.ts.

import { Button as SwiftUIButton, HStack, Image, ProgressView, Text } from '@expo/ui/swift-ui';
import {
  accessibilityLabel as accessibilityLabelModifier,
  buttonBorderShape,
  buttonStyle,
  controlSize,
  disabled as disabledModifier,
  font,
  foregroundStyle,
  frame,
  tint,
  type ModifierConfig,
} from '@expo/ui/swift-ui/modifiers';
import { useGlassCapability } from '../hooks/use-glass-capability';
import { useTheme } from '../providers/theme-provider';
import { ThemedHost } from './ThemedHost';
import { brandAccentColor } from '../theme/expo-ui-modifiers';
import { overlays } from '../theme/tokens';
import { isFullWidthStyle, makeButtonPressHandler } from './Button.logic';
import { useButtonSurface } from './Button.surface';
import { iconMap } from './icon-map';
import type { ButtonProps, ButtonSize } from './Button.types';

const CONTROL_SIZE: Record<ButtonSize, 'small' | 'regular' | 'large'> = {
  small: 'small',
  medium: 'regular',
  large: 'large',
};

const TEXT_STYLE: Record<ButtonSize, 'footnote' | 'callout' | 'body'> = {
  small: 'footnote',
  medium: 'callout',
  large: 'body',
};

export function Button({
  title,
  onPress,
  accessibilityLabel,
  variant = 'filled',
  size = 'medium',
  icon,
  disabled = false,
  loading = false,
  haptic = true,
  tintColor,
  minHeight = 44,
  over,
  role = 'default',
  testID,
  style,
}: ButtonProps) {
  const { brandColors, radii } = useTheme();
  const supportsGlass = useGlassCapability();
  const surfaceFromContext = useButtonSurface();
  const effectiveOver = over ?? surfaceFromContext;

  const handlePress = makeButtonPressHandler({ onPress, disabled, loading, haptic });

  const fillColor = tintColor ?? brandAccentColor(brandColors);
  const accentColor = tintColor ?? brandColors.primary;
  const isDestructive = role === 'destructive';

  // Per-tier native style, the fill tint (undefined = neutral, no tint), and the
  // content (label/icon/spinner) colour. Destructive lets SwiftUI's `role` paint
  // the system red, so we skip the explicit tint/foregroundStyle there — an
  // explicit colour would defeat the red.
  let styleModifier: ModifierConfig;
  let fillTint: string | undefined;
  let contentColor: string;
  if (variant === 'filled') {
    styleModifier = buttonStyle('borderedProminent');
    fillTint = fillColor;
    contentColor = brandColors.onPrimary;
  } else if (variant === 'text') {
    styleModifier = buttonStyle('borderless');
    fillTint = undefined;
    contentColor = effectiveOver === 'content' ? overlays.onScrim : accentColor;
  } else {
    // outlined / tonal — the middle tier.
    if (effectiveOver === 'content') {
      styleModifier = buttonStyle('borderedProminent');
      fillTint = overlays.scrim;
      contentColor = overlays.onScrim;
    } else if (supportsGlass) {
      styleModifier = buttonStyle('glass');
      fillTint = undefined; // neutral glass; the brand reads via the label colour
      contentColor = accentColor;
    } else {
      styleModifier = buttonStyle('bordered');
      fillTint = accentColor;
      contentColor = accentColor;
    }
  }

  // A footer button styled to fill its row needs the native Button to stretch (it
  // content-hugs otherwise); an inline button hugs its content in BOTH axes.
  const isFullWidth = isFullWidthStyle(style);

  const modifiers: ModifierConfig[] = [
    styleModifier,
    buttonBorderShape('roundedRectangle', radii.button),
    controlSize(CONTROL_SIZE[size]),
    font({ textStyle: TEXT_STYLE[size], weight: 'semibold' }),
    frame({ minHeight, ...(isFullWidth ? { maxWidth: Infinity } : {}) }),
    disabledModifier(disabled || loading),
    accessibilityLabelModifier(accessibilityLabel ?? title),
  ];
  if (!isDestructive) {
    if (fillTint) modifiers.push(tint(fillTint));
    modifiers.push(foregroundStyle(contentColor));
  }

  // The spinner follows the content colour, except destructive (whose content is
  // role-red) — there we tint it the brand error colour so it never vanishes.
  const spinnerColor = isDestructive ? brandColors.error : contentColor;
  const buttonRole = isDestructive ? 'destructive' : role === 'cancel' ? 'cancel' : undefined;

  return (
    <ThemedHost matchContents={isFullWidth ? { vertical: true } : true} style={style} testID={testID}>
      <SwiftUIButton role={buttonRole} onPress={handlePress} modifiers={modifiers}>
        <HStack spacing={6}>
          {loading ? (
            <ProgressView modifiers={[tint(spinnerColor)]} />
          ) : icon ? (
            <Image systemName={iconMap[icon].ios} />
          ) : null}
          <Text>{title}</Text>
        </HStack>
      </SwiftUIButton>
    </ThemedHost>
  );
}
