// The board picker's in-range slot: scans for boards by itself when the picker
// opens, and hands the picker a phase and rows to render. The rules are in
// picker-scan-phase.ts (when to scan, what to show) and quickstart-scan-rows.ts
// (what each board heard becomes); this hook reads the platform into them and
// runs the scan's lifecycle.
//
// Lives beside the quickstart sheet rather than in lib/ble because it is the
// sheet's scan composition (use-quickstart-scan.ts) plus picker rules. The
// Bluetooth parts it needs (the scan, the slot claim, the permission reads)
// stay in lib/ble.
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
//   - A start still waiting on the radio never starts it in the background
//     (it would spend one of Android's 5 scan starts per 30 s), unless the
//     start asked for permission: Android reports its dialog as the background.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';
import type { UserBoard } from '@boardsesh/shared-schema';
import { hasBluetoothAuthorizationRead, readBluetoothAuthorization } from '../../lib/ble/bluetooth-authorization';
import { useBluetoothConnectedStatus } from '../../lib/ble/bluetooth-status-store';
import { bluetoothTransport } from '../../lib/ble/transport-runtime';
import { hasAndroidBleScanPermissions } from '../../lib/ble/use-ble-permissions';
import type { BoardScanTrigger } from '../../lib/ble/use-board-scan';
import { openAppSettings } from '../../lib/open-app-settings';
import {
  isWithinPickerScanCooldown,
  PICKER_SCAN_COOLDOWN_MS,
  pickerScanPermissionFromAuthorization,
  resolvePickerScan,
  type PickerScanPermission,
  type PickerScanPhase,
} from './picker-scan-phase';
import type { QuickstartRow } from './quickstart-scan-rows';
import { useQuickstartScan } from './use-quickstart-scan';

export type { PickerScanPhase } from './picker-scan-phase';

export type PickerScan = {
  phase: PickerScanPhase;
  /** As `buildQuickstartRows`, strongest first, with recognised serial-less boxes named. */
  rows: QuickstartRow[];
  /** The Continue / tap-to-scan / Scan again button: asks for Bluetooth when needed, then scans. */
  start: () => void;
  /** End the scan, keeping its rows. Call on any pick. */
  stop: () => void;
  openSettings: () => void;
  /** Run the serial lookup again, for the "need signal" row. */
  retryLookup: () => void;
};

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

  // Checked by the scan right before it claims the radio. A start that asked
  // for permission may still read Android's dialog as the background then, so
  // it goes on; any other start in the background is dropped and noted.
  const startAskedForPermissionRef = useRef(false);
  const startDroppedInBackgroundRef = useRef(false);
  const mayStartRadio = useCallback(() => {
    if (AppState.currentState !== 'background' || startAskedForPermissionRef.current) return true;
    startDroppedInBackgroundRef.current = true;
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
    slotPolicy: 'claim',
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

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // The latest scan state, for callbacks that must not re-subscribe on it.
  const scanStateRef = useRef({ status, unavailableReason, starting, connectedToBoard, permission });
  scanStateRef.current = { status, unavailableReason, starting, connectedToBoard, permission };

  // Foreground and background. 'inactive' (the iOS Bluetooth alert, Control
  // Center) keeps the scan: it is not the background.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextAppState) => {
      if (nextAppState === 'active') setAppActive(true);
      else if (nextAppState === 'background') setAppActive(false);
    });
    return () => subscription.remove();
  }, []);

  // Read the permission and the cooldown again whenever the slot comes back on
  // screen. An Android grant made in Settings after the scan was refused gets
  // a fresh start: drop the refusal back to idle, and the rules decide whether
  // it scans by itself. (iOS relaunches the app when that switch moves.)
  useEffect(() => {
    if (!canScan || !focused || !appActive) return;
    setScannedRecently(isWithinPickerScanCooldown(lastPickerScanEndedAt, Date.now()));
    let cancelled = false;
    void readPermission().then((nextPermission) => {
      if (cancelled) return;
      setPermission(nextPermission);
      const { status: scanStatus, unavailableReason: reason } = scanStateRef.current;
      const refusedForPermission =
        scanStatus === 'unavailable' && (reason === 'unauthorized' || reason === 'permission_denied');
      if (Platform.OS === 'android' && nextPermission === 'granted' && refusedForPermission) reset();
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

  // Stamp the end of every radio scan this slot ran, however it ended
  // (timeout, finish, error, unmount), for the next picker open's cooldown.
  useEffect(() => {
    if (status !== 'scanning') return;
    return () => {
      lastPickerScanEndedAt = Date.now();
    };
  }, [status]);

  // One start at a time. `starting` covers the permission prompt and the wait
  // for the radio, so the slot reads 'scanning' through them, not the button.
  const startAttemptRef = useRef(0);
  const runStart = useCallback(
    (trigger: BoardScanTrigger) => {
      const attempt = startAttemptRef.current + 1;
      startAttemptRef.current = attempt;
      startAskedForPermissionRef.current = scanStateRef.current.permission !== 'granted';
      startDroppedInBackgroundRef.current = false;
      setStarting(true);
      const settle = () => {
        if (!mountedRef.current || startAttemptRef.current !== attempt) return;
        setStarting(false);
        if (startDroppedInBackgroundRef.current) {
          // Never reached the radio: the app is in the background now (its
          // AppState event may still be on the way), and a scan the slot
          // started by itself may start again once the app is back.
          setAppActive(AppState.currentState !== 'background');
          if (trigger === 'picker_auto') setAutoStartUsed(false);
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

  const resolution = resolvePickerScan({
    canScan,
    connectedToBoard,
    focused,
    appActive,
    autoStart,
    permission,
    scannedRecently,
    autoStartUsed,
    starting,
    scanStatus: status,
    unavailableReason,
    lookup,
  });

  const shouldAutoStart = resolution.autoStart;
  useEffect(() => {
    if (!shouldAutoStart) return;
    setAutoStartUsed(true);
    runStart('picker_auto');
  }, [shouldAutoStart, runStart]);

  // End the scan, keeping its rows, once the slot is out of sight or the phone
  // holds a board. Leaving the picker or connecting also drops a start still
  // waiting on the radio. The background only ends a running scan: Android
  // reports its permission dialog as the background, and that start must go on.
  useEffect(() => {
    const leaving = !focused || connectedToBoard;
    if ((leaving && (status === 'scanning' || starting)) || (!appActive && status === 'scanning')) finish();
  }, [focused, connectedToBoard, appActive, status, starting, finish]);

  const start = useCallback(() => {
    const { status: scanStatus, starting: alreadyStarting, connectedToBoard: connected } = scanStateRef.current;
    if (!canScan || connected || alreadyStarting || scanStatus === 'scanning') return;
    runStart('picker_tap');
  }, [canScan, runStart]);

  const stop = useCallback(() => {
    // A pick ends this visit's scanning: nothing starts by itself after it.
    setAutoStartUsed(true);
    finish();
  }, [finish]);

  const openSettings = useCallback(() => {
    void openAppSettings();
  }, []);

  return useMemo(
    () => ({ phase: resolution.phase, rows, start, stop, openSettings, retryLookup }),
    [resolution.phase, rows, start, stop, openSettings, retryLookup],
  );
}
