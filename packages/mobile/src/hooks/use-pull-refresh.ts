import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * State for a `RefreshControl` (HIG Refresh content controls) on a screen whose
 * data comes from several sources: React Query refetches that return a promise,
 * and the hand-rolled playlist hooks whose `refetch()` returns nothing and
 * reports progress through a loading flag instead.
 *
 * `refreshing` turns on when the user pulls and stays on until the promise
 * `refresh` returns has settled AND `busy` (the sources' loading flags, OR'd)
 * has gone false. A background refetch on its own never shows the spinner: only
 * a pull does.
 */
export function usePullRefresh(refresh: () => unknown, busy = false): { refreshing: boolean; onRefresh: () => void } {
  const [pulled, setPulled] = useState(false);
  const [awaiting, setAwaiting] = useState(false);
  const mountedRef = useRef(true);
  const refreshActiveRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const onRefresh = useCallback(() => {
    if (refreshActiveRef.current) return;
    refreshActiveRef.current = true;
    setPulled(true);
    setAwaiting(true);
    // Called synchronously so the sources flip their loading flags in this same
    // batch, before the effect below can see `busy` still false.
    let refreshResult: unknown;
    try {
      refreshResult = refresh();
    } catch {
      refreshResult = undefined;
    }
    void Promise.resolve(refreshResult)
      .catch(() => undefined)
      .finally(() => {
        if (mountedRef.current) setAwaiting(false);
      });
  }, [refresh]);

  useEffect(() => {
    if (pulled && !awaiting && !busy) {
      refreshActiveRef.current = false;
      setPulled(false);
    }
  }, [pulled, awaiting, busy]);

  return { refreshing: pulled, onRefresh };
}
