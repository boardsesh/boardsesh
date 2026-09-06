import type { ConnectivityReason } from '../connectivity/connectivity-store';
import { assertNever } from '../assert-never';

/**
 * Which `mobile.offline.*` notice the board picker prints above its downloaded
 * boards. Returned as a name rather than a resolved string so the pure helper
 * stays free of i18n, and so the caller keeps the literal `t()` keys the i18n
 * linter demands.
 */
export type PickerNoticeKey = 'pickerNoticeOfflineMode' | 'pickerNotice' | 'pickerNoticeUnreachable';

type LocalOnlyInput = {
  /** No signal, our backend unreachable, or Offline mode on. */
  effectiveOffline: boolean;
  /** The `myBoards` query genuinely errored (rather than pausing). */
  isError: boolean;
  /** How many boards the network list handed back. */
  myBoardsCount: number;
};

/**
 * Whether the picker falls back to the boards this device has downloaded.
 *
 * The second half is the lying-connection case: a captive portal or gym wifi
 * with a dead upstream, where the phone reports a working network, so retries
 * never pause and the query errors for real. Without it the screen renders "No
 * boards yet — create one", a false claim whose only CTA also needs the network.
 */
export function deriveLocalOnly({ effectiveOffline, isError, myBoardsCount }: LocalOnlyInput): boolean {
  return effectiveOffline || (isError && myBoardsCount === 0);
}

/**
 * Which notice to print, by who is actually at fault. "No signal" is only ever
 * true of the phone: a climber standing in full LTE while our server is down —
 * or with Offline mode on by their own hand — is owed a line that says so,
 * because the fix is different every time (wait, wait, or flip the switch back).
 */
export function pickerNoticeKey({
  reason,
  isError,
}: {
  reason: ConnectivityReason | null;
  isError: boolean;
}): PickerNoticeKey {
  switch (reason) {
    case 'offline_mode':
      return 'pickerNoticeOfflineMode';
    case 'device_offline':
      return 'pickerNotice';
    case 'backend_unreachable':
      return 'pickerNoticeUnreachable';
    case null:
      // No verdict from the store, but the query failed anyway: the lying
      // connection (captive portal, dead gym uplink) has bars and a request
      // that cannot land, which reads as unreachable, not as "no signal".
      return isError ? 'pickerNoticeUnreachable' : 'pickerNotice';
    default:
      return assertNever(reason);
  }
}
