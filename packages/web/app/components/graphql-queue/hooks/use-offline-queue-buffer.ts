import { useRef, useCallback, useState, useMemo } from 'react';
import type { ClimbQueueItem } from '../../queue-control/types';

const BUFFER_CAP = 500;

/**
 * Ref-based buffer that tracks queue items added while offline in party mode.
 * These items are reconciled (pushed to the server) when the connection is restored.
 *
 * Uses a ref for the actual data (read at reconciliation time without closure staleness)
 * and a state counter to drive `hasPendingAdditions` reactivity for UI updates.
 */
export function useOfflineQueueBuffer() {
  const bufferRef = useRef<ClimbQueueItem[]>([]);
  const [count, setCount] = useState(0);

  const bufferAddition = useCallback((item: ClimbQueueItem) => {
    if (bufferRef.current.length >= BUFFER_CAP) return;
    bufferRef.current.push(item);
    setCount(bufferRef.current.length);
  }, []);

  const getBufferedAdditions = useCallback((): ClimbQueueItem[] => {
    return [...bufferRef.current];
  }, []);

  const clearBuffer = useCallback(() => {
    bufferRef.current = [];
    setCount(0);
  }, []);

  const hasPendingAdditions = count > 0;
  const isBufferFull = count >= BUFFER_CAP;

  // Memoize to provide a stable reference — prevents unnecessary recomputations
  // in downstream useMemo/useEffect dependency arrays
  return useMemo(
    () => ({ bufferAddition, getBufferedAdditions, clearBuffer, hasPendingAdditions, isBufferFull }),
    [bufferAddition, getBufferedAdditions, clearBuffer, hasPendingAdditions, isBufferFull],
  );
}
