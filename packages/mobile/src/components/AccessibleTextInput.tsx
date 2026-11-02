import { TextInput, type TextInputProps, type TextInputInstance as NativeTextInput } from 'react-native';
import type { Ref } from 'react';
import { useAccessibleInputStyle, useBrandInputColors } from '../hooks/use-accessible-input-style';
/** RN inputs use the same full-size and Bold Text contract as content labels. */
export function AccessibleTextInput({ style, ...props }: TextInputProps & { ref?: Ref<NativeTextInput> }) {
  const inputStyle = useAccessibleInputStyle(style);
  const brandInputColors = useBrandInputColors();
  return <TextInput allowFontScaling maxFontSizeMultiplier={0} {...brandInputColors} {...props} style={inputStyle} />;
}
