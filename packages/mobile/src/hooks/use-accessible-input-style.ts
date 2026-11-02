import { useMemo } from 'react';
import { Platform, StyleSheet, type StyleProp, type TextStyle } from 'react-native';
import { useBoldText } from './use-bold-text';
import { boldTextWeight } from '../theme/accessible-typography';
import { useTheme } from '../providers/theme-provider';
import { textInputBrandColors } from '../theme/expo-ui-modifiers';
import { textStyles } from '../theme/typography';

/** Content inputs share the theme body scale and strengthen the final caller weight. */
export function useAccessibleInputStyle(style: StyleProp<TextStyle>) {
  const theme = useTheme();
  const boldText = useBoldText();
  const bodyStyle = theme.textStyles?.body ?? textStyles.body;
  return useMemo(() => {
    const weight = StyleSheet.flatten([bodyStyle, style])?.fontWeight;
    return [bodyStyle, style, boldText ? { fontWeight: boldTextWeight(weight) } : undefined];
  }, [bodyStyle, style, boldText]);
}

/** Brand cursor and selection colours for RN inputs; undefined when the theme has no brand colours. */
export function useBrandInputColors() {
  const brandColors = useTheme().brandColors;
  return useMemo(
    () => (brandColors?.primary ? textInputBrandColors(brandColors, Platform.OS) : undefined),
    [brandColors],
  );
}
