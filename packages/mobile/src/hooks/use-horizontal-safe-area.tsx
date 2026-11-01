import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { resolveHorizontalSafeArea, type HorizontalSafeArea } from './horizontal-safe-area';

const HorizontalSafeAreaAppliedContext = createContext(false);

/**
 * Marks a subtree whose container already pads by the side safe area, so a
 * component inside it that also calls `useHorizontalSafeArea` doesn't pad twice.
 */
export function HorizontalSafeAreaApplied({ children }: { children: ReactNode }) {
  return <HorizontalSafeAreaAppliedContext.Provider value={true}>{children}</HorizontalSafeAreaAppliedContext.Provider>;
}

/**
 * The left and right insets a container should pad its content by: iPhone Duo's
 * side tab bar and status bar. Zero on a portrait iPhone, on iPad, and inside a
 * `HorizontalSafeAreaApplied` subtree. See `resolveHorizontalSafeArea`.
 *
 * Read where the content is laid out: inside a native tab the insets include the
 * side tab bar, at the root only the window's own.
 */
export function useHorizontalSafeArea(): HorizontalSafeArea {
  const { left, right } = useSafeAreaInsets();
  const appliedByAncestor = useContext(HorizontalSafeAreaAppliedContext);
  return useMemo(
    () => resolveHorizontalSafeArea({ insets: { left, right }, appliedByAncestor }),
    [left, right, appliedByAncestor],
  );
}
