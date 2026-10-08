import { BottomSheetTextInput } from '@expo/ui/community/bottom-sheet';
import type { ComponentPropsWithRef } from 'react';
import { useAccessibleInputStyle } from '../hooks/use-accessible-input-style';

/** Preserve Expo's sheet keyboard/ref host while applying content accessibility typography. */
export function AccessibleBottomSheetTextInput({
  style,
  ...props
}: ComponentPropsWithRef<typeof BottomSheetTextInput>) {
  const inputStyle = useAccessibleInputStyle(style);
  return <BottomSheetTextInput allowFontScaling maxFontSizeMultiplier={0} {...props} style={inputStyle} />;
}
