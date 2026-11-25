// The board picker's in-range slot: scans for boards by itself when the picker
// opens, and hands the picker a phase and rows to render. The rules are in
// picker-scan-phase.ts (when to scan, what to show) and quickstart-scan-rows.ts
// (what each board heard becomes); this hook reads the platform into them and
// runs the scan's lifecycle.
//
// Lives in board-discovery rather than lib/ble because it is the in-range scan
// composition (use-quickstart-scan.ts) plus picker rules. The Bluetooth parts
// it needs (the scan, the slot claim, the permission reads) stay in lib/ble.
//
// Lifecycle, beyond picker-scan-phase.ts:
//   - Permission is read without asking: `readBluetoothAuthorization()` on iOS
//     (no Bluetooth manager is created while the question is unanswered, so the
//     alert cannot appear on picker open), `PermissionsAndroid.check` on
//     Android. Read again when the picker regains focus and when the app comes
//     back to the foreground (the climber may have been to Settings).
//   - The scan ends early, keeping what it heard, when the picker loses focus,
//     the app goes to the background (Android pauses the 15 s timer there), the
//     phone connects to a board, or `stop()` (a pick). The 'inactive' iOS state
//     (the Bluetooth alert itself, Control Center) is not the background.
//   - It claims ble-plx's one scan and never takes it from the rest timer or an
//     Android connect: a held scan leaves the button ('busy'). Its own claim is
//     pre-emptible: any other scan takes the radio at once, and this one ends
//     keeping what it heard.
//   - A start, by itself or tapped, claims the radio only while the app is
//     'active'. One that gets through the permission and power checks while it
//     is not (Android's permission dialog reads as the background, and its
//     answer can land before AppState says 'active' again; the iOS alert reads
//     as 'inactive') is held, not dropped and not run. The next time the app
//     becomes 'active' with the picker still on top, the held start runs once:
//     it claims the radio and scans. Leaving the picker, a pick, a board link
//     or unmounting drop it. A held start never reached the radio, so it
//     stamps no cooldown. Running it in the background would spend one of
//     Android's 5 scan starts per 30 s on a scan nobody sees, and the scan
//     would end at once (the background ends a running scan).
//   - While the slot says Bluetooth is off, the radio coming on starts a scan
//     (`watchBluetoothPoweredOn`), reported as a tap: the climber turned it on
//     because the slot asked (Android's Turn on Bluetooth dialog, iOS Control
//     Center). Only with auto-scan on, only once per time the slot says off,
//     and never after a pick (`stop()`) until the next tap. A radio start held
//     for the app (Android's dialog reads as the background) is dropped once
//     the radio came on more than RADIO_ON_START_MAX_HOLD_MS ago: by then the
//     climber has moved on. It reports as 'picker_tap' because the trigger
//     type lives in lib/ble/use-board-scan.ts.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';
import type { UserBoard } from '@boardsesh/shared-schema';
import { hasBluetoothAuthorizationRead, readBluetoothAuthorization } from '../../lib/ble/bluetooth-authorization';
import { useBluetoothConnectedStatus } from '../../lib/ble/bluetooth-status-store';
import { bluetoothTransport } from '../../lib/ble/transport-runtime';
import { hasAndroidBleScanPermissions } from '../../lib/ble/use-ble-permissions';
import type { BoardScanTrigger } from '../../lib/ble/use-board-scan';
import { openAppSettings } from '../../lib/open-app-settings';
import { watchBluetoothPoweredOn } from './bluetooth-radio';
import {
  isWithinPickerScanCooldown,
  listenedLongEnoughForSoleBox,
  PICKER_SCAN_COOLDOWN_MS,
  pickerScanPermissionFromAuthorization,
  resolvePickerScan,
  type PickerScanPermission,
  type PickerScanPhase,
} from './picker-scan-phase';
import type { QuickstartLookupState, QuickstartRow } from './quickstart-scan-rows';
import { useQuickstartScan } from './use-quickstart-scan';

export type { PickerScanPhase } from './picker-scan-phase';

