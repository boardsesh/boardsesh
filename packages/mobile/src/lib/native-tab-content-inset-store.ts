import { useSyncExternalStore } from 'react';

/**
 * Live bottom safe-area inset measured INSIDE the focused iOS 26 native tab's
 * content, published by `NativeTabContentInsetProbe` (mounted in each phone tab
 * layout) and consumed by `useComputedBottomChromeMetrics` and `Toast`.
 *
 * Why this exists: there are two safe-area sampling points with different
 * semantics. expo-router's `NativeTabsView` wraps each tab's content in its own
 * nested `SafeAreaProvider`, so `useSafeAreaInsets().bottom` read inside a tab
 * includes the UIKit tab bar, the BottomAccessory, and the live minimize state
 * (139 = 34 home indicator + 49 bar + 56 accessory on an iPhone 17 Pro). The
 * root-mounted `BottomChromeMetricsProvider` reads the ROOT provider, whose view
 * is the window — its bottom inset is only the home indicator. Positioning tab
 * content against the root inset is what put the pre-session Start capsule under
 * the tab bar; assuming the root inset already contained the bar is what sank
 * toasts and snackbars (#3973 → #4089). This store carries the in-tab
 * measurement to the root consumers so neither has to guess.
 *
 * A module store (not context) on purpose: `Toast` renders above
 * `BottomChromeMetricsProvider` in the root layout, so a context could not reach
 * both consumers without re-ordering providers #2565 deliberately pinned.
 *
 * `null` means "no measurement yet" (cold start before the first focused-tab
 * layout pass, and always on paths where the probe never publishes: Material
 * variant, tablets, Android, iOS < 26). Consumers must fall back to explicit
 * arithmetic in that case and must ignore the value entirely off the
 * native-tab-bar path.
 */

let measuredBottom: number | null = null;
const listeners = new Set<() => void>();
// Total accepted publishes since launch, surfaced by BottomChromeDebugOverlay so
// device QA can tell whether a tab-bar minimize animation delivers a couple of
// discrete inset events or a per-frame stream. If QA shows per-frame publishes,
// add coalescing (rAF / short settle debounce) inside publish() below — the
// consumers only ever see the store through subscribe/snapshot, so the debounce
// slots in here without touching them.
let publishCount = 0;

// Sub-half-pixel jitter is layout noise, not a geometry change; re-notifying the
// root metrics provider for it would re-render every bottom-chrome consumer.
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
  return measuredBottom;
}

function getPublishCountSnapshot(): number {
  return publishCount;
}

export function publishNativeTabContentInsetBottom(value: number): void {
  if (measuredBottom !== null && Math.abs(measuredBottom - value) < PUBLISH_EPSILON) return;
  measuredBottom = value;
  publishCount += 1;
  notify();
}

/** The latest in-tab bottom inset, or null before the first publish. */
export function useNativeTabContentInsetBottom(): number | null {
  return useSyncExternalStore(subscribe, getSnapshot);
}

/** Diagnostic-only: accepted-publish counter for BottomChromeDebugOverlay. */
export function useNativeTabContentInsetPublishCount(): number {
  return useSyncExternalStore(subscribe, getPublishCountSnapshot);
}

export function resetNativeTabContentInsetForTests(): void {
  measuredBottom = null;
  publishCount = 0;
  notify();
}
