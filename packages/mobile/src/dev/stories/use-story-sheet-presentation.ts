import { useCallback, useEffect, useState, type RefObject } from 'react';
import type { LayoutChangeEvent } from 'react-native';
import type { BottomSheetMethods } from '@expo/ui/community/bottom-sheet';
import { useManagedSheet } from '../../providers/sheet-presentation-provider';

/** Capture long sheet content at its large detent, after presentation and layout. */
export function useStorySheetPresentation(sheetRef: RefObject<BottomSheetMethods | null>) {
  const managed = useManagedSheet({ sheetRef });
  const [expanded, setExpanded] = useState(false);
  const handle = managed.handle;
  useEffect(() => {
    handle.snapToIndex(1);
  }, [handle]);
  const nativeOnChange = managed.onChange;
  const onChange = useCallback(
    (index: number) => {
      nativeOnChange(index);
      setExpanded(index === 1);
    },
    [nativeOnChange],
  );
  const [settled, setSettled] = useState(false);
  const [laidOut, setLaidOut] = useState(false);
  const waitForPresentation = managed.waitForPresentation;
  useEffect(() => {
    let active = true;
    void waitForPresentation().then((result) => {
      if (active && result.status === 'presented') setSettled(true);
    });
    return () => {
      active = false;
    };
  }, [waitForPresentation]);
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    if (event.nativeEvent.layout.width > 0 && event.nativeEvent.layout.height > 0) setLaidOut(true);
  }, []);
  return { ...managed, onChange, onLayout, presented: settled && laidOut && expanded };
}
