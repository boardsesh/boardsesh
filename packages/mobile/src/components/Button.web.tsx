// Button — web implementation (react-native-web + react-native-paper). On web the
// app renders the Material (Android-look) variant, so the emphasis tier maps onto
// the same react-native-paper MD3 Button modes the native Compose family uses:
//   filled   → 'contained'         tonal → 'contained-tonal'
//   outlined → 'outlined'          text  → 'text'
// This mirrors Button.android.tsx's variant→Compose mapping. Material is opaque, so
// the `over` surface prop is inert here (a Material button is AA-safe on any
// surface), exactly as on Android. `role='destructive'` swaps in the brand error
// tokens; `loading` shows Paper's built-in spinner and disables the button. The
// press/haptic guard lives in Button.logic.ts, shared with both native files.
//
// Unlike Android (which can only tint a curated set of bundled XML drawables), Paper
// routes its `icon` through the app's MaterialCommunityIcons font, so ANY icon-map
// glyph renders here — we pass the MDI name straight from `iconMap[icon].android`.

import { Button as PaperButton } from 'react-native-paper';
import { StyleSheet } from 'react-native';
import { useTheme } from '../providers/theme-provider';
import { isFullWidthStyle, makeButtonPressHandler } from './Button.logic';
import { sizeConfig, type ButtonProps, type ButtonVariant } from './Button.types';
import { iconMap } from './icon-map';

// Emphasis tier → Paper MD3 mode. Kept as one table so it can't drift from the
// Compose family mapping in Button.android.tsx.
const MODE_BY_VARIANT: Record<ButtonVariant, 'contained' | 'outlined' | 'text' | 'contained-tonal'> = {
  filled: 'contained',
  outlined: 'outlined',
  text: 'text',
  tonal: 'contained-tonal',
};

export function Button({
  title,
  onPress,
  accessibilityLabel,
  variant = 'filled',
  size: buttonSize = 'medium',
  icon,
  disabled = false,
  loading = false,
  haptic = true,
  tintColor,
  minHeight,
  role = 'default',
  testID,
  style,
}: ButtonProps) {
  const { brandColors } = useTheme();
  const handlePress = makeButtonPressHandler({ onPress, disabled, loading, haptic });

  const config = sizeConfig[buttonSize];
  const isDestructive = role === 'destructive';

  // Per-variant Paper colours. Non-destructive filled/tonal take the MD3 theme
  // defaults (brand primary / secondaryContainer from buildPaperTheme) unless a
  // custom `tintColor` is passed; destructive fills with the brand error token and
  // keeps white content. outlined/text carry the brand (or error) on the LABEL.
  let buttonColor: string | undefined;
  let textColor: string | undefined;
  if (variant === 'filled') {
    if (isDestructive) {
      buttonColor = brandColors.error;
      textColor = brandColors.onPrimary;
    } else if (tintColor) {
      buttonColor = tintColor;
    }
  } else if (variant === 'tonal') {
    if (isDestructive) {
      buttonColor = brandColors.error;
      textColor = brandColors.onPrimary;
    }
  } else {
    // outlined / text — the label carries the emphasis colour.
    textColor = isDestructive ? brandColors.error : tintColor;
  }

  const isFullWidth = isFullWidthStyle(style);

  return (
    <PaperButton
      mode={MODE_BY_VARIANT[variant]}
      onPress={handlePress}
      disabled={disabled || loading}
      loading={loading}
      icon={icon ? iconMap[icon].android : undefined}
      buttonColor={buttonColor}
      textColor={textColor}
      accessibilityLabel={accessibilityLabel ?? title}
      testID={testID}
      // A full-width button stretches to its row; an inline one hugs its content
      // (Paper's default). `alignSelf` mirrors the Compose `fillMaxWidth()` intent.
      style={[isFullWidth ? styles.fullWidth : styles.inline, style]}
      // Paper sizes the button from its content row, so the touch-floor override
      // belongs here (same role as the Compose `defaultMinSize`), not on the outer
      // container — see `minHeight` in Button.types.ts.
      contentStyle={{
        paddingHorizontal: config.paddingHorizontal,
        paddingVertical: config.paddingVertical,
        ...(minHeight != null ? { minHeight } : {}),
      }}
      labelStyle={{ fontSize: config.fontSize }}
    >
      {title}
    </PaperButton>
  );
}

const styles = StyleSheet.create({
  fullWidth: {
    alignSelf: 'stretch',
  },
  inline: {
    alignSelf: 'flex-start',
  },
});
