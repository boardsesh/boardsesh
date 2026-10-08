import { useMemo } from 'react';
import { StyleSheet, type TextStyle, type ViewStyle, type ImageStyle } from 'react-native';
import { useTheme } from '../providers/theme-provider';
import { textStyles, type TextVariant } from '../theme/typography';
export type TypographyScale = Record<TextVariant, Pick<TextStyle, 'fontSize' | 'lineHeight' | 'fontWeight'>>;
/** Resolve styles once per theme/Bold Text change, including RN text inputs. */
export function useTypographyStyles<Styles extends Record<string, ViewStyle | TextStyle | ImageStyle>>(
  factory: (scale: TypographyScale) => Styles,
): Styles {
  const theme = useTheme();
  const scale = theme.textStyles ?? textStyles;
  return useMemo(() => {
    const styles = factory(scale);
    return StyleSheet.create(styles);
  }, [factory, scale]);
}
