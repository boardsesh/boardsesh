import { useSyncExternalStore } from 'react';

/**
 * Where a toast floats, published by `ToastOffsetPublisher` from INSIDE
 * `BottomChromeMetricsProvider` and read by `Toast`, which renders from
 * `ToastProvider` far above it.
 *
 * Why a store and not context: the toast overlay must stay where ToastProvider
 * mounts it — above `BottomSheetModalProvider`, so on Expo web gorhom's portal
 * host (which paints after its children) cannot cover a toast, and on native the
 * toast keeps painting over every screen, snackbar and the queue bar. The
 * geometry it needs only exists lower down, so it is carried up the same way
 * the window inset and the in-tab inset are.
 *
 * `null` until the publisher's first effect; `Toast` falls back to the root
 * inset plus its gap in that window.
 */

let toastBottomOffset: number | null = null;
const listeners = new Set<() => void>();

// Sub-half-pixel changes are layout noise, not geometry.
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
  return toastBottomOffset;
}

export function publishToastBottomOffset(value: number): void {
  if (toastBottomOffset !== null && Math.abs(toastBottomOffset - value) < PUBLISH_EPSILON) return;
  toastBottomOffset = value;
  notify();
}

/** The published toast `bottom`, or null before the publisher's first effect. */
export function usePublishedToastBottomOffset(): number | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function resetToastBottomOffsetForTests(): void {
  toastBottomOffset = null;
  notify();
}
