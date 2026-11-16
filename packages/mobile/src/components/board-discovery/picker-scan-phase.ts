// What the board picker's in-range slot shows, and when it scans by itself.
// Pure: every input is a flag the hook (use-picker-board-scan.ts) reads from
// the platform, so each phase and each reason not to scan is a table row in
// the tests.
//
// The slot scans by itself only when nothing about it can surprise the climber:
//   - Bluetooth is already allowed. The iOS alert and the Android dialog only
//     ever appear from the slot's button (`start`), never on picker open.
//   - Not in a browser: the Expo web BLE manager's scan does nothing and would
//     end in a false "no boards in range".
//   - This phone holds no board link: a connected box may stop advertising, so
//     the scan would not find the board the climber is on.
//   - No picker scan ended in the last 30 s. Opening the picker again shows the
//     button instead, which also keeps Android under its limit of 5 scan
//     starts per 30 s.
//   - Once per picker visit. A pick, or a scan already run, ends it.

import type { BoardScanStatus, BoardScanUnavailableReason } from '../../lib/ble/use-board-scan';
import type { BluetoothAuthorization } from '../../lib/ble/bluetooth-authorization';
import type { QuickstartLookupState } from './quickstart-scan-rows';

export type PickerScanPhase =
  /** Not shown: a browser, Bluetooth LE unsupported (a simulator, known only after a try), or a phone already connected to a board. */
  | 'hidden'
  /** Bluetooth not allowed yet. The button asks (the iOS alert, the Android dialog), then scans. */
  | 'needs_permission'
  /** Bluetooth refused for good (iOS denied or restricted, Android "don't ask again"): only Settings fixes it. */
  | 'blocked_denied'
  /** Bluetooth is off. */
  | 'blocked_off'
  /**
   * The radio could not be used for a reason the scan could not read (still
   * resetting, a platform answer it does not know). Bluetooth may well be on,
   * so the slot says it could not reach it rather than "Turn on Bluetooth".
   */
  | 'unreachable'
  /** Ready, waiting for a tap: auto-scan is switched off, a picker scan ended under 30 s ago, or another scan held the radio. */
  | 'tap_to_scan'
  /** Scanning, or about to. Rows may already hold boards heard so far. */
  | 'scanning'
  /** The scan ended and the rows are final. They may be empty. */
  | 'done';

/**
 * Bluetooth permission as read WITHOUT asking:
 * - 'checking': not read yet (Android's check is async; iOS reads at once).
 * - 'granted': a scan would run without a prompt.
 * - 'not_asked': a scan would ask first. Every Android "not granted" lands
 *   here: Android cannot tell never-asked from denied-once without asking, and
 *   the request is what learns "blocked" (the scan then ends 'unauthorized').
 * - 'blocked': iOS denied or restricted.
 */
export type PickerScanPermission = 'checking' | 'granted' | 'not_asked' | 'blocked';

/** How long after a picker scan ends the next picker open waits for a tap. */
export const PICKER_SCAN_COOLDOWN_MS = 30_000;

export type PickerScanInputs = {
  /** False in a browser (Expo web) or behind an installed test transport. */
  canScan: boolean;
  /** This phone holds a board link. */
  connectedToBoard: boolean;
  /** The picker is the screen on top. */
  focused: boolean;
  /** The app is not in the background. */
  appActive: boolean;
  /** The remote switch: false scans only on a tap. */
  autoStart: boolean;
  permission: PickerScanPermission;
  /** A picker scan ended under PICKER_SCAN_COOLDOWN_MS ago (`isWithinPickerScanCooldown`). */
  scannedRecently: boolean;
  /** This picker visit already scanned by itself, or a board was picked. */
  autoStartUsed: boolean;
  /**
   * A start is between its call and the radio: asking for permission, waiting
   * for the radio, or held until the app is 'active' again.
   */
  starting: boolean;
  scanStatus: BoardScanStatus;
  unavailableReason: BoardScanUnavailableReason | null;
  lookup: QuickstartLookupState;
};

export type PickerScanResolution = {
  phase: PickerScanPhase;
  /** Start a scan now, by itself ('picker_auto'). */
  autoStart: boolean;
};

/**
 * iOS authorization as the slot reads it. A null read is 'granted' only on a
 * binary with no native read (`hasNativeRead` false), which asked at launch, so
 * a scan never prompts there. A null from a binary that has the read is a read
 * that threw or answered something unknown: the question may still be open,
 * and scanning by itself would show the alert, so the button asks instead.
 */
