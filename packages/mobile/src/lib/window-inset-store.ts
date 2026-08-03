import { useSyncExternalStore } from 'react';

/**
 * The WINDOW's bottom safe-area inset (home indicator / Android gesture bar),
 * published once from the root layout by `WindowInsetPublisher` — the mirror of
 * `native-tab-content-inset-store`, which carries the in-tab inset the other way.
 *
 * Why sheets need it: a native `@expo/ui` bottom sheet docks to the WINDOW and
 * covers the tab bar, so the only chrome its content must clear is the window's
 * own bottom inset. But `useSafeAreaInsets()` inside a sheet resolves to the
 * provider at the sheet's MOUNT POINT — and a sheet mounted inside a tab sits in
 * expo-router's per-tab nested SafeAreaProvider, whose bottom inset folds in the
 * iOS 26 tab bar and BottomAccessory (up to 139pt). Padding a sheet footer with
 * that pushed the Apply button ~105pt up into the sheet (the #3776 "dead gap").
 * See the sampling-point contract in `hooks/bottom-chrome-metrics.ts`.
 *
 * `null` until the root publisher's first layout; `useWindowBottomInset()` falls
 * back to the local inset in that window, which also keeps every existing test
 * (they mock react-native-safe-area-context, not this store) behaving as before.
 */

let windowInsetBottom: number | null = null;
const listeners = new Set<() => void>();

// Same sub-half-pixel dedupe as the in-tab store: layout noise, not geometry.
const PUBLISH_EPSILON = 0.5;

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): number | null {
  return windowInsetBottom;
}

export function publishWindowInsetBottom(value: number): void {
  if (windowInsetBottom !== null && Math.abs(windowInsetBottom - value) < PUBLISH_EPSILON) return;
  windowInsetBottom = value;
  notify();
}

/** The published window bottom inset, or null before the root's first publish. */
export function usePublishedWindowInsetBottom(): number | null {
  return useSyncExternalStore(subscribe, getSnapshot);
}

export function resetWindowInsetForTests(): void {
  windowInsetBottom = null;
  notify();
}
