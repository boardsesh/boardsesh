import { useCallback, useEffect, useState, type RefObject } from 'react';
import type { LayoutChangeEvent } from 'react-native';
import type { BottomSheetMethods } from '@expo/ui/community/bottom-sheet';
import { useManagedSheet } from '../../providers/sheet-presentation-provider';

/** Opening a sheet is a coordinated transition; native onChange alone is not a paint signal. */
export function useStorySheetPresentation(sheetRef: RefObject<BottomSheetMethods | null>) {
  const managed = useManagedSheet({ open: true, sheetRef });
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
  return { ...managed, onLayout, presented: settled && laidOut };
}
