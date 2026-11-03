import { useCallback, useRef, type RefObject } from 'react';
import { Platform, TextInput, type ScrollViewInstance } from 'react-native';

/** Reveal a field after edge-to-edge Android keyboard padding reaches layout. */
export function useAndroidKeyboardScroll(
  scrollRef: RefObject<ScrollViewInstance | null>,
  keyboardHeight: number,
  extraOffset: number,
) {
  const focusedInputRef = useRef<ReturnType<typeof TextInput.State.currentlyFocusedInput>>(undefined);
  const reveal = useCallback(() => {
    if (keyboardHeight === 0 || !focusedInputRef.current) return;
    scrollRef.current?.scrollResponderScrollNativeHandleToKeyboard(focusedInputRef.current, extraOffset, true);
  }, [scrollRef, keyboardHeight, extraOffset]);
  const onFocus = useCallback(() => {
    focusedInputRef.current = TextInput.State.currentlyFocusedInput();
    reveal();
  }, [reveal]);
  const onBlur = useCallback(() => {
    focusedInputRef.current = undefined;
  }, []);
  return {
    onFocus: Platform.OS === 'android' ? onFocus : undefined,
    onBlur: Platform.OS === 'android' ? onBlur : undefined,
    onContentSizeChange: Platform.OS === 'android' ? reveal : undefined,
  };
}
