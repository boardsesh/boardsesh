import { BottomSheetTextInput } from '@expo/ui/community/bottom-sheet';
import { useCallback, useEffect, useRef, type ComponentPropsWithRef, type RefObject } from 'react';
import type { TextInputInstance } from 'react-native';
import { useAccessibleInputStyle, useBrandInputColors } from '../hooks/use-accessible-input-style';
import { useSheetScrollIntoView, type SheetRevealTarget } from './sheet-scroll-into-view';

type AccessibleBottomSheetTextInputProps = ComponentPropsWithRef<typeof BottomSheetTextInput> & {
  /** Include adjacent validation or help text in the focus reveal. */
  sheetRevealTargetRef?: RefObject<SheetRevealTarget | null>;
};

/** Preserve Expo's keyboard/ref host and keep focused fields in the sheet's viewport. */
export function AccessibleBottomSheetTextInput({
  style,
  ref,
  onFocus,
  onBlur,
  onContentSizeChange,
  sheetRevealTargetRef,
  ...props
}: AccessibleBottomSheetTextInputProps) {
  const inputStyle = useAccessibleInputStyle(style);
  const brandInputColors = useBrandInputColors();
  const inputRef = useRef<TextInputInstance | null>(null);
  const activeTargetRef = useRef<SheetRevealTarget | null>(null);
  const scrollIntoView = useSheetScrollIntoView();
  const setInputRef = useCallback(
    (input: TextInputInstance | null) => {
      inputRef.current = input;
      if (typeof ref === 'function') return ref(input);
      if (ref) ref.current = input;
    },
    [ref],
  );

  const release = useCallback(() => {
    if (activeTargetRef.current) scrollIntoView?.release(activeTargetRef.current);
    activeTargetRef.current = null;
  }, [scrollIntoView]);
  useEffect(() => release, [release]);

  return (
    <BottomSheetTextInput
      allowFontScaling
      maxFontSizeMultiplier={0}
      {...brandInputColors}
      {...props}
      ref={setInputRef}
      onFocus={(event) => {
        const target = sheetRevealTargetRef?.current ?? inputRef.current;
        activeTargetRef.current = target;
        if (target) scrollIntoView?.reveal(target);
        onFocus?.(event);
      }}
      onBlur={(event) => {
        release();
        onBlur?.(event);
      }}
      onContentSizeChange={(event) => {
        if (activeTargetRef.current) scrollIntoView?.follow(activeTargetRef.current);
        onContentSizeChange?.(event);
      }}
      style={inputStyle}
    />
  );
}
