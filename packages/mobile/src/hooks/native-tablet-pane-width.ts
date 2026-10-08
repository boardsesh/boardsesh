import { useSyncExternalStore } from 'react';
import { Platform, useWindowDimensions } from 'react-native';
import { useTheme } from '../providers/theme-provider';
import { SIDEBAR_WIDTH } from '../theme/layout';

let measuredContentWidth: number | null = null;
const listeners = new Set<() => void>();
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
function snapshot() {
  return measuredContentWidth;
}

/** Focused native tab content is already inset by UIKit's expanded sidebar. */
export function publishNativeTabletContentWidth(width: number): void {
  if (!Number.isFinite(width) || width <= 0 || measuredContentWidth === width) return;
  measuredContentWidth = width;
  for (const listener of listeners) listener();
}

export function useTabletPaneWidth(): { width: number; sidebarWidth: number } {
  const measuredWidth = useSyncExternalStore(subscribe, snapshot, snapshot);
  const { width: windowWidth } = useWindowDimensions();
  const { variant } = useTheme();
  const isNativeTablet = Platform.OS === 'ios' && Platform.isPad === true && variant === 'liquidGlass';
  // Until UIKit measures the tab, keep the compact drawer usable instead of
  // declaring a detail pane that has not yet been laid out.
  return isNativeTablet
    ? { width: measuredWidth ?? 0, sidebarWidth: 0 }
    : { width: windowWidth, sidebarWidth: SIDEBAR_WIDTH };
}
