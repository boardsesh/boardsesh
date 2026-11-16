import { bluetoothTransport } from './transport-runtime';
// Scan-only BLE discovery for the "Bluetooth quickstart" board picker. Unlike
// the adapter's requestAndConnect (which scans *and* opens a UART connection),
// this only listens for in-range boards. Aurora boxes that advertise a serial
// are collected by serial — the picker then resolves serials to boards via
// GET_BOARDS_BY_SERIAL_NUMBERS and sets the chosen one active. MoonBoards and
// Kilter-built boxes advertise no serial; they are collected by device id with
// their board type, so the sheet can say what it heard instead of "No boards in
// range" (see quickstart-scan-device.ts). No connection is opened here;
// connecting happens later when the user enters play mode.
//
// The board type each device advertises is collected alongside its serial.
// Aurora reuses a serial across board apps, so without it this sheet would
// happily offer a stranger's Kilter board for an in-range Tension controller
// and let the user make it active — the Benchmark Climbing bug, one surface
// over from the connect-time picker.

import { useCallback, useEffect, useRef, useState } from 'react';
import { advertisedBoardTypesBySerial, type AdvertisedBoardTypes } from './advertised-board-type';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { track } from '../analytics';
import { getBleManager } from './ble-manager';
import { claimBleScan, noteBleScanStarted, releaseBleScan } from './ble-scan-slot';
import { waitForBlePoweredOn } from './availability';
import {
  classifyQuickstartDevice,
  compareBySignal,
  type QuickstartScanDevice,
  type QuickstartSerialDevice,
} from './quickstart-scan-device';
import { HIGH_POWER_BOARD_SCAN_OPTIONS } from './scan-options';
import { requestBleRuntimePermissionStatus } from './use-ble-permissions';
import { describeBlePermissionDenial } from './android-location-permission';
import {
  readBluetoothUnavailableReason,
  trackBluetoothUnavailable,
  type BluetoothUnavailableReason,
} from './bluetooth-unavailable';

const SCAN_TIMEOUT_MS = 15_000;

// Stable empty identity so a reset doesn't hand consumers a fresh Map every
// render (and churn the query key built from it).
const EMPTY_ADVERTISED_TYPES: AdvertisedBoardTypes = new Map();
const EMPTY_DEVICES: readonly QuickstartScanDevice[] = [];

/**
 * 'busy': a scan with the 'claim' slot policy found ble-plx's one scan held by
 * someone else (the rest timer, an Android connect) and never started the radio.
 */
export type BoardScanStatus = 'idle' | 'scanning' | 'done' | 'unavailable' | 'busy';

/**
 * Who started a scan, sent as Board Quickstart Scan Finished's `trigger`. The
 * board picker's in-range slot scans on most picker opens, so without it that
 * event's series would stop meaning "a climber opened the Bluetooth sheet".
 * 'sheet' is the Bluetooth quickstart sheet, 'picker_auto' the in-range slot
 * scanning by itself, 'picker_tap' its scan button.
 */
export type BoardScanTrigger = 'sheet' | 'picker_auto' | 'picker_tap';

/**
 * How a scan gets ble-plx's one scan (ble-scan-slot.ts).
 * - 'take': whatever holds it loses it, as the quickstart sheet always has. The
 *   climber opened the sheet to scan.
 * - 'claim': only while nobody holds it, else the scan ends at 'busy'. The
 *   picker's in-range slot scans without being asked, so it must never stop the
 *   rest timer's scan (rogue-timer-ble.ts) or an Android connect's (adapter.ts).
 */
export type BoardScanSlotPolicy = 'take' | 'claim';

/**
 * Why a scan is 'unavailable', so the sheet can say something the climber can
 * act on. 'permission_denied' is an Android "Don't allow" answered in the dialog:
 * scanning again shows the dialog again. A blocked permission (iOS denial,
 * Android never-ask-again) is 'unauthorized', which only the Settings app fixes.
 * 'not_asked' is an iOS Bluetooth alert left unanswered: scanning again asks.
 */
