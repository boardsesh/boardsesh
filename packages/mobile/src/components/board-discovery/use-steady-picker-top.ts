// Holding the top of the picker still while a scan runs, so the board under the
// climber's thumb is the board they meant. Two parts, both per scan:
// - `usePickerScanHold`: for the scan's first few seconds nothing it heard is
//   drawn (`holdScanLead` in picker-top-view.ts). The first box a scan hears is
//   often the one by the door, and a hero that becomes At {gym} a second later
//   moves under a finger already on its way to it.
// - `useSteadyPickerTop`: once the scan has led (a hero, or At {gym} from what
//   it heard), that stays for the rest of the scan, rows in the order drawn and
//   late walls at the end (`stabilizePickerTop`).
// Neither touches the scan itself; both only read its phase.

import { useEffect, useMemo, useState } from 'react';
import type { PickerScanPhase } from './picker-scan-phase';
import {
  isScanLed,
  pickerTopSignature,
  stabilizePickerTop,
  type PickerTopBoard,
  type PickerTopContent,
  type PickerTopView,
} from './picker-top-view';

/** How long a scan listens before what it heard may lead the top. */
export const PICKER_SCAN_HOLD_MS = 3_000;

/** True for the first PICKER_SCAN_HOLD_MS of each scan, and only while it scans. */
export function usePickerScanHold(phase: PickerScanPhase): boolean {
  const scanning = phase === 'scanning';
  const [held, setHeld] = useState(scanning);
  // A new scan holds again; set during render, React's pattern for state that
  // follows a prop, so its first frame already holds.
  const [trackedScanning, setTrackedScanning] = useState(scanning);
  if (trackedScanning !== scanning) {
    setTrackedScanning(scanning);
    setHeld(scanning);
  }
  useEffect(() => {
    if (!scanning) return undefined;
    const timer = setTimeout(() => setHeld(false), PICKER_SCAN_HOLD_MS);
    return () => clearTimeout(timer);
  }, [scanning]);
  return scanning && held;
}

type Drawn = { scan: number; signature: string; content: PickerTopContent<PickerTopBoard> };

/**
 * `view` as the climber keeps seeing it through one scan: what the scan led
 * with stays (`stabilizePickerTop`). A new scan (the phase coming back to
 * `scanning`) starts over.
 */
export function useSteadyPickerTop(
  view: PickerTopView<PickerTopBoard>,
  phase: PickerScanPhase,
): PickerTopView<PickerTopBoard> {
  const scanning = phase === 'scanning';
  // Which scan this is: it counts each time the phase comes back to scanning.
  const [scanCount, setScanCount] = useState({ scanning, count: 0 });
  if (scanCount.scanning !== scanning) {
    setScanCount({ scanning, count: scanning ? scanCount.count + 1 : scanCount.count });
  }
  const [drawn, setDrawn] = useState<Drawn | null>(null);
  const drawnThisScan = drawn !== null && drawn.scan === scanCount.count ? drawn : null;
  const steady = useMemo(() => stabilizePickerTop(drawnThisScan?.content ?? null, view), [drawnThisScan, view]);
  // Remember what the scan has led with, and how At {gym} is ordered now, so
  // the next render keeps it. Only once the scan has led: the gym of the board
  // you're on, drawn while the scan holds, may still give way to it.
  const signature = pickerTopSignature(steady.content);
  const remembers =
    drawnThisScan !== null
      ? steady.content.kind === 'hero' || steady.content.kind === 'at_gym'
      : isScanLed(steady.content);
  if (remembers && (drawnThisScan === null || drawnThisScan.signature !== signature)) {
    setDrawn({ scan: scanCount.count, signature, content: steady.content });
  }
  return steady;
}
