// Scan-only BLE discovery for the "Bluetooth quickstart" board picker. Unlike
// the adapter's requestAndConnect (which scans *and* opens a UART connection),
// this only listens for in-range Aurora boards and collects their serial
// numbers — the picker then resolves serials to boards via
// GET_BOARDS_BY_SERIAL_NUMBERS and sets the chosen one active. No connection is
// opened here; connecting happens later when the user enters play mode.
//
// The board type each device advertises is collected alongside its serial.
// Aurora reuses a serial across board apps, so without it this sheet would
// happily offer a stranger's Kilter board for an in-range Tension controller
// and let the user make it active — the Benchmark Climbing bug, one surface
// over from the connect-time picker.

import { useCallback, useEffect, useRef, useState } from 'react';
import { parseSerialNumber } from '@boardsesh/ble-protocol';
import { advertisedBoardTypesBySerial, type AdvertisedBoardTypes } from './advertised-board-type';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { track } from '../analytics';
import { bleManager } from './ble-manager';
import { waitForBlePoweredOn } from './availability';
import { isLikelyBoardDevice } from './board-device-filter';
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

export type BoardScanStatus = 'idle' | 'scanning' | 'done' | 'unavailable';

/**
 * Why a scan is 'unavailable', so the sheet can say something the climber can
 * act on. 'permission_denied' is an Android "Don't allow" answered in the dialog:
 * scanning again shows the dialog again. A blocked permission (iOS denial,
 * Android never-ask-again) is 'unauthorized', which only the Settings app fixes.
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
  start: () => Promise<void>;
  /** Stop any in-flight scan and return to idle (e.g. when the sheet closes). */
  reset: () => void;
};

export function useBoardScan(): BoardScan {
  const [status, setStatus] = useState<BoardScanStatus>('idle');
  const [unavailableReason, setUnavailableReason] = useState<BoardScanUnavailableReason | null>(null);
  const [serials, setSerials] = useState<string[]>([]);
  const [advertisedTypes, setAdvertisedTypes] = useState<AdvertisedBoardTypes>(EMPTY_ADVERTISED_TYPES);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scanningRef = useRef(false);
  // Serials heard by the running scan, for Board Quickstart Scan Finished.
  const foundCountRef = useRef(0);
  const scanAttemptRef = useRef(0);
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
      bleManager.stopDeviceScan();
      scanningRef.current = false;
      track(SHARED_EVENTS.BoardQuickstartScanFinished, { outcome, found_count: foundCountRef.current });
    }
  }, []);

  const showUnavailable = useCallback((reason: BoardScanUnavailableReason) => {
    setUnavailableReason(reason);
    setStatus('unavailable');
  }, []);

  const start = useCallback(async () => {
    if (scanningRef.current) return;

    const scanAttempt = scanAttemptRef.current + 1;
    scanAttemptRef.current = scanAttempt;
    const isCurrentScanAttempt = () => mountedRef.current && scanAttemptRef.current === scanAttempt;

    const permissionStatus = await requestBleRuntimePermissionStatus();
    if (!isCurrentScanAttempt()) return;

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
      // iOS reports a denied Bluetooth permission here, as the Unauthorized radio
      // state, not from the permission request above.
      const reason = await readBluetoothUnavailableReason();
      if (!isCurrentScanAttempt()) return;
      trackBluetoothUnavailable(reason, 'quickstart_scan');
      showUnavailable(reason);
      return;
    }

    const found = new Map<string, { deviceId: string; name?: string }>();
    foundCountRef.current = 0;
    setSerials([]);
    setAdvertisedTypes(EMPTY_ADVERTISED_TYPES);
    setUnavailableReason(null);
    setStatus('scanning');
    scanningRef.current = true;

    // Scan UNFILTERED, then keep only devices whose name carries an Aurora serial
    // (parseSerialNumber below). A hardware service-UUID ScanFilter drops boards
    // on Android when the UUID rides the scan-response PDU, leaving an empty
    // quickstart list — same root cause as the picker scan in adapter.ts.
    // High-power scan options (LowLatency on Android) — see scan-options.ts.
    void bleManager.startDeviceScan(null, HIGH_POWER_BOARD_SCAN_OPTIONS, (error, device) => {
      if (!isCurrentScanAttempt()) return;
      if (error) {
        stop('error');
        showUnavailable('unknown');
        // Radio switched off or permission pulled mid-scan: work out which. The
        // read is async, so re-check the attempt before touching state.
        void readBluetoothUnavailableReason().then((reason) => {
          if (!isCurrentScanAttempt()) return;
          trackBluetoothUnavailable(reason, 'quickstart_scan');
          setUnavailableReason(reason);
        });
        return;
      }
      if (!device) return;
      const deviceName = device.localName ?? device.name ?? undefined;
      // The unfiltered scan surfaces every nearby peripheral, so gate on the same
      // Aurora board/service check the picker uses before treating a "#serial" as
      // a board serial. Otherwise a stray "Printer #751737" or "AirPods #1" would
      // parse a serial and fire a spurious boardsBySerialNumbers lookup (which
      // could even resolve to a real, not-actually-present board).
      const advertisedServiceUuids = [...(device.serviceUUIDs ?? []), ...(device.overflowServiceUUIDs ?? [])];
      if (!isLikelyBoardDevice({ name: deviceName, serviceUuids: advertisedServiceUuids, scanFamily: 'aurora' })) {
        return;
      }
      const serial = parseSerialNumber(deviceName);
      if (serial && !found.has(serial)) {
        // Keep the whole name, not just the serial: the advertised board type
        // lives in the same string and decides which board may claim it.
        found.set(serial, { deviceId: device.id, name: deviceName });
        foundCountRef.current = found.size;
        setSerials([...found.keys()]);
        setAdvertisedTypes(advertisedBoardTypesBySerial([...found.values()]));
      }
    });

    timeoutRef.current = setTimeout(() => {
      if (!isCurrentScanAttempt()) return;
      stop('completed');
      setStatus('done');
    }, SCAN_TIMEOUT_MS);
  }, [stop, showUnavailable]);

  // Also the sheet's "Scan again": back to idle, and the sheet's open effect
  // starts a fresh scan.
  const reset = useCallback(() => {
    scanAttemptRef.current += 1;
    stop('stopped');
    setSerials([]);
    setAdvertisedTypes(EMPTY_ADVERTISED_TYPES);
    setUnavailableReason(null);
    setStatus('idle');
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

  return { status, unavailableReason, serials, advertisedTypes, start, reset };
}