export type PickerScan = {
  phase: PickerScanPhase;
  /** As `buildQuickstartRows`, strongest first, with recognised serial-less boxes named. */
  rows: QuickstartRow[];
  /**
   * Where the serial lookup stands. `pending`: serials were heard and the
   * scan's first answer is out, so `rows` hold back every serial row and the
   * slot holds its place rather than show an order the answer would rearrange.
   * `updating`: `rows` keep the answer already drawn while the serials heard
   * since are looked up.
   */
  lookup: QuickstartLookupState;
  /**
   * Whether the scan behind `rows` listened long enough (or ran to its end) for
   * a serial-less row standing for one box to mean one box. Read at the tap,
   * before `stop()`. See `listenedLongEnoughForSoleBox`.
   */
  listenedLongEnough: () => boolean;
  /** The Continue / tap-to-scan / Scan again button: asks for Bluetooth when needed, then scans. */
  start: () => void;
  /** End the scan, keeping its rows. Call on any pick. */
  stop: () => void;
  openSettings: () => void;
  /** Run the serial lookup again, for the "need signal" row. */
  retryLookup: () => void;
};

/** How long a scan the radio coming on asked for may wait for the app to be 'active'. */
export const RADIO_ON_START_MAX_HOLD_MS = 60_000;

// When the last picker scan ended, across picker visits: the picker is a modal
// route, so every open is a new mount.
let lastPickerScanEndedAt: number | null = null;

function canScanHere(): boolean {
  // An installed transport (the screenshot fake) owns discovery: a scan
  // through it ends at once with nothing heard.
  return Platform.OS !== 'web' && bluetoothTransport() === undefined;
}

function readIosPermission(): PickerScanPermission {
  return pickerScanPermissionFromAuthorization(readBluetoothAuthorization(), hasBluetoothAuthorizationRead());
}

function initialPermission(): PickerScanPermission {
  return Platform.OS === 'ios' ? readIosPermission() : 'checking';
}

async function readPermission(): Promise<PickerScanPermission> {
  if (Platform.OS !== 'android') return readIosPermission();
  // A check that threw reads as not granted: the button's request finds out.
  return (await hasAndroidBleScanPermissions()) === true ? 'granted' : 'not_asked';
}

