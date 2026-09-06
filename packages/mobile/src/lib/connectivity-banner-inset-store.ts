import { useSyncExternalStore } from 'react';

/**
 * Live height of the app-wide connectivity banner (issue #4862), published by
 * `ConnectivityBanner`'s own `onLayout` and consumed by
 * `useComputedBottomChromeMetrics` and `Toast`.
 *
 * The banner floats above the bottom chrome on EVERY route, so anything else
 * that positions against the bottom edge has to know how tall it currently is or
 * it renders underneath: the queue-added snackbar, the filter FAB, the last row
 * of every list. Its height is not a constant — the card has one, two or three
 * lines of copy plus an optional actions row, and it collapses to a pill — so
 * the only honest number is the measured one.
 *
 * A module store (not context) for the same reason
 * `native-tab-content-inset-store` is one: `Toast` renders ABOVE
 * `BottomChromeMetricsProvider` in the root layout, so a context could not reach
 * both consumers without re-ordering providers #2565 deliberately pinned.
 *
 * `0` means "no banner on screen" — the banner publishes 0 when it hides or
 * unmounts, so a consumer never keeps reserving space for a card that is gone.
 * The published value already includes the gap the banner leaves under itself,
 * so consumers add it raw.
 */

let bannerHeight = 0;
const listeners = new Set<() => void>();

// Sub-half-pixel jitter is layout noise, not a geometry change; re-notifying the
// root metrics provider for it would re-render every bottom-chrome consumer.
// Same threshold, and the same reasoning, as the native-tab inset store.
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

function getSnapshot(): number {
  return bannerHeight;
}

/** Publish the measured banner height, or 0 once it is off screen. */
export function publishConnectivityBannerHeight(height: number): void {
  if (Math.abs(bannerHeight - height) < PUBLISH_EPSILON) return;
  bannerHeight = height;
  notify();
}

/** The banner's current height; 0 whenever no banner is showing. */
export function useConnectivityBannerHeight(): number {
  return useSyncExternalStore(subscribe, getSnapshot);
}

export function __resetConnectivityBannerHeightForTests(): void {
  bannerHeight = 0;
  notify();
}
