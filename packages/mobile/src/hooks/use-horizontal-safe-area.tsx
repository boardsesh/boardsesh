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
 * The left and right insets a container should pad its content by: native
 * side navigation, including the Duo rail and an overlaying iPad sidebar. Zero
 * when the host reports no side inset or inside `HorizontalSafeAreaApplied`.
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