export type BoardScanUnavailableReason = 'permission_denied' | BluetoothUnavailableReason;

type BoardScanOutcome = 'completed' | 'stopped' | 'error';

export type BoardScan = {
  status: BoardScanStatus;
  /** Set while `status` is 'unavailable', null otherwise. */
  unavailableReason: BoardScanUnavailableReason | null;
  /** Distinct serial numbers parsed from in-range device names. */
  serials: string[];
  /** Board type advertised for each of those serials, where the name carried one. */
  advertisedTypes: AdvertisedBoardTypes;
  /**
   * Every board heard, serial or not, strongest signal first: one entry per
   * serial and one per serial-less device (a MoonBoard, a Kilter-built box).
   */
  devices: readonly QuickstartScanDevice[];
  /** Start a scan. `trigger` defaults to the sheet, whose scans came first. */
  start: (trigger?: BoardScanTrigger) => Promise<void>;
  /** Stop any in-flight scan and return to idle (e.g. when the sheet closes). */
  reset: () => void;
  /**
   * End a running scan now and keep what it heard: 'done', reported as
   * 'stopped'. Also drops a start still waiting on a permission or the radio,
   * which leaves the status where it was. For the picker's in-range slot, whose
   * rows outlive the scan (it leaves the screen, the app goes to the
   * background, a board is picked).
   */
  finish: () => void;
};

