import { useSyncExternalStore } from 'react';

/**
 * The on-screen half of the #3922 sheet-detent instrumentation.
 *
 * `useSheetDetentProbe` (sheet-detent-probe.ts) already measures every iOS sheet
 * with a fixed `%` detent and prints a `[sheet-detent #3922]` line. That line
 * only exists in a dev client attached to Metro: a TestFlight/preview build has
 * no console to print to, so the numbers #3922's acceptance criteria depend on
 * — an iPhone SE 3 / iOS 26 and an iPhone 16 / iOS 26.5 readout — were
 * unreachable for anyone testing on a distributed build.
 *
 * This store carries the same payload to a screen overlay, so a tester can flip
 * a toggle, open a sheet, and screenshot the numbers. It exists to UNBLOCK the
 * fix, not to be one: nothing here feeds back into layout, and the readings it
 * holds are the probe's own — no second measurement path.
 *
 * Readings persist after the sheet dismisses, deliberately. A native iOS sheet
 * presents over the root view, so a root-mounted overlay is behind it while the
 * sheet is up; keeping the last reading per sheet lets the tester close the
 * sheet and read the numbers with nothing covering them.
 *
 * ## Why the toggle is pushed in rather than read here
 *
 * This module has exactly one dependency: React. It must, because every sheet
 * component reaches it through `sheet-detent-probe.ts`, and anything it imports
 * lands in their static graph. Importing `../settings` (react-native-mmkv, whose
 * react-native entry is Flow source) breaks Rolldown's collection-time scan with
 * `SyntaxError: Unexpected token 'typeof'` — taking every sheet suite down with
 * it. So `SheetDetentReadoutOverlay`, which is mounted once at the root and can
 * afford those imports, resolves the toggle and pushes the result in via
 * `setSheetDetentReadoutActive`.
 */

export type SheetDetentReading = {
  /** Which sheet component produced it — `Sheet`, `ModalSheet`, `ClimbFilterSheet`. */
  sheet: string;
  window: { width: number; height: number };
  insets: { top: number; bottom: number };
  /** What `useSheetColumnStyle` computed for the current detent. */
  formulaHeight: number;
  /** Absolute-fill probe: the wrapper's PADDING box, one paddingTop long. */
  probeHeight: number | null;
  /** The height the view carrying the column style actually laid out at. */
  columnHeight: number | null;
  /** The wrapper's real paddingTop, measured rather than assumed. */
  sentinelY: number | null;
  /** `probeHeight − sentinelY` — the number every prior formula was guessing. */
  availableInFlowHeight: number | null;
  /** Bumped per publish so the overlay can show that readings are still arriving. */
  sequence: number;
};

// Most recent first, one entry per sheet label. Small and fixed: three sheet
// components are instrumented, and a fourth would push the oldest out rather
// than grow the panel past a screenshot's worth of lines.
const MAX_READINGS = 4;

let readings: SheetDetentReading[] = [];
let sequence = 0;
const readingListeners = new Set<() => void>();

// Kept in its own subscription from the readings: the probe watches only this
// flag, and must not re-render every instrumented sheet each time a measurement
// lands.
let active = false;
const activeListeners = new Set<() => void>();

function getReadings(): SheetDetentReading[] {
  return readings;
}

function getActive(): boolean {
  return active;
}

/** Record a measurement for `reading.sheet`, replacing that sheet's previous one. */
export function publishSheetDetentReading(reading: Omit<SheetDetentReading, 'sequence'>): void {
  sequence += 1;
  readings = [{ ...reading, sequence }, ...readings.filter((existing) => existing.sheet !== reading.sheet)].slice(
    0,
    MAX_READINGS,
  );
  for (const listener of readingListeners) listener();
}

/** Drop every recorded reading. Backs the overlay's Clear affordance. */
export function clearSheetDetentReadings(): void {
  if (readings.length === 0) return;
  readings = [];
  for (const listener of readingListeners) listener();
}

/**
 * Turn the on-screen readout on or off. Called by `SheetDetentReadoutOverlay`,
 * which owns the settings + eligibility read (see the module doc above).
 */
export function setSheetDetentReadoutActive(next: boolean): void {
  if (active === next) return;
  active = next;
  if (!next) clearSheetDetentReadings();
  for (const listener of activeListeners) listener();
}

function subscribeToReadings(onStoreChange: () => void): () => void {
  readingListeners.add(onStoreChange);
  return () => {
    readingListeners.delete(onStoreChange);
  };
}

function subscribeToActive(onStoreChange: () => void): () => void {
  activeListeners.add(onStoreChange);
  return () => {
    activeListeners.delete(onStoreChange);
  };
}

/** Latest reading per instrumented sheet, most recent first. */
export function useSheetDetentReadings(): SheetDetentReading[] {
  return useSyncExternalStore(subscribeToReadings, getReadings, getReadings);
}

/** Whether sheets should instrument themselves for the on-screen readout. */
export function useSheetDetentReadoutActive(): boolean {
  return useSyncExternalStore(subscribeToActive, getActive, getActive);
}
