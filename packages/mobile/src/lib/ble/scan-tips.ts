// The "Don't see your board?" tips: when a scan shows them, and in what order.
// Shared by the device picker (DevicePickerSheet) and the /boards Bluetooth
// quickstart (BluetoothQuickstartSheet), so both say the same thing at the same
// moment.

import { useEffect, useState } from 'react';

/**
 * How long a scan runs with nothing to pick before the tips show. The picker's
 * scan runs 30 s (`SCAN_TIMEOUT_MS`) and the quickstart's 15 s; the tips used to
 * wait for either to end empty. A board that is on and in range is heard well
 * inside 5 s, so by then an empty list is worth explaining while the scan goes on.
 */
export const SCAN_TIPS_DELAY_MS = 5_000;

/**
 * One tip. `moonboard_other_phone` is the other-phone tip for a MoonBoard: V3
 * and later boxes take several phones, and an older box may need switching off
 * and on before the next phone gets on, so "only one phone at a time" is wrong
 * there.
 */
export type ScanTip = 'power' | 'closer' | 'bluetooth' | 'other_phone' | 'moonboard_other_phone';

const DEFAULT_ORDER: readonly ScanTip[] = ['power', 'closer', 'bluetooth', 'other_phone'];
// Another phone holding the box is the second most likely reason a MoonBoard is
// missing: an older box keeps the first phone (a second phone gets on 19% of
// the time against 68% elsewhere, 30 days to 2026-10-31).
const MOONBOARD_ORDER: readonly ScanTip[] = ['power', 'moonboard_other_phone', 'closer', 'bluetooth'];

/**
 * The tips in the order to show them: power, distance, Bluetooth, then another
 * phone. For a MoonBoard the other-phone tip moves to second.
 *
 * @param boardName The board the scan is for (the picker's target or active
 *   board); undefined where the scan is for any board.
 */
export function orderScanTips(boardName: string | undefined): readonly ScanTip[] {
  return boardName === 'moonboard' ? MOONBOARD_ORDER : DEFAULT_ORDER;
}

/**
 * True once `scanning` has been true for `SCAN_TIPS_DELAY_MS`. Back to false the
 * moment the scan stops, so the next scan waits its own 5 s; a caller that keeps
 * its tips after the scan ends checks that on its own.
 */
export function useScanTipsDue(scanning: boolean): boolean {
  const [due, setDue] = useState(false);
  useEffect(() => {
    if (!scanning) {
      setDue(false);
      return undefined;
    }
    const timer = setTimeout(() => setDue(true), SCAN_TIPS_DELAY_MS);
    return () => clearTimeout(timer);
  }, [scanning]);
  return scanning && due;
}
