import { useSyncExternalStore } from 'react';

/**
 * Whether the sheets draw the keyboard calibration readout (#5964), plus the
 * window's top safe-area inset for that readout. Published once from the root
 * layout by `SheetKeyboardCalibrationPublisher`, which reads the
 * `sheet-keyboard-calibration` flag. This mirrors `window-inset-store`.
 *
 * Why a store and not `useFeatureFlag` inside `Sheet` / `ModalSheet`: dozens of
 * suites mock the feature-flags provider with only the hooks they need, and
 * every sheet they render would then throw on the missing export. The store
 * defaults to off, so those suites and every climber without the flag render
 * exactly what they did before.
 */

let calibrationEnabled = false;
let windowTopInset: number | null = null;
const listeners = new Set<() => void>();

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

function getEnabledSnapshot(): boolean {
  return calibrationEnabled;
}

function getWindowTopInsetSnapshot(): number | null {
  return windowTopInset;
}

export function publishSheetKeyboardCalibration(next: { enabled: boolean; windowTopInset: number }): void {
  if (calibrationEnabled === next.enabled && windowTopInset === next.windowTopInset) return;
  calibrationEnabled = next.enabled;
  windowTopInset = next.windowTopInset;
  notify();
}

/** Whether the sheet keyboard calibration readout is on. Off by default. */
export function useSheetKeyboardCalibrationEnabled(): boolean {
  return useSyncExternalStore(subscribe, getEnabledSnapshot, getEnabledSnapshot);
}

/** The root-sampled top safe-area inset, or null before the first publish. */
export function useSheetKeyboardCalibrationWindowTopInset(): number | null {
  return useSyncExternalStore(subscribe, getWindowTopInsetSnapshot, getWindowTopInsetSnapshot);
}

export function resetSheetKeyboardCalibrationForTests(): void {
  calibrationEnabled = false;
  windowTopInset = null;
  notify();
}
