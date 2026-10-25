import { useMemo } from 'react';
import { Platform, useWindowDimensions, type TextStyle } from 'react-native';
import { useTheme } from '../providers/theme-provider';
import type { TextVariant, TypeStyle } from '../theme/typography';

export type CappedTextProps = {
  allowFontScaling?: boolean;
  maxFontSizeMultiplier?: number;
  style?: TextStyle;
};

/**
 * Text props that stop a label growing past `cap` times its size, line height
 * included.
 *
 * `maxFontSizeMultiplier` alone does that on iOS. On Android (React Native
 * 0.86, new architecture) it caps the font size but not the line height:
 * `TextAttributeProps.lineHeight` converts with `toPixelFromSP(value)`, which
 * applies the full system scale, while the font size goes through
 * `toPixelFromSP(fontSize, maxFontSizeMultiplier)`. At Android's 2.0 text size
 * a capped 16sp line still grows to about 28dp, so a label in a fixed-height
 * row runs out of it. On Android the size and line height are scaled here,
 * together, and the system scaling is switched off.
 */
export function cappedTextProps({
  platform,
  fontScale,
  typeStyle,
  cap,
}: {
  platform: typeof Platform.OS;
  fontScale: number;
  typeStyle: TypeStyle;
  cap: number;
}): CappedTextProps {
  if (platform !== 'android') return { maxFontSizeMultiplier: cap };
  const scale = Math.min(fontScale, cap);
  return {
    allowFontScaling: false,
    style: {
      ...(typeStyle.fontSize === undefined ? null : { fontSize: typeStyle.fontSize * scale }),
      ...(typeStyle.lineHeight === undefined ? null : { lineHeight: typeStyle.lineHeight * scale }),
    },
  };
}

/** {@link cappedTextProps} for a `Text` variant in the current theme. Spread the props, put `style` first. */
export function useCappedTextProps(variant: TextVariant, cap: number): CappedTextProps {
  const { textStyles } = useTheme();
  const { fontScale } = useWindowDimensions();
  const typeStyle = textStyles[variant];
  return useMemo(
    () => cappedTextProps({ platform: Platform.OS, fontScale, typeStyle, cap }),
    [fontScale, typeStyle, cap],
  );
}
