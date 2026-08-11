import { useSyncExternalStore } from 'react';
import { useSetting } from '../settings';
import { useDiagnosticsEligible } from '../hooks/use-diagnostics-eligible';

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
 * fix, not to be one: nothing here feeds back into layout, and the readings the
 * probe publishes are the probe's own — no second measurement path.
 *
 * Readings persist after the sheet dismisses, deliberately. A native iOS sheet
 * presents over the root view, so a root-mounted overlay is behind it while the
 * sheet is up; keeping the last reading per sheet lets the tester close the
 * sheet and read the numbers with nothing covering them.
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
const listeners = new Set<() => void>();

function getSnapshot(): SheetDetentReading[] {
  return readings;
}

/** Record a measurement for `reading.sheet`, replacing that sheet's previous one. */
export function publishSheetDetentReading(reading: Omit<SheetDetentReading, 'sequence'>): void {
  sequence += 1;
  readings = [{ ...reading, sequence }, ...readings.filter((existing) => existing.sheet !== reading.sheet)].slice(
    0,
    MAX_READINGS,
  );
  for (const listener of listeners) listener();
}

/** Drop every recorded reading. Used by the overlay's Clear affordance and tests. */
export function clearSheetDetentReadings(): void {
  if (readings.length === 0) return;
  readings = [];
  for (const listener of listeners) listener();
}

function subscribe(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
  };
}

/** Latest reading per instrumented sheet, most recent first. */
export function useSheetDetentReadings(): SheetDetentReading[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Whether the on-screen readout is on for this session. Requires BOTH the
 * persisted "Sheet detent readout" toggle (More → Diagnostics) and a
 * diagnostics-eligible session, so a regular production install never mounts
 * the probe views or the overlay.
 */
export function useSheetDetentReadoutEnabled(): boolean {
  const eligible = useDiagnosticsEligible();
  const [enabled] = useSetting('sheetDetentDiagnostics');
  return eligible && enabled;
}
