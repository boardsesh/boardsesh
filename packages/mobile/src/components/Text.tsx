import { Text as RNText, type TextProps as RNTextProps, type ColorValue, StyleSheet } from 'react-native';
import { textStyles, type TextVariant } from '../theme/typography';
import { useOptionalTheme } from '../providers/theme-provider';

export type { TextVariant };

type TextProps = RNTextProps & {
  variant?: TextVariant;
  color?: ColorValue;
};

/**
 * Static fallback scale (the Liquid Glass / Apple HIG values). Used only when no
 * ThemeProvider is mounted — e.g. the pre-provider root error boundary. Under a
 * provider, `Text` reads the variant-resolved `theme.textStyles` so the Material
 * variant gets the M3 (Roboto) scale.
 */
export const variantStyles = StyleSheet.create(textStyles);

export function Text({ variant = 'body', color, style, ...props }: TextProps) {
  // Default to the adaptive label colour so uncoloured text is readable in
  // dark mode (RN's default text colour is a non-adaptive black). An explicit
  // `color` prop or a `style.color` still wins. `useOptionalTheme` keeps this
  // safe in the pre-provider error boundary (falls back to the RN default).
  const theme = useOptionalTheme();
  const resolvedColor = color ?? theme?.systemColors.label;
  // Pull the type scale from the theme so the resolved per-UI-variant scale
  // (HIG on Liquid Glass, M3 on Material) applies. Falls back to the static glass
  // scale when no provider is mounted.
  const typeStyle = theme?.textStyles[variant] ?? variantStyles[variant];

  return (
    <RNText
      allowFontScaling
      maxFontSizeMultiplier={1.5}
      style={[typeStyle, resolvedColor != null ? { color: resolvedColor } : undefined, style]}
      {...props}
    />
  );
}