export function useBoardScan({ slotPolicy = 'take' }: { slotPolicy?: BoardScanSlotPolicy } = {}): BoardScan {
  const [status, setStatus] = useState<BoardScanStatus>('idle');
  const [unavailableReason, setUnavailableReason] = useState<BoardScanUnavailableReason | null>(null);
  const [serials, setSerials] = useState<string[]>([]);
  const [advertisedTypes, setAdvertisedTypes] = useState<AdvertisedBoardTypes>(EMPTY_ADVERTISED_TYPES);
  const [devices, setDevices] = useState<readonly QuickstartScanDevice[]>(EMPTY_DEVICES);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scanningRef = useRef(false);
  const scanToken = useRef(Symbol('board-quickstart-scan'));
  // What the running scan heard, for Board Quickstart Scan Finished. Serials
  // alone keep `found_count`'s series comparable with scans from before
  // serial-less boards were kept.
  const foundCountRef = useRef(0);
  const seriallessCountRef = useRef(0);
  const moonboardCountRef = useRef(0);
  const scanAttemptRef = useRef(0);
  // Who started the running scan, for its Board Quickstart Scan Finished, and
  // who asked for the start in progress (`start` sets it, the scan reads it).
  const triggerRef = useRef<BoardScanTrigger>('sheet');
  const requestedTriggerRef = useRef<BoardScanTrigger>('sheet');
  // A device event can land in the BLE callback just after unmount; gate the
  // state writes so we don't setState on an unmounted component.
  const mountedRef = useRef(true);

  // Every way a running scan ends comes through here, so each one reports once.
  // A scan that never started the radio (blocked, radio off) reports nothing.
  const stop = useCallback((outcome: BoardScanOutcome) => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    if (scanningRef.current) {
      if (releaseBleScan(scanToken.current)) void getBleManager().stopDeviceScan();
      scanningRef.current = false;
      track(SHARED_EVENTS.BoardQuickstartScanFinished, {
        outcome,
        found_count: foundCountRef.current,
        serialless_count: seriallessCountRef.current,
        moonboard_count: moonboardCountRef.current,
        trigger: triggerRef.current,
      });
    }
  }, []);

  const showUnavailable = useCallback((reason: BoardScanUnavailableReason) => {
    setUnavailableReason(reason);
    setStatus('unavailable');
  }, []);

  const startScan = useCallback(async () => {
    if (scanningRef.current) return;
    const trigger = requestedTriggerRef.current;
    if (bluetoothTransport()?.discovery === 'external') {
      setStatus('done');
      return;
    }

    const scanAttempt = scanAttemptRef.current + 1;
    scanAttemptRef.current = scanAttempt;
    const isCurrentScanAttempt = () => mountedRef.current && scanAttemptRef.current === scanAttempt;

    const permissionStatus = await requestBleRuntimePermissionStatus();
    if (!isCurrentScanAttempt()) return;

    if (permissionStatus === 'unsupported') {
      // Expo web in a browser with no Web Bluetooth: not a denial, and nothing
      // the climber can allow or retry.
      trackBluetoothUnavailable('unsupported', 'quickstart_scan');
      showUnavailable('unsupported');
      return;
    }

    if (permissionStatus !== 'granted') {
      // Previously silent: the sheet just flipped to 'unavailable' and nothing
      // told us a denial (rather than a dead radio) was behind it.
      void describeBlePermissionDenial().then((denialContext) => {
        track(SHARED_EVENTS.BluetoothPermissionDenied, { ...denialContext, surface: 'quickstart_scan' });
      });
      if (permissionStatus === 'blocked') {
        trackBluetoothUnavailable('unauthorized', 'quickstart_scan');
        showUnavailable('unauthorized');
      } else {
        showUnavailable('permission_denied');
      }
      return;
    }

    const bluetoothPoweredOn = await waitForBlePoweredOn();
    if (!isCurrentScanAttempt()) return;

    if (!bluetoothPoweredOn) {
      // iOS reports a denied Bluetooth permission here, not from the permission
      // request above: waitForBlePoweredOn is where iOS asks (at this first scan,
      // on binaries that no longer ask at launch) and hears the answer.
      const reason = await readBluetoothUnavailableReason();
      if (!isCurrentScanAttempt()) return;
      trackBluetoothUnavailable(reason, 'quickstart_scan');
      showUnavailable(reason);
      return;
    }

    // The one scan ble-plx runs. A 'claim' scan skips rather than stop another
    // owner's; nothing has been reset yet, so a skipped scan changes nothing
    // but its status.
    if (slotPolicy === 'claim' && !claimBleScan(scanToken.current)) {
      setStatus('busy');
      return;
    }

    // Keyed by `QuickstartScanDevice.key`: a serial box once per serial, as the
    // lookup has always counted them, a serial-less board once per device id.
    const found = new Map<string, QuickstartScanDevice>();
    // Which entry each BLE device is listed under, so a device that turns out
    // to carry a serial replaces its own serial-less entry.
    const keyByDeviceId = new Map<string, string>();
    const serialDevices: QuickstartSerialDevice[] = [];
    foundCountRef.current = 0;
    seriallessCountRef.current = 0;
    moonboardCountRef.current = 0;
    setSerials([]);
    setAdvertisedTypes(EMPTY_ADVERTISED_TYPES);
    setDevices(EMPTY_DEVICES);
    setUnavailableReason(null);
    setStatus('scanning');
    scanningRef.current = true;
    triggerRef.current = trigger;
    if (slotPolicy === 'take') noteBleScanStarted(scanToken.current);

    // Scan UNFILTERED, then keep only what classifyQuickstartDevice recognises.
    // A hardware service-UUID ScanFilter drops boards on Android when the UUID
    // rides the scan-response PDU, leaving an empty quickstart list — same root
    // cause as the picker scan in adapter.ts.
    // High-power scan options (LowLatency on Android) — see scan-options.ts.
    void getBleManager().startDeviceScan(null, HIGH_POWER_BOARD_SCAN_OPTIONS, (error, device) => {
      if (!isCurrentScanAttempt()) return;
      if (error) {
        stop('error');
        // Radio switched off or permission pulled mid-scan: work out which before
        // showing anything, so the sheet goes straight to the right copy instead
        // of "Turn on Bluetooth" flipping to "blocked" a tick later. The read
        // never rejects. It is tracked even if the sheet closed meanwhile, so
        // every stop is counted; only the state write needs the attempt check.
        void readBluetoothUnavailableReason().then((reason) => {
          trackBluetoothUnavailable(reason, 'quickstart_scan');
          if (!isCurrentScanAttempt()) return;
          showUnavailable(reason);
        });
        return;
      }
      if (!device) return;
      // The unfiltered scan surfaces every nearby peripheral. The classifier
      // gates Aurora names on the same board/service check the picker uses
      // before treating a "#serial" as a board serial, so a stray "Printer
      // #751737" or "AirPods #1" never fires a spurious boardsBySerialNumbers
      // lookup (which could even resolve to a real, not-actually-present board),
      // and admits a MoonBoard by its name alone.
      const scanned = classifyQuickstartDevice({
        deviceId: device.id,
        name: device.localName ?? device.name ?? undefined,
        serviceUuids: [...(device.serviceUUIDs ?? []), ...(device.overflowServiceUUIDs ?? [])],
        rssi: device.rssi,
      });
      if (!scanned) return;
      // A box can be reported first under a name with no serial (a cached
      // device name, or a packet without the advertised one) and only then as
      // `Kilter Board#751737@3`. The serial is the better answer, so it
      // replaces what the same device said before, rather than leaving a
      // "doesn't say which one" row beside the board it resolves to. A board
      // already known by its serial ignores later serial-less reports.
      const earlierKey = keyByDeviceId.get(scanned.deviceId);
      const earlier = earlierKey === undefined ? undefined : found.get(earlierKey);
      if (earlier && scanned.kind !== 'serial') return;
      const replacesEarlier = earlier !== undefined && earlier.kind !== 'serial';
      if (replacesEarlier) found.delete(earlier.key);
      // Advertisements repeat many times a second. Only a board not heard yet
      // writes state; its signal is the first one heard (the picker, unlike this scan, refreshes it).
      const isNewBoard = !found.has(scanned.key);
      if (!isNewBoard && !replacesEarlier) return;
      if (isNewBoard) found.set(scanned.key, scanned);
      keyByDeviceId.set(scanned.deviceId, scanned.key);
      if (isNewBoard && scanned.kind === 'serial') {
        // Keep the whole name, not just the serial: the advertised board type
        // lives in the same string and decides which board may claim it. Only
        // a new serial touches these two, so a MoonBoard turning up doesn't
        // hand the lookup a new key.
        serialDevices.push(scanned);
        foundCountRef.current = serialDevices.length;
        setSerials(serialDevices.map((serialDevice) => serialDevice.serial));
        setAdvertisedTypes(
          advertisedBoardTypesBySerial(serialDevices.map((serialDevice) => ({ name: serialDevice.name }))),
        );
      }
      const heard = [...found.values()];
      seriallessCountRef.current = heard.filter((heardBoard) => heardBoard.kind !== 'serial').length;
      moonboardCountRef.current = heard.filter((heardBoard) => heardBoard.kind === 'moonboard').length;
      setDevices(heard.sort(compareBySignal));
    });

    timeoutRef.current = setTimeout(() => {
      if (!isCurrentScanAttempt()) return;
      stop('completed');
      setStatus('done');
    }, SCAN_TIMEOUT_MS);
  }, [slotPolicy, stop, showUnavailable]);

  const start = useCallback(
    (trigger: BoardScanTrigger = 'sheet') => {
      requestedTriggerRef.current = trigger;
      return startScan();
    },
    [startScan],
  );

  // Also the sheet's "Scan again": back to idle, and the sheet's open effect
  // starts a fresh scan.
  const reset = useCallback(() => {
    scanAttemptRef.current += 1;
    stop('stopped');
    setSerials([]);
    setAdvertisedTypes(EMPTY_ADVERTISED_TYPES);
    setDevices(EMPTY_DEVICES);
    setUnavailableReason(null);
    setStatus('idle');
  }, [stop]);

  const finish = useCallback(() => {
    scanAttemptRef.current += 1;
    if (!scanningRef.current) return;
    stop('stopped');
    setStatus('done');
  }, [stop]);

  // Always stop scanning if the component unmounts mid-scan, and block any
  // late device callback from writing state afterwards.
  useEffect(() => {
    return () => {
      mountedRef.current = false;
      scanAttemptRef.current += 1;
      stop('stopped');
    };
  }, [stop]);

  return { status, unavailableReason, serials, advertisedTypes, devices, start, reset, finish };
}
