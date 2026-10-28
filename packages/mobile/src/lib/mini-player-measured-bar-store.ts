import { useSyncExternalStore } from 'react';

/**
 * The open MiniPlayer bar's regular capacity, published by
 * `NativeAccessoryClimbRow` and read by the View options preview (#6940).
 *
 * Horizontal phones use a stable viewport budget, so a hidden inline-width
 * measurement cannot change the regular controls during expansion. A 375pt
 * phone's 333pt content fits two slots; a 402pt phone's 360pt content fits three.
 * Rails, tablets and split layouts use their measured container width. The
 * preview reads this same capacity so it draws what the real bar draws.
 *
 * A module store, not context: the bar and the sheet sit in unrelated trees.
 */

export type MeasuredMiniPlayerBar = {
  /** Regular control capacity width; viewport-derived on horizontal phones. */
  rowWidth: number;
  /** What the row spends beside the name: insets, artwork, label padding. */
  widthBesideName: number;
};

let measured: MeasuredMiniPlayerBar | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function publishMeasuredMiniPlayerBar(next: MeasuredMiniPlayerBar): void {
  if (measured?.rowWidth === next.rowWidth && measured.widthBesideName === next.widthBesideName) return;
  measured = next;
  notify();
}

export function getMeasuredMiniPlayerBar(): MeasuredMiniPlayerBar | null {
  return measured;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The regular capacity, or `null` before the bar has published it. */
export function useMeasuredMiniPlayerBar(): MeasuredMiniPlayerBar | null {
  return useSyncExternalStore(subscribe, getMeasuredMiniPlayerBar, getMeasuredMiniPlayerBar);
}

/** For tests: forget the measurement. */
export function resetMeasuredMiniPlayerBar(): void {
  measured = null;
  notify();
}
