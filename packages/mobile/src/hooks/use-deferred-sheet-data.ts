import { useCallback, useRef, useState } from 'react';
import { usePrivacyScopedState } from './use-privacy-scoped-state';

/**
 * Data-backed sheet state that survives the dismiss animation. `open(value)`
 * shows it; `close()` requests the animated close (flips `visible` false) but
 * keeps the data mounted; `clearIfClosed()` (wired to the sheet's onFullyDismissed)
 * drops the data only once the animation has settled and the sheet wasn't
 * re-opened — so the native Host never unmounts mid-animation (an iOS freeze
 * vector) and the content doesn't blank out while sliding away.
 */
export function useDeferredSheetData<T>(): {
  data: T | null;
  visible: boolean;
  open: (value: T) => void;
  close: () => void;
  clearIfClosed: () => void;
} {
  const [data, setData] = usePrivacyScopedState<T>(null);
  const [visible, setVisible] = useState(false);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const open = useCallback(
    (value: T) => {
      setData(value);
      setVisible(true);
    },
    [setData],
  );
  const close = useCallback(() => setVisible(false), []);
  const clearIfClosed = useCallback(() => {
    if (!visibleRef.current) setData(null);
  }, [setData]);
  return { data, visible: visible && data !== null, open, close, clearIfClosed };
}
