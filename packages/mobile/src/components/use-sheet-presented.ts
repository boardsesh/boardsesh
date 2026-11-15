import { useCallback, useEffect, useRef, useState } from 'react';
import type { LayoutChangeEvent } from 'react-native';
import type { WaitForPresentationResult } from '../providers/sheet-presentation-provider';

/** Native detent changes can precede animation completion; observe both transition and layout. */
export function useSheetPresented(
  isOpen: boolean,
  waitForPresentation: () => Promise<WaitForPresentationResult>,
  onPresented?: () => void,
) {
  const [contentLaidOut, setContentLaidOut] = useState(false);
  const callbackRef = useRef(onPresented);
  callbackRef.current = onPresented;
  const enabled = onPresented !== undefined;
  useEffect(() => {
    if (!isOpen || !contentLaidOut || !enabled) return;
    let active = true;
    void waitForPresentation().then((result) => {
      if (active && result.status === 'presented') callbackRef.current?.();
    });
    return () => {
      active = false;
    };
  }, [isOpen, contentLaidOut, enabled, waitForPresentation]);
  return useCallback(
    (event: LayoutChangeEvent) => {
      if (enabled && event.nativeEvent.layout.width > 0 && event.nativeEvent.layout.height > 0) {
        setContentLaidOut(true);
      }
    },
    [enabled],
  );
}
