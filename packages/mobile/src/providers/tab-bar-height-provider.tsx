// Publishes the Material bottom tab bar's *measured* height so the persistent queue
// control bar — which mounts at the app root, outside the Tabs navigator — can dock
// flush against the real rendered tab bar instead of re-deriving its top from a
// hardcoded constant (which left a 1–2px seam patched by a hand-tuned offset; #2611).
//
// MaterialTabBar (deep inside the navigator) publishes via `useSetMeasuredTabBarHeight`;
// ActiveContextBar (root overlay) consumes via `useMeasuredTabBarHeight`. Both hooks
// degrade gracefully to null / no-op when no provider is mounted (e.g. unit tests, or
// the Liquid Glass variant which uses native tabs and never measures).

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

type TabBarHeightContextValue = {
  /** Measured tab-bar height incl. the safe-area inset, or null before the first layout. */
  height: number | null;
  /** Publish a freshly measured height; sub-0.5px churn is ignored to avoid render loops. */
  setHeight: (measured: number) => void;
};

const TabBarHeightContext = createContext<TabBarHeightContextValue | null>(null);

const noop = () => {};

export function TabBarHeightProvider({ children }: { children: ReactNode }) {
  const [height, setHeightState] = useState<number | null>(null);
  const setHeight = useCallback((measured: number) => {
    setHeightState((prev) => (prev == null || Math.abs(prev - measured) >= 0.5 ? measured : prev));
  }, []);
  const value = useMemo(() => ({ height, setHeight }), [height, setHeight]);
  return <TabBarHeightContext.Provider value={value}>{children}</TabBarHeightContext.Provider>;
}

export function useMeasuredTabBarHeight(): number | null {
  return useContext(TabBarHeightContext)?.height ?? null;
}

export function useSetMeasuredTabBarHeight(): (measured: number) => void {
  return useContext(TabBarHeightContext)?.setHeight ?? noop;
}
