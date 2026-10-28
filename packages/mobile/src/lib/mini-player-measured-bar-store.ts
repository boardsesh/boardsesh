import { useSyncExternalStore } from 'react';

/**
 * The open MiniPlayer bar's last measured row, published by
 * `NativeAccessoryClimbRow` and read by the View options preview (#6940).
 *
 * The slot count depends on the width UIKit gives the platter, which differs by
 * device and window: an iPhone Duo's closed display (~290pt) holds one slot where
 * a 375pt iPhone (343pt) holds three. The preview reads the measured width so it
 * draws what the bar on this device draws; before the bar has ever drawn it falls
 * back to a representative width.
 *
 * A module store, not context: the bar and the sheet sit in unrelated trees.
 */

export type MeasuredMiniPlayerBar = {
  /** The open (regular placement) platter's row width. */
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

/** The last measured open bar, or `null` before it has drawn. */
export function useMeasuredMiniPlayerBar(): MeasuredMiniPlayerBar | null {
  return useSyncExternalStore(subscribe, getMeasuredMiniPlayerBar, getMeasuredMiniPlayerBar);
}

/** For tests: forget the measurement. */
export function resetMeasuredMiniPlayerBar(): void {
  measured = null;
  notify();
}
