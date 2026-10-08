import { TextInput, type TextInputProps, type TextInput as NativeTextInput } from 'react-native';
import type { Ref } from 'react';
import { useAccessibleInputStyle } from '../hooks/use-accessible-input-style';
/** RN inputs use the same full-size and Bold Text contract as content labels. */
export function AccessibleTextInput({ style, ...props }: TextInputProps & { ref?: Ref<NativeTextInput> }) {
  const inputStyle = useAccessibleInputStyle(style);
  return <TextInput allowFontScaling maxFontSizeMultiplier={0} {...props} style={inputStyle} />;
}