export function pickerScanPermissionFromAuthorization(
  authorization: BluetoothAuthorization | null,
  hasNativeRead: boolean,
): PickerScanPermission {
  if (authorization === null) return hasNativeRead ? 'not_asked' : 'granted';
  if (authorization === 'notDetermined') return 'not_asked';
  if (authorization === 'denied' || authorization === 'restricted') return 'blocked';
  return 'granted';
}

/** Whether a picker scan that ended at `lastEndedAtMs` is under PICKER_SCAN_COOLDOWN_MS old. */
export function isWithinPickerScanCooldown(lastEndedAtMs: number | null, nowMs: number): boolean {
  return lastEndedAtMs !== null && nowMs - lastEndedAtMs < PICKER_SCAN_COOLDOWN_MS;
}

/** Every rule for scanning by itself except the permission and the scan state. */
function wouldScanByItself(inputs: PickerScanInputs): boolean {
  return (
    inputs.canScan &&
    !inputs.connectedToBoard &&
    inputs.focused &&
    inputs.appActive &&
    inputs.autoStart &&
    !inputs.scannedRecently &&
    !inputs.autoStartUsed
  );
}

function phaseForUnavailable(reason: BoardScanUnavailableReason | null): PickerScanPhase {
  switch (reason) {
    // No Bluetooth LE at all (a simulator, a browser): nothing to offer.
    case 'unsupported':
      return 'hidden';
    case 'unauthorized':
      return 'blocked_denied';
    // An Android "Don't allow" in the dialog, or an iOS alert left unanswered:
    // the button asks again.
    case 'permission_denied':
    case 'not_asked':
      return 'needs_permission';
    case 'powered_off':
      return 'blocked_off';
    // A radio the scan couldn't use for a reason it couldn't read (still
    // resetting, say). "Turn on Bluetooth" would be wrong when it is on, so the
    // slot says it couldn't reach Bluetooth, with Scan again.
    case 'unknown':
    case null:
      return 'unreachable';
  }
}

/**
 * How long the scan must have listened before a serial-less row standing for
 * one box can be trusted to mean one box: a second MoonBoard in the same gym
 * may simply not have been heard yet. A scan that ran to its end (15 s) always
 * qualifies; one the climber's tap cut short at 2 s does not.
 */
export const SOLE_BOX_MIN_LISTEN_MS = 5_000;

/**
 * Whether the scan behind the rows listened long enough for "one box" to mean
 * one box. `endedAtMs` is null while it still runs (read at `nowMs`), and
 * `startedAtMs` null when no scan ran.
 */
export function listenedLongEnoughForSoleBox({
  startedAtMs,
  endedAtMs,
  nowMs,
}: {
  startedAtMs: number | null;
  endedAtMs: number | null;
  nowMs: number;
}): boolean {
  if (startedAtMs === null) return false;
  return (endedAtMs ?? nowMs) - startedAtMs >= SOLE_BOX_MIN_LISTEN_MS;
}

export function resolvePickerScan(inputs: PickerScanInputs): PickerScanResolution {
  const scansByItself = wouldScanByItself(inputs);
  const autoStart =
    scansByItself && inputs.permission === 'granted' && inputs.scanStatus === 'idle' && !inputs.starting;
  return { phase: resolvePhase(inputs, scansByItself), autoStart };
}

function resolvePhase(inputs: PickerScanInputs, scansByItself: boolean): PickerScanPhase {
  if (!inputs.canScan || inputs.connectedToBoard) return 'hidden';
  // A start on its way (asking, waiting on the radio, held for the app) reads
  // as scanning whatever the last scan ended at: after an Allow, the old
  // refusal's Continue card must not come back while the new start runs.
  if (inputs.starting) return 'scanning';
  switch (inputs.scanStatus) {
    // Another owner held ble-plx's one scan (the rest timer, an Android
    // connect). "No boards in range" would be untrue; the button tries again.
    case 'busy':
      return 'tap_to_scan';
    case 'unavailable':
      return phaseForUnavailable(inputs.unavailableReason);
    case 'scanning':
      return 'scanning';
    // The radio stops before the serial lookup has named what it heard.
    case 'done':
      return inputs.lookup === 'pending' || inputs.lookup === 'updating' ? 'scanning' : 'done';
    case 'idle':
      break;
  }
  switch (inputs.permission) {
    case 'blocked':
      return 'blocked_denied';
    case 'not_asked':
      return 'needs_permission';
    // Android's read takes a moment. Show what a granted read would, so the
    // common case doesn't flash the button before the scan starts.
    case 'checking':
    case 'granted':
      return scansByItself ? 'scanning' : 'tap_to_scan';
  }
}
