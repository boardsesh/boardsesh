// Holding the top of the picker still while a scan runs, so the board under the
// climber's thumb is the board they meant. Two parts, both per scan:
// - `usePickerScanHold`: for the first few seconds after the scan hears
//   anything, nothing it heard is drawn (`holdScanLead` in picker-top-view.ts).
//   The first box a scan hears is often the one by the door, and a hero that
//   becomes At {gym} a second later moves under a finger already on its way.
// - `usePickerTopSteadiness`: nothing the scan heard leads until the serial
//   lookup has answered for everything heard so far, and once it has led (a
//   hero, or At {gym} from what it heard) that stays until the scan's results
//   leave the screen: rows in the order drawn, late walls at the end, At
//   {gym}'s roster fetched for the gym on screen, and one way out for a hero,
//   its own gym (`stabilizePickerTop`, `decisionAtDrawnTop`).
// Neither touches the scan itself; both only read its phase, rows and lookup.

import { useCallback, useEffect, useState } from 'react';
import type { PickerScanPhase } from './picker-scan-phase';
import {
  isScanLed,
  pickerTopSignature,
  type PickerTopBoard,
  type PickerTopContent,
  type PickerTopView,
} from './picker-top-view';
import type { QuickstartLookupState } from './quickstart-scan-rows';

/** How long a scan listens, from the first thing it hears, before what it heard may lead the top. */
export const PICKER_SCAN_HOLD_MS = 3_000;

/**
 * The scan has heard something: a row, or a serial whose first lookup is
 * still out (`pending` holds every serial row back).
 */
export function scanHeardAnything(rows: readonly unknown[], lookup: QuickstartLookupState): boolean {
  return rows.length > 0 || lookup !== 'none';
}

/**
 * True while a scan runs until PICKER_SCAN_HOLD_MS after it first hears
 * something. Counted from the first row, not from the phase: `scanning` also
 * covers the permission prompt and a start held for the radio.
 */
export function usePickerScanHold(phase: PickerScanPhase, heardAnything: boolean): boolean {
  const scanning = phase === 'scanning';
  const listening = scanning && heardAnything;
  const [released, setReleased] = useState(false);
  // A new scan holds again; set during render, React's pattern for state that
  // follows a prop, so its first frame already holds.
  const [trackedScanning, setTrackedScanning] = useState(scanning);
  if (trackedScanning !== scanning) {
    setTrackedScanning(scanning);
    setReleased(false);
  }
  useEffect(() => {
    if (!listening) return undefined;
    const timer = setTimeout(() => setReleased(true), PICKER_SCAN_HOLD_MS);
    return () => clearTimeout(timer);
  }, [listening]);
  return scanning && !released;
}

/** The lookup has answered for everything heard so far: nothing named is still on its way. */
function lookupSettled(lookup: QuickstartLookupState): boolean {
  return lookup !== 'pending' && lookup !== 'updating';
}

/** Where one scan's results stand: listening, ended and on screen, or gone (any other phase). */
type ScanStretch = 'scanning' | 'done' | 'idle';

function scanStretch(phase: PickerScanPhase): ScanStretch {
  if (phase === 'scanning') return 'scanning';
  return phase === 'done' ? 'done' : 'idle';
}

type Drawn = { stretch: number; signature: string; content: PickerTopContent<PickerTopBoard> };

export type PickerTopSteadiness = {
  /**
   * What the scan led the top with, while it scans or has just ended; null
   * before it has led, and once its results are off screen (a phone that has
   * since linked to a board, a new prompt), even if they come back.
   */
  drawn: PickerTopContent<PickerTopBoard> | null;
  /**
   * Nothing has led yet and the lookup is still naming boxes heard since its
   * last answer: what it heard waits too (`holdScanLead`), so the top never
   * draws a lead the answer would move.
   */
  waitsOnLookup: boolean;
  /**
   * Called with the top as drawn (after `stabilizePickerTop`), during render:
   * remembers it once the scan has led and the lookup has settled, and keeps
   * it current after (a hero upgraded to its gym, rows joined at the end).
   */
  record: (view: PickerTopView<PickerTopBoard>) => void;
};

/** Keeps what one scan led the top with, so the next render holds it (`stabilizePickerTop`). */
export function usePickerTopSteadiness(phase: PickerScanPhase, lookup: QuickstartLookupState): PickerTopSteadiness {
  const stretch = scanStretch(phase);
  // Counts each stretch of one scan's results on screen: a new one starts with
  // every scan, and whenever they leave the screen. A scan ending is the same
  // stretch. Worked out for this render too, so nothing drawn last stretch
  // shows, or is kept, while the count catches up.
  const [tracked, setTracked] = useState({ stretch, count: 0 });
  const sameStretch = tracked.stretch === stretch || (tracked.stretch === 'scanning' && stretch === 'done');
  const currentStretch = sameStretch ? tracked.count : tracked.count + 1;
  if (tracked.stretch !== stretch) setTracked({ stretch, count: currentStretch });
  const [drawn, setDrawn] = useState<Drawn | null>(null);
  const holds = stretch !== 'idle';
  const drawnNow = holds && drawn !== null && drawn.stretch === currentStretch ? drawn : null;
  const settled = lookupSettled(lookup);
  const record = useCallback(
    (view: PickerTopView<PickerTopBoard>) => {
      if (!holds) return;
      const { content } = view;
      // Not before the lookup has named everything heard: two walls of one gym
      // must have the chance to make At {gym} before a hero of one of them holds.
      const remembers =
        drawnNow !== null ? content.kind === 'hero' || content.kind === 'at_gym' : settled && isScanLed(content);
      if (!remembers) return;
      const signature = pickerTopSignature(content);
      if (drawnNow?.signature === signature) return;
      setDrawn({ stretch: currentStretch, signature, content });
    },
    [holds, drawnNow, settled, currentStretch],
  );
  return {
    drawn: drawnNow?.content ?? null,
    waitsOnLookup: holds && drawnNow === null && lookup === 'updating',
    record,
  };
}
