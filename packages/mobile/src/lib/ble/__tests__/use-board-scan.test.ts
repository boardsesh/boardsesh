// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import {
  reactNativePermissionHarness,
  resetReactNativePermissionHarness,
} from './react-native-permissions-test-harness';

const mockBleManager = vi.hoisted(() => ({
  state: vi.fn(),
  onStateChange: vi.fn(),
  startDeviceScan: vi.fn(),
  stopDeviceScan: vi.fn(),
}));

vi.mock('react-native', async () => {
  const { reactNativePermissionHarness: harness } = await import('./react-native-permissions-test-harness');
  return {
    Platform: harness.platform,
    PermissionsAndroid: harness.permissionsAndroid,
  };
});

vi.mock('react-native-ble-plx', () => ({
  State: {
    PoweredOn: 'PoweredOn',
    PoweredOff: 'PoweredOff',
    Unknown: 'Unknown',
    Resetting: 'Resetting',
    Unauthorized: 'Unauthorized',
    Unsupported: 'Unsupported',
  },
}));

vi.mock('../ble-manager', () => ({ bleManager: mockBleManager }));

const analytics = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock('../../analytics', () => ({ track: analytics.track }));

vi.mock('@boardsesh/ble-protocol', () => ({
  // board-device-filter (used by the real, unmocked filter below) reads these
  // service-UUID constants at module load; parseSerialNumber pulls the serial
  // from an Aurora "#serial@api" name, like the real helper.
  AURORA_ADVERTISED_SERVICE_UUID: 'aurora-uuid',
  UART_SERVICE_UUID: 'uart-uuid',
  REDBEARLAB_SERVICE_UUID: 'redbearlab-uuid',
  parseSerialNumber: (name?: string) => name?.match(/#([^@]+)/)?.[1],
  // The scan now records the board type each device advertises, so the
  // quickstart sheet can't offer a board of the wrong type for a reused serial.
  // Mirrors the real prefix match over the Aurora board names.
  parseBoardTypeFromDeviceName: (name?: string) =>
    ['kilter', 'tension', 'decoy', 'touchstone', 'grasshopper', 'soill'].find((board) =>
      name?.toLowerCase().replace(/[\s-]/g, '').startsWith(board),
    ),
}));

import { useBoardScan } from '../use-board-scan';
import { HIGH_POWER_BOARD_SCAN_OPTIONS } from '../scan-options';

/** Grab the scan callback react-native-ble-plx was handed so tests can feed it devices. */
function scanCallback() {
  const call = mockBleManager.startDeviceScan.mock.calls.at(-1);
  return call?.[2] as (error: unknown, device: { localName?: string; name?: string } | null) => void;
}

describe('useBoardScan', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    resetReactNativePermissionHarness();
    mockBleManager.state.mockResolvedValue('PoweredOn');
    mockBleManager.onStateChange.mockReturnValue({ remove: vi.fn() });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports unavailable when Bluetooth is not powered on', async () => {
    mockBleManager.state.mockResolvedValue('PoweredOff');
    const { result } = renderHook(() => useBoardScan());

    await act(async () => {
      await result.current.start();
    });

    expect(result.current.status).toBe('unavailable');
    expect(mockBleManager.startDeviceScan).not.toHaveBeenCalled();
  });

  it('waits for transient Bluetooth state before scanning', async () => {
    mockBleManager.state.mockResolvedValue('Unknown');
    const stateListeners: Array<(state: string) => void> = [];
    mockBleManager.onStateChange.mockImplementation((listener: (state: string) => void) => {
      stateListeners.push(listener);
      return { remove: vi.fn() };
    });
    const { result } = renderHook(() => useBoardScan());

    await act(async () => {
      const startPromise = result.current.start();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(stateListeners).toHaveLength(1);
      stateListeners[0]('PoweredOn');
      await startPromise;
    });

    expect(result.current.status).toBe('scanning');
    // Regression guard: scan UNFILTERED (#3806) with high-power options — a
    // service-UUID filter dropped scan-response boxes, and the default LowPower
    // scan mode missed boards after the RN 0.86 upgrade.
    expect(mockBleManager.startDeviceScan).toHaveBeenCalledWith(
      null,
      HIGH_POWER_BOARD_SCAN_OPTIONS,
      expect.any(Function),
    );
  });

  it('does not start scanning after reset during Bluetooth readiness wait', async () => {
    mockBleManager.state.mockResolvedValue('Unknown');
    const stateListeners: Array<(state: string) => void> = [];
    mockBleManager.onStateChange.mockImplementation((listener: (state: string) => void) => {
      stateListeners.push(listener);
      return { remove: vi.fn() };
    });
    const { result } = renderHook(() => useBoardScan());

    await act(async () => {
      const startPromise = result.current.start();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(stateListeners).toHaveLength(1);
      result.current.reset();
      stateListeners[0]('PoweredOn');
      await startPromise;
    });

    expect(result.current.status).toBe('idle');
    expect(mockBleManager.startDeviceScan).not.toHaveBeenCalled();
  });

  it('does not start scanning after unmount during Bluetooth readiness wait', async () => {
    mockBleManager.state.mockResolvedValue('Unknown');
    const stateListeners: Array<(state: string) => void> = [];
    mockBleManager.onStateChange.mockImplementation((listener: (state: string) => void) => {
      stateListeners.push(listener);
      return { remove: vi.fn() };
    });
    const { result, unmount } = renderHook(() => useBoardScan());

    await act(async () => {
      const startPromise = result.current.start();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(stateListeners).toHaveLength(1);
      unmount();
      stateListeners[0]('PoweredOn');
      await startPromise;
    });

    expect(mockBleManager.startDeviceScan).not.toHaveBeenCalled();
  });

  it('requests Android BLE permissions before checking Bluetooth state', async () => {
    const { result } = renderHook(() => useBoardScan());

    await act(async () => {
      await result.current.start();
    });

    expect(reactNativePermissionHarness.permissionsAndroid.requestMultiple).toHaveBeenCalledWith([
      'BLUETOOTH_SCAN',
      'BLUETOOTH_CONNECT',
    ]);
    expect(reactNativePermissionHarness.permissionsAndroid.requestMultiple.mock.invocationCallOrder[0]).toBeLessThan(
      mockBleManager.state.mock.invocationCallOrder[0],
    );
    expect(result.current.status).toBe('scanning');
  });

  it('reports unavailable when Android BLE permissions are denied', async () => {
    reactNativePermissionHarness.permissionsAndroid.requestMultiple.mockResolvedValue({
      BLUETOOTH_SCAN: 'denied',
      BLUETOOTH_CONNECT: 'granted',
    });
    const { result } = renderHook(() => useBoardScan());

    await act(async () => {
      await result.current.start();
    });

    expect(result.current.status).toBe('unavailable');
    expect(mockBleManager.state).not.toHaveBeenCalled();
    expect(mockBleManager.startDeviceScan).not.toHaveBeenCalled();

    // Before this, a denial left no trace at all — the sheet just said
    // "unavailable" and PostHog saw nothing, so the whole class was invisible.
    await vi.waitFor(() => {
      expect(analytics.track).toHaveBeenCalledWith('Bluetooth Permission Denied', {
        surface: 'quickstart_scan',
        platform: 'android',
        androidApiLevel: 31,
        androidLocationPermissionGranted: false,
      });
    });
  });

  it('scans and deduplicates serials from discovered devices', async () => {
    const { result } = renderHook(() => useBoardScan());

    await act(async () => {
      await result.current.start();
    });
    expect(result.current.status).toBe('scanning');

    act(() => {
      const cb = scanCallback();
      cb(null, { localName: 'Kilter Board#alpha@3' });
      cb(null, { localName: 'Tension Board#beta@3' });
      cb(null, { localName: 'Kilter Board#alpha@3' }); // duplicate
    });

    expect(result.current.serials).toEqual(['alpha', 'beta']);
  });

  it('ignores non-board peripherals so no spurious serial lookup fires', async () => {
    const { result } = renderHook(() => useBoardScan());
    await act(async () => {
      await result.current.start();
    });

    act(() => {
      const cb = scanCallback();
      // Both parse a "#serial" but are not Aurora boards — must be dropped before
      // any boardsBySerialNumbers lookup (regression from unfiltering the scan).
      cb(null, { localName: 'Printer #751737' });
      cb(null, { localName: "Marco's AirPods #1" });
      cb(null, { localName: 'Kilter Board#alpha@3' });
    });

    expect(result.current.serials).toEqual(['alpha']);
  });

  it('stops scanning and reports done after the timeout', async () => {
    const { result } = renderHook(() => useBoardScan());
    await act(async () => {
      await result.current.start();
    });

    act(() => {
      vi.advanceTimersByTime(15_000);
    });

    expect(result.current.status).toBe('done');
    expect(mockBleManager.stopDeviceScan).toHaveBeenCalled();
  });

  it('surfaces a scan error as unavailable', async () => {
    const { result } = renderHook(() => useBoardScan());
    await act(async () => {
      await result.current.start();
    });

    act(() => {
      scanCallback()(new Error('scan failed'), null);
    });

    expect(result.current.status).toBe('unavailable');
    expect(mockBleManager.stopDeviceScan).toHaveBeenCalled();
  });

  it('reset() returns to idle and stops an in-flight scan', async () => {
    const { result } = renderHook(() => useBoardScan());
    await act(async () => {
      await result.current.start();
    });
    act(() => {
      scanCallback()(null, { localName: 'Kilter Board#alpha@3' });
    });
    expect(result.current.serials).toEqual(['alpha']);

    act(() => {
      result.current.reset();
    });

    expect(result.current.status).toBe('idle');
    expect(result.current.serials).toEqual([]);
    expect(mockBleManager.stopDeviceScan).toHaveBeenCalled();
  });

  it('stops scanning on unmount', async () => {
    const { result, unmount } = renderHook(() => useBoardScan());
    await act(async () => {
      await result.current.start();
    });
    mockBleManager.stopDeviceScan.mockClear();

    unmount();

    expect(mockBleManager.stopDeviceScan).toHaveBeenCalled();
  });
});
