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
import { requestBleRuntimePermissions } from './use-ble-permissions';
import { describeBlePermissionDenial } from './android-location-permission';

const SCAN_TIMEOUT_MS = 15_000;

// Stable empty identity so a reset doesn't hand consumers a fresh Map every
// render (and churn the query key built from it).
const EMPTY_ADVERTISED_TYPES: AdvertisedBoardTypes = new Map();

export type BoardScanStatus = 'idle' | 'scanning' | 'done' | 'unavailable';

export type BoardScan = {
  status: BoardScanStatus;
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
  const [serials, setSerials] = useState<string[]>([]);
  const [advertisedTypes, setAdvertisedTypes] = useState<AdvertisedBoardTypes>(EMPTY_ADVERTISED_TYPES);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scanningRef = useRef(false);
  const scanAttemptRef = useRef(0);
  // A device event can land in the BLE callback just after unmount; gate the
  // state writes so we don't setState on an unmounted component.
  const mountedRef = useRef(true);

  const stop = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    if (scanningRef.current) {
      bleManager.stopDeviceScan();
      scanningRef.current = false;
    }
  }, []);

  const start = useCallback(async () => {
    if (scanningRef.current) return;

    const scanAttempt = scanAttemptRef.current + 1;
    scanAttemptRef.current = scanAttempt;
    const isCurrentScanAttempt = () => mountedRef.current && scanAttemptRef.current === scanAttempt;

    const permissionsGranted = await requestBleRuntimePermissions();
    if (!isCurrentScanAttempt()) return;

    if (!permissionsGranted) {
      // Previously silent: the sheet just flipped to 'unavailable' and nothing
      // told us a denial (rather than a dead radio) was behind it.
      void describeBlePermissionDenial().then((denialContext) => {
        track(SHARED_EVENTS.BluetoothPermissionDenied, { ...denialContext, surface: 'quickstart_scan' });
      });
      setStatus('unavailable');
      return;
    }

    const bluetoothPoweredOn = await waitForBlePoweredOn();
    if (!isCurrentScanAttempt()) return;

    if (!bluetoothPoweredOn) {
      setStatus('unavailable');
      return;
    }

    const found = new Map<string, { deviceId: string; name?: string }>();
    setSerials([]);
    setAdvertisedTypes(EMPTY_ADVERTISED_TYPES);
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
        stop();
        setStatus('unavailable');
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
        setSerials([...found.keys()]);
        setAdvertisedTypes(advertisedBoardTypesBySerial([...found.values()]));
      }
    });

    timeoutRef.current = setTimeout(() => {
      if (!isCurrentScanAttempt()) return;
      stop();
      setStatus('done');
    }, SCAN_TIMEOUT_MS);
  }, [stop]);

  const reset = useCallback(() => {
    scanAttemptRef.current += 1;
    stop();
    setSerials([]);
    setAdvertisedTypes(EMPTY_ADVERTISED_TYPES);
    setStatus('idle');
  }, [stop]);

  // Always stop scanning if the component unmounts mid-scan, and block any
  // late device callback from writing state afterwards.
  useEffect(() => {
    return () => {
      mountedRef.current = false;
      scanAttemptRef.current += 1;
      stop();
    };
  }, [stop]);

  return { status, serials, advertisedTypes, start, reset };
}
