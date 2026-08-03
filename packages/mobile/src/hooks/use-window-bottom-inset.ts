import { useEffect } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { publishWindowInsetBottom, usePublishedWindowInsetBottom } from '../lib/window-inset-store';

/**
 * The bottom inset a BOTTOM-DOCKED NATIVE SHEET must clear: the window's own
 * safe area (home indicator / Android gesture bar), never the mount point's.
 *
 * Every bottom-docked sheet (`Sheet`/`ModalSheet` footers and bodies, bespoke
 * sheet footers) must use this instead of `useSafeAreaInsets().bottom`: a sheet
 * mounted inside a tab inherits the per-tab provider, whose bottom inset folds
 * in the iOS 26 tab bar + BottomAccessory that the sheet visually covers — the
 * Apply-button-floating-mid-sheet bug (#3776). See the sampling-point contract
 * in `bottom-chrome-metrics.ts`.
 *
 * Falls back to the local inset until the root publisher's first layout — a
 * window in which no sheet can be open yet — and in tests, where nothing
 * publishes and the local mock keeps its established meaning.
 */
export function useWindowBottomInset(): number {
  const published = usePublishedWindowInsetBottom();
  const insets = useSafeAreaInsets();
  return published ?? insets.bottom;
}

/**
 * Mount ONCE in the root layout (app/_layout.tsx), outside the (tabs) subtree:
 * there `useSafeAreaInsets()` resolves to expo-router's root provider, whose
 * inset IS the window's. Renders nothing.
 */
export function WindowInsetPublisher() {
  const insets = useSafeAreaInsets();
  useEffect(() => {
    publishWindowInsetBottom(insets.bottom);
  }, [insets.bottom]);
  return null;
}
