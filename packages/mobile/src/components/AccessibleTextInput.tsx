import {
  TextInput,
  StyleSheet,
  type TextInputProps,
  type TextStyle,
  type TextInput as NativeTextInput,
} from 'react-native';
import type { Ref } from 'react';
import { useBoldText } from '../hooks/use-bold-text';
import { boldTextWeight } from '../theme/accessible-typography';
import { useTheme } from '../providers/theme-provider';
import { textStyles } from '../theme/typography';
/** RN inputs use the same full-size and Bold Text contract as content labels. */
export function AccessibleTextInput({ style, ...props }: TextInputProps & { ref?: Ref<NativeTextInput> }) {
  const theme = useTheme();
  const boldText = useBoldText();
  const bodyStyle = theme.textStyles.body ?? textStyles.body;
  const weight = (StyleSheet.flatten([bodyStyle, style]) as TextStyle | undefined)?.fontWeight;
  return (
    <TextInput
      allowFontScaling
      maxFontSizeMultiplier={0}
      {...props}
      style={[bodyStyle, style, boldText ? { fontWeight: boldTextWeight(weight) } : undefined]}
    />
  );
}