export function usePickerBoardScan({
  focused,
  autoStart,
  knownBoards,
}: {
  /** The picker is the screen on top (`useIsFocused`). */
  focused: boolean;
  /** The remote switch for scanning on open. False: the slot waits for a tap. */
  autoStart: boolean;
  /** The climber's own and followed boards (the picker's `myBoards`), which a recognised serial-less box may be named as. */
  knownBoards: readonly UserBoard[];
}): PickerScan {
  const canScan = canScanHere();
  const connectedToBoard = useBluetoothConnectedStatus();

  // Checked by the scan right before it claims the radio: only an 'active' app
  // starts it. Anything else holds the start (see the file comment).
  const startHeldRef = useRef(false);
  const mayStartRadio = useCallback(() => {
    if (AppState.currentState === 'active') return true;
    startHeldRef.current = true;
    return false;
  }, []);
  const {
    status,
    unavailableReason,
    rows,
    lookup,
    start: startScan,
    reset,
    finish,
    retryLookup,
  } = useQuickstartScan({
    mayStartRadio,
    knownBoards,
  });

  const [permission, setPermission] = useState<PickerScanPermission>(initialPermission);
  const [appActive, setAppActive] = useState(() => AppState.currentState !== 'background');
  const [scannedRecently, setScannedRecently] = useState(() =>
    isWithinPickerScanCooldown(lastPickerScanEndedAt, Date.now()),
  );
  const [autoStartUsed, setAutoStartUsed] = useState(false);
  const [starting, setStarting] = useState(false);
  // A start that passed its checks while the app was not 'active', waiting to
  // claim the radio once it is. Who started it, so it reports as that.
  const [heldStart, setHeldStart] = useState<BoardScanTrigger | null>(null);
  // Bumped each time the app becomes 'active', for the held start to run on.
  const [activations, setActivations] = useState(0);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // The latest scan state, for callbacks that must not re-subscribe on it.
  const startPending = starting || heldStart !== null;
  const scanStateRef = useRef({ status, unavailableReason, startPending, connectedToBoard, permission });
  scanStateRef.current = { status, unavailableReason, startPending, connectedToBoard, permission };

  // Foreground and background. 'inactive' (the iOS Bluetooth alert, Control
  // Center) keeps the scan: it is not the background.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextAppState) => {
      if (nextAppState === 'active') {
        setAppActive(true);
        setActivations((count) => count + 1);
      } else if (nextAppState === 'background') {
        setAppActive(false);
      }
    });
    return () => subscription.remove();
  }, []);

  // Read the permission and the cooldown again whenever the slot comes back on
  // screen. An Android grant made in Settings after the scan was refused gets
  // a fresh start: drop the refusal back to idle, and the rules decide whether
  // it scans by itself. (iOS relaunches the app when that switch moves.) Not
  // while a start is on its way or held: a deny, then Continue and an Allow in
  // the dialog, leaves the old refusal showing until that start reaches the
  // radio, and a reset now would cancel the start the climber just made.
  useEffect(() => {
    if (!canScan || !focused || !appActive) return;
    setScannedRecently(isWithinPickerScanCooldown(lastPickerScanEndedAt, Date.now()));
    let cancelled = false;
    void readPermission().then((nextPermission) => {
      if (cancelled) return;
      setPermission(nextPermission);
      const { status: scanStatus, unavailableReason: reason, startPending: startOnItsWay } = scanStateRef.current;
      const refusedForPermission =
        scanStatus === 'unavailable' && (reason === 'unauthorized' || reason === 'permission_denied');
      if (Platform.OS === 'android' && nextPermission === 'granted' && refusedForPermission && !startOnItsWay) {
        reset();
      }
    });
    return () => {
      cancelled = true;
    };
  }, [canScan, focused, appActive, reset]);

  // The cooldown runs out while the picker is open: the slot may then scan by
  // itself, as a fresh open would.
  useEffect(() => {
    if (!scannedRecently || lastPickerScanEndedAt === null) return;
    const remainingMs = lastPickerScanEndedAt + PICKER_SCAN_COOLDOWN_MS - Date.now();
    const timer = setTimeout(() => setScannedRecently(false), Math.max(0, remainingMs));
    return () => clearTimeout(timer);
  }, [scannedRecently]);

  // Stamp the start and end of every radio scan this slot ran, however it ended
  // (timeout, finish, error, pre-emption, unmount): the end for the next picker
  // open's cooldown, both for how long the rows' scan listened.
  const scanStartedAtRef = useRef<number | null>(null);
  const scanEndedAtRef = useRef<number | null>(null);
  useEffect(() => {
    if (status !== 'scanning') return;
    scanStartedAtRef.current = Date.now();
    scanEndedAtRef.current = null;
    return () => {
      const endedAt = Date.now();
      lastPickerScanEndedAt = endedAt;
      scanEndedAtRef.current = endedAt;
    };
  }, [status]);
  const listenedLongEnough = useCallback(
    () =>
      listenedLongEnoughForSoleBox({
        startedAtMs: scanStartedAtRef.current,
        endedAtMs: scanEndedAtRef.current,
        nowMs: Date.now(),
      }),
    [],
  );

  // One start at a time. `starting` covers the permission prompt and the wait
  // for the radio, and a held start waits for the app, so the slot reads
  // 'scanning' through all three, not the button.
  const startAttemptRef = useRef(0);
  // When the radio came on, for a held start that the radio asked for; null
  // for every other held start.
  const heldRadioOnAtRef = useRef<number | null>(null);
  const runStart = useCallback(
    (trigger: BoardScanTrigger, radioOnAtMs: number | null = null) => {
      const attempt = startAttemptRef.current + 1;
      startAttemptRef.current = attempt;
      startHeldRef.current = false;
      heldRadioOnAtRef.current = null;
      setHeldStart(null);
      setStarting(true);
      const settle = () => {
        if (!mountedRef.current || startAttemptRef.current !== attempt) return;
        setStarting(false);
        // Through every check, but the app was not 'active': run it when it is.
        if (startHeldRef.current) {
          heldRadioOnAtRef.current = radioOnAtMs;
          setHeldStart(trigger);
        }
        // The request may have changed the answer (an iOS Allow, an Android grant).
        void readPermission().then((nextPermission) => {
          if (mountedRef.current) setPermission(nextPermission);
        });
      };
      void startScan(trigger).then(settle, settle);
    },
    [startScan],
  );

  // A held start runs once the app is 'active' again with the picker on top,
  // and goes when the picker does or the phone links to a board. AppState
  // itself is read, not the event: the two can race, and a start run while the
  // app is still not 'active' would only be held again. A dropped start the
  // slot meant to run by itself may run by itself again later: it never ran.
  useEffect(() => {
    if (heldStart === null) return;
    const radioOnAtMs = heldRadioOnAtRef.current;
    const staleRadioStart = radioOnAtMs !== null && Date.now() - radioOnAtMs > RADIO_ON_START_MAX_HOLD_MS;
    if (!focused || connectedToBoard || !canScan || staleRadioStart) {
      startAttemptRef.current += 1;
      heldRadioOnAtRef.current = null;
      setHeldStart(null);
      if (heldStart === 'picker_auto') setAutoStartUsed(false);
      return;
    }
    if (AppState.currentState === 'active') runStart(heldStart, radioOnAtMs);
  }, [heldStart, focused, connectedToBoard, canScan, activations, runStart]);

  const resolution = resolvePickerScan({
    canScan,
    connectedToBoard,
    focused,
    appActive,
    autoStart,
    permission,
    scannedRecently,
    autoStartUsed,
    starting: startPending,
    scanStatus: status,
    unavailableReason,
    lookup,
  });

  // A pick ended this visit's scanning (`stop()`): the radio coming on starts
  // nothing until the climber taps a scan again.
  const pickedRef = useRef(false);

  // The slot says Bluetooth is off: scan once the radio reports on. A start
  // from the callback reads the latest state, so a scan already on its way (a
  // tap that raced the radio) is not started twice.
  const waitsForRadio =
    canScan &&
    focused &&
    autoStart &&
    !connectedToBoard &&
    status === 'unavailable' &&
    unavailableReason === 'powered_off';
  useEffect(() => {
    if (!waitsForRadio) return;
    return watchBluetoothPoweredOn(() => {
      const { status: scanStatus, startPending: alreadyStarting, connectedToBoard: connected } = scanStateRef.current;
      if (pickedRef.current || connected || alreadyStarting || scanStatus !== 'unavailable') return;
      runStart('picker_tap', Date.now());
    });
  }, [waitsForRadio, runStart]);

  const shouldAutoStart = resolution.autoStart;
  useEffect(() => {
    if (!shouldAutoStart) return;
    setAutoStartUsed(true);
    runStart('picker_auto');
  }, [shouldAutoStart, runStart]);

  // End the scan, keeping its rows, once the slot is out of sight or the phone
  // holds a board. Leaving the picker or connecting also drops a start still
  // waiting on the radio. The background only ends a running scan: a start
  // still on its way is held at the radio instead (`mayStartRadio`), because
  // Android reports its permission dialog as the background.
  useEffect(() => {
    const leaving = !focused || connectedToBoard;
    if ((leaving && (status === 'scanning' || starting)) || (!appActive && status === 'scanning')) finish();
  }, [focused, connectedToBoard, appActive, status, starting, finish]);

  const start = useCallback(() => {
    const { status: scanStatus, startPending: alreadyStarting, connectedToBoard: connected } = scanStateRef.current;
    if (!canScan || connected || alreadyStarting || scanStatus === 'scanning') return;
    pickedRef.current = false;
    runStart('picker_tap');
  }, [canScan, runStart]);

  const stop = useCallback(() => {
    // A pick ends this visit's scanning: nothing starts by itself after it, and
    // a start still on its way or held for the app goes too.
    startAttemptRef.current += 1;
    pickedRef.current = true;
    heldRadioOnAtRef.current = null;
    setStarting(false);
    setHeldStart(null);
    setAutoStartUsed(true);
    finish();
  }, [finish]);

  const openSettings = useCallback(() => {
    void openAppSettings();
  }, []);

  return useMemo(
    () => ({
      phase: resolution.phase,
      rows,
      lookup,
      listenedLongEnough,
      start,
      stop,
      openSettings,
      retryLookup,
    }),
    [resolution.phase, rows, lookup, listenedLongEnough, start, stop, openSettings, retryLookup],
  );
}
