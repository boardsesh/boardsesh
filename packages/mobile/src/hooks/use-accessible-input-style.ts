import { useMemo } from 'react';
import { StyleSheet, type StyleProp, type TextStyle } from 'react-native';
import { useBoldText } from './use-bold-text';
import { boldTextWeight } from '../theme/accessible-typography';
import { useTheme } from '../providers/theme-provider';
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
