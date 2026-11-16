// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  reactNativePermissionHarness,
  resetReactNativePermissionHarness,
} from './react-native-permissions-test-harness';
import {
  installIosBluetoothAuthorization,
  nativeBluetoothAuthorizationHarness,
  resetNativeBluetoothAuthorizationHarness,
} from './native-bluetooth-authorization-test-harness';

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

vi.mock('../ble-manager', () => ({ getBleManager: () => mockBleManager }));

// The real bluetooth-authorization reads the iOS-only BoardBle module. Null (the
// default) is Android, web, or an iOS binary that still asks at launch.
vi.mock('../../../../modules/live-activity/src/index', async () => {
  const { nativeBluetoothAuthorizationHarness: harness } =
    await import('./native-bluetooth-authorization-test-harness');
  return {
    get boardBleNative() {
      return harness.nativeModule;
    },
    // Android's SessionPresence (the power-on wait's native clock, #7038):
    // absent, so the wait runs on its JS timer as these tests drive it.
    sessionPresenceNative: null,
  };
});

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
  parseAnyBoardTypeFromDeviceName: (name?: string) =>
    ['moonboard', 'kilter', 'tension', 'decoy', 'touchstone', 'grasshopper', 'soill'].find((board) =>
      name?.toLowerCase().replace(/[\s-]/g, '').startsWith(board),
    ),
}));

// Lets a test stand in the web fork's answer (use-ble-permissions.web.ts), which
// the native module this file resolves to never gives. Null = the real module.
const permissionStatusOverride = vi.hoisted(() => ({ status: null as 'unsupported' | null }));
vi.mock('../use-ble-permissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../use-ble-permissions')>();
  return {
    ...actual,
    requestBleRuntimePermissionStatus: () =>
      permissionStatusOverride.status !== null
        ? Promise.resolve(permissionStatusOverride.status)
        : actual.requestBleRuntimePermissionStatus(),
  };
});

import { useBoardScan } from '../use-board-scan';
import { HIGH_POWER_BOARD_SCAN_OPTIONS } from '../scan-options';
import { claimBleScan, currentBleScanOwner, releaseBleScan } from '../ble-scan-slot';

type ScannedDevice = {
  id?: string;
  localName?: string;
  name?: string;
  rssi?: number | null;
  serviceUUIDs?: string[] | null;
};

// The scan only claims the slot, never takes it, and the slot is module state:
// every test starts with nobody holding it, whatever the last one left.
beforeEach(() => {
  const owner = currentBleScanOwner();
  if (owner) releaseBleScan(owner);
});

/** Grab the scan callback react-native-ble-plx was handed so tests can feed it devices. */
function scanCallback() {
  const call = mockBleManager.startDeviceScan.mock.calls.at(-1);
  return call?.[2] as (error: unknown, device: ScannedDevice | null) => void;
}

describe('useBoardScan', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    resetReactNativePermissionHarness();
    resetNativeBluetoothAuthorizationHarness();
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
      await result.current.start('picker_tap');
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
      const startPromise = result.current.start('picker_tap');
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
      const startPromise = result.current.start('picker_tap');
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
      const startPromise = result.current.start('picker_tap');
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
      await result.current.start('picker_tap');
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
      await result.current.start('picker_tap');
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
      await result.current.start('picker_tap');
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
      await result.current.start('picker_tap');
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
      await result.current.start('picker_tap');
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
      await result.current.start('picker_tap');
    });

    await act(async () => {
      scanCallback()(new Error('scan failed'), null);
      await Promise.resolve();
    });

    expect(result.current.status).toBe('unavailable');
    expect(mockBleManager.stopDeviceScan).toHaveBeenCalled();
  });

  it('reset() returns to idle and stops an in-flight scan', async () => {
    const { result } = renderHook(() => useBoardScan());
    await act(async () => {
      await result.current.start('picker_tap');
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
      await result.current.start('picker_tap');
    });
    mockBleManager.stopDeviceScan.mockClear();

    unmount();

    expect(mockBleManager.stopDeviceScan).toHaveBeenCalled();
  });

  it('scans real boards when both retired screenshot flags are set', async () => {
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', '1');
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_FAKE_BLE', '1');
    try {
      const { result } = renderHook(() => useBoardScan());
      await act(async () => {
        await result.current.start('picker_tap');
      });

      expect(result.current.status).toBe('scanning');
      expect(mockBleManager.state).toHaveBeenCalled();
      expect(mockBleManager.startDeviceScan).toHaveBeenCalledOnce();
      act(() => {
        scanCallback()(null, { id: 'real-board', name: 'Kilter Board#123@3' });
      });
      expect(result.current.serials).toEqual(['123']);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

// #5654: the quickstart said "Turn on Bluetooth to scan" for every stop, and ran
// without any event, so a climber who found their board here never counted as
// having scanned.
describe('useBoardScan unavailable reasons and scan reporting (#5654)', () => {
  beforeEach(() => {
    permissionStatusOverride.status = null;
    vi.clearAllMocks();
    vi.useFakeTimers();
    resetReactNativePermissionHarness();
    resetNativeBluetoothAuthorizationHarness();
    mockBleManager.state.mockResolvedValue('PoweredOn');
    mockBleManager.onStateChange.mockReturnValue({ remove: vi.fn() });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function trackedEventNames(): unknown[] {
    return analytics.track.mock.calls.map(([eventName]) => eventName);
  }

  it('is unauthorized, and says so, when Android stopped showing the permission dialog', async () => {
    reactNativePermissionHarness.permissionsAndroid.requestMultiple.mockResolvedValue({
      BLUETOOTH_SCAN: 'never_ask_again',
      BLUETOOTH_CONNECT: 'granted',
    });
    const { result } = renderHook(() => useBoardScan());

    await act(async () => {
      await result.current.start('picker_tap');
    });

    expect(result.current.status).toBe('unavailable');
    expect(result.current.unavailableReason).toBe('unauthorized');
    expect(analytics.track).toHaveBeenCalledWith('Bluetooth Unavailable', {
      reason: 'unauthorized',
      surface: 'quickstart_scan',
      platform: 'android',
    });
  });

  it('is permission_denied for a dialog "Don\'t allow", which scanning again re-asks', async () => {
    reactNativePermissionHarness.permissionsAndroid.requestMultiple.mockResolvedValue({
      BLUETOOTH_SCAN: 'denied',
      BLUETOOTH_CONNECT: 'granted',
    });
    const { result } = renderHook(() => useBoardScan());

    await act(async () => {
      await result.current.start('picker_tap');
    });

    expect(result.current.unavailableReason).toBe('permission_denied');
    expect(trackedEventNames()).not.toContain('Bluetooth Unavailable');
  });

  it('is unauthorized when iOS reports the Unauthorized radio state', async () => {
    // waitForBlePoweredOn treats Unauthorized as transient and waits it out
    // (2.5 s) before giving up; the reason is read after that.
    reactNativePermissionHarness.platform.OS = 'ios';
    mockBleManager.state.mockResolvedValue('Unauthorized');
    const { result } = renderHook(() => useBoardScan());

    await act(async () => {
      const startPromise = result.current.start('picker_tap');
      await vi.advanceTimersByTimeAsync(2_500);
      await startPromise;
    });

    expect(result.current.status).toBe('unavailable');
    expect(result.current.unavailableReason).toBe('unauthorized');
    expect(analytics.track).toHaveBeenCalledWith('Bluetooth Unavailable', {
      reason: 'unauthorized',
      surface: 'quickstart_scan',
      platform: 'ios',
    });
    expect(mockBleManager.startDeviceScan).not.toHaveBeenCalled();
  });

  it.each([
    ['PoweredOff', 'powered_off'],
    ['Unsupported', 'unsupported'],
  ])('is %s → %s when the radio says so', async (radioState, reason) => {
    mockBleManager.state.mockResolvedValue(radioState);
    const { result } = renderHook(() => useBoardScan());

    await act(async () => {
      await result.current.start('picker_tap');
    });

    expect(result.current.unavailableReason).toBe(reason);
    expect(analytics.track).toHaveBeenCalledWith(
      'Bluetooth Unavailable',
      expect.objectContaining({ reason, surface: 'quickstart_scan' }),
    );
  });

  it('works out why after a scan error, and clears the reason on reset', async () => {
    const { result } = renderHook(() => useBoardScan());
    await act(async () => {
      await result.current.start('picker_tap');
    });
    mockBleManager.state.mockResolvedValue('PoweredOff');

    await act(async () => {
      scanCallback()(new Error('BluetoothLE is powered off'), null);
      await Promise.resolve();
    });

    expect(result.current.status).toBe('unavailable');
    expect(result.current.unavailableReason).toBe('powered_off');
    expect(analytics.track).toHaveBeenCalledWith('Board Quickstart Scan Finished', {
      outcome: 'error',
      found_count: 0,
      serialless_count: 0,
      moonboard_count: 0,
      trigger: 'picker_tap',
    });

    act(() => {
      result.current.reset();
    });

    expect(result.current.status).toBe('idle');
    expect(result.current.unavailableReason).toBeNull();
  });

  it('goes straight to the blocked copy after a scan error, with no "Turn on Bluetooth" first', async () => {
    const { result } = renderHook(() => useBoardScan());
    await act(async () => {
      await result.current.start('picker_tap');
    });
    let resolveRadioState: (radioState: string) => void = () => {};
    mockBleManager.state.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveRadioState = resolve;
      }),
    );

    act(() => {
      scanCallback()(new Error('Bluetooth permission revoked'), null);
    });
    // The reason is still being read: nothing is shown yet, least of all the
    // "Turn on Bluetooth" copy that used to flash here first.
    expect(result.current.status).toBe('scanning');
    expect(result.current.unavailableReason).toBeNull();

    await act(async () => {
      resolveRadioState('Unauthorized');
      await Promise.resolve();
    });

    expect(result.current.status).toBe('unavailable');
    expect(result.current.unavailableReason).toBe('unauthorized');
  });

  it('still counts a scan error when the sheet closed before its reason was read', async () => {
    const { result } = renderHook(() => useBoardScan());
    await act(async () => {
      await result.current.start('picker_tap');
    });
    let resolveRadioState: (radioState: string) => void = () => {};
    mockBleManager.state.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveRadioState = resolve;
      }),
    );

    act(() => {
      scanCallback()(new Error('BluetoothLE is powered off'), null);
      result.current.reset();
    });
    await act(async () => {
      resolveRadioState('PoweredOff');
      await Promise.resolve();
    });

    expect(analytics.track).toHaveBeenCalledWith('Bluetooth Unavailable', {
      reason: 'powered_off',
      surface: 'quickstart_scan',
      platform: 'android',
    });
    // The closed sheet stays reset.
    expect(result.current.status).toBe('idle');
    expect(result.current.unavailableReason).toBeNull();
  });

  it('is unsupported, not a permission denial, in a browser with no Web Bluetooth', async () => {
    permissionStatusOverride.status = 'unsupported';
    const { result } = renderHook(() => useBoardScan());

    await act(async () => {
      await result.current.start('picker_tap');
    });

    expect(result.current.status).toBe('unavailable');
    expect(result.current.unavailableReason).toBe('unsupported');
    expect(analytics.track).toHaveBeenCalledWith(
      'Bluetooth Unavailable',
      expect.objectContaining({ reason: 'unsupported', surface: 'quickstart_scan' }),
    );
    expect(trackedEventNames()).not.toContain('Bluetooth Permission Denied');
    expect(mockBleManager.startDeviceScan).not.toHaveBeenCalled();
  });

  it('reports a scan that ran its full window, with the serials it heard', async () => {
    const { result } = renderHook(() => useBoardScan());
    await act(async () => {
      await result.current.start('picker_tap');
    });
    act(() => {
      const cb = scanCallback();
      cb(null, { localName: 'Kilter Board#alpha@3' });
      cb(null, { localName: 'Tension Board#beta@3' });
      cb(null, { localName: 'Kilter Board#alpha@3' });
    });

    act(() => {
      vi.advanceTimersByTime(15_000);
    });

    expect(analytics.track).toHaveBeenCalledWith('Board Quickstart Scan Finished', {
      outcome: 'completed',
      found_count: 2,
      serialless_count: 0,
      moonboard_count: 0,
      trigger: 'picker_tap',
    });
  });

  it('reports a scan cut short by picking a board or closing the sheet', async () => {
    // The success path: the climber taps their board before the 15 s window ends,
    // the sheet closes and resets the scan. That still has to count as a scan.
    const { result } = renderHook(() => useBoardScan());
    await act(async () => {
      await result.current.start('picker_tap');
    });
    act(() => {
      scanCallback()(null, { localName: 'Kilter Board#alpha@3' });
    });

    act(() => {
      result.current.reset();
    });

    expect(analytics.track).toHaveBeenCalledWith('Board Quickstart Scan Finished', {
      outcome: 'stopped',
      found_count: 1,
      serialless_count: 0,
      moonboard_count: 0,
      trigger: 'picker_tap',
    });
  });

  it('reports once per scan: the timeout, then closing the sheet, is one event', async () => {
    const { result } = renderHook(() => useBoardScan());
    await act(async () => {
      await result.current.start('picker_tap');
    });
    act(() => {
      vi.advanceTimersByTime(15_000);
    });
    act(() => {
      result.current.reset();
    });

    const finishedEvents = analytics.track.mock.calls.filter(
      ([eventName]) => eventName === 'Board Quickstart Scan Finished',
    );
    expect(finishedEvents).toHaveLength(1);
  });

  it('reports a scan still running when the sheet unmounts', async () => {
    const { result, unmount } = renderHook(() => useBoardScan());
    await act(async () => {
      await result.current.start('picker_tap');
    });

    unmount();

    expect(analytics.track).toHaveBeenCalledWith('Board Quickstart Scan Finished', {
      outcome: 'stopped',
      found_count: 0,
      serialless_count: 0,
      moonboard_count: 0,
      trigger: 'picker_tap',
    });
  });

  it('reports nothing for a scan that never started the radio', async () => {
    mockBleManager.state.mockResolvedValue('PoweredOff');
    const { result, unmount } = renderHook(() => useBoardScan());
    await act(async () => {
      await result.current.start('picker_tap');
    });
    act(() => {
      result.current.reset();
    });
    unmount();

    expect(trackedEventNames()).not.toContain('Board Quickstart Scan Finished');
  });

  it('starts a fresh count for each scan', async () => {
    const { result } = renderHook(() => useBoardScan());
    await act(async () => {
      await result.current.start('picker_tap');
    });
    act(() => {
      scanCallback()(null, { localName: 'Kilter Board#alpha@3' });
    });
    act(() => {
      result.current.reset();
    });
    analytics.track.mockClear();

    await act(async () => {
      await result.current.start('picker_tap');
    });
    act(() => {
      vi.advanceTimersByTime(15_000);
    });

    expect(analytics.track).toHaveBeenCalledWith('Board Quickstart Scan Finished', {
      outcome: 'completed',
      found_count: 0,
      serialless_count: 0,
      moonboard_count: 0,
      trigger: 'picker_tap',
    });
  });
});

// Slice 1 of the first-run redesign: the quickstart keeps boards that advertise
// no serial. MoonBoards never do, and Kilter-built boxes advertise a bare
// "Kilter Board". Both used to be dropped, so a climber at one heard nothing.
describe('useBoardScan keeps boards with no serial', () => {
  beforeEach(() => {
    permissionStatusOverride.status = null;
    vi.clearAllMocks();
    vi.useFakeTimers();
    resetReactNativePermissionHarness();
    mockBleManager.state.mockResolvedValue('PoweredOn');
    mockBleManager.onStateChange.mockReturnValue({ remove: vi.fn() });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function startScan() {
    const hook = renderHook(() => useBoardScan());
    await act(async () => {
      await hook.result.current.start('picker_tap');
    });
    return hook;
  }

  it('keeps a MoonBoard by its name, one entry per device, without a serial lookup', async () => {
    const { result } = await startScan();

    act(() => {
      const cb = scanCallback();
      cb(null, { id: 'mb-1', localName: 'MoonBoard A', rssi: -70, serviceUUIDs: ['uart-uuid'] });
      cb(null, { id: 'mb-1', localName: 'MoonBoard A', rssi: -40, serviceUUIDs: ['uart-uuid'] }); // repeat
      cb(null, { id: 'mb-2', localName: 'Moonboard', rssi: -60, serviceUUIDs: [] });
    });

    expect(result.current.devices.map((device) => [device.deviceId, device.kind, device.boardType])).toEqual([
      ['mb-2', 'moonboard', 'moonboard'],
      ['mb-1', 'moonboard', 'moonboard'],
    ]);
    // The first reading stands; the repeat doesn't move the row.
    expect(result.current.devices.find((device) => device.deviceId === 'mb-1')?.rssi).toBe(-70);
    expect(result.current.serials).toEqual([]);
  });

  it('drops a UART gadget that is not named like a MoonBoard', async () => {
    const { result } = await startScan();

    act(() => {
      const cb = scanCallback();
      cb(null, { id: 'hr-1', localName: 'Polar H10', rssi: -50, serviceUUIDs: ['uart-uuid'] });
      cb(null, { id: 'uart-1', localName: 'Nordic_UART', rssi: -45, serviceUUIDs: ['uart-uuid'] });
      cb(null, { id: 'woods-1', localName: 'Woods Board 12x12', rssi: -45, serviceUUIDs: ['uart-uuid'] });
    });

    expect(result.current.devices).toEqual([]);
  });

  it('keeps a Kilter-built box that advertises a bare name, keyed by device', async () => {
    const { result } = await startScan();

    act(() => {
      const cb = scanCallback();
      cb(null, { id: 'kb-1', localName: 'Kilter Board', rssi: -55, serviceUUIDs: ['aurora-uuid'] });
      cb(null, { id: 'kb-2', localName: 'Kilter Board', rssi: -65, serviceUUIDs: ['aurora-uuid'] });
    });

    expect(result.current.devices.map((device) => [device.deviceId, device.kind, device.boardType])).toEqual([
      ['kb-1', 'bare_name', 'kilter'],
      ['kb-2', 'bare_name', 'kilter'],
    ]);
    expect(result.current.serials).toEqual([]);
  });

  // Otherwise the box would show twice: as "doesn't say which one" and as the
  // board its serial resolves to.
  it('lets a box that turns out to carry a serial replace its serial-less entry', async () => {
    const { result } = await startScan();

    act(() => {
      const cb = scanCallback();
      cb(null, { id: 'box-1', name: 'Kilter Board', rssi: -55 });
      cb(null, { id: 'box-1', localName: 'Kilter Board#alpha@3', rssi: -50 });
      cb(null, { id: 'box-1', name: 'Kilter Board', rssi: -52 }); // the cached name again
    });

    expect(result.current.devices.map((device) => [device.deviceId, device.kind])).toEqual([['box-1', 'serial']]);
    expect(result.current.serials).toEqual(['alpha']);

    act(() => {
      vi.advanceTimersByTime(15_000);
    });
    expect(analytics.track).toHaveBeenCalledWith('Board Quickstart Scan Finished', {
      outcome: 'completed',
      found_count: 1,
      serialless_count: 0,
      moonboard_count: 0,
      trigger: 'picker_tap',
    });
  });

  it('lists every board strongest signal first, serial or not', async () => {
    const { result } = await startScan();

    act(() => {
      const cb = scanCallback();
      cb(null, { id: 'far', localName: 'MoonBoard A', rssi: -90 });
      cb(null, { id: 'serial', localName: 'Kilter Board#alpha@3', rssi: -40 });
      cb(null, { id: 'unknown', localName: 'Kilter Board', rssi: null });
      cb(null, { id: 'mid', localName: 'Tension Board', rssi: -60 });
    });

    expect(result.current.devices.map((device) => device.deviceId)).toEqual(['serial', 'mid', 'far', 'unknown']);
  });

  // A new lookup key per MoonBoard would refetch the serial lookup for nothing.
  it('leaves the serial lookup alone when a board with no serial turns up', async () => {
    const { result } = await startScan();
    act(() => {
      scanCallback()(null, { id: 'serial', localName: 'Kilter Board#alpha@3', rssi: -40 });
    });
    const { serials, advertisedTypes } = result.current;

    act(() => {
      scanCallback()(null, { id: 'mb-1', localName: 'MoonBoard A', rssi: -60 });
    });

    expect(result.current.serials).toBe(serials);
    expect(result.current.advertisedTypes).toBe(advertisedTypes);
    expect(result.current.devices).toHaveLength(2);
  });

  it('counts serials, boards with no serial, and MoonBoards apart', async () => {
    const { result } = await startScan();
    act(() => {
      const cb = scanCallback();
      cb(null, { id: 's-1', localName: 'Kilter Board#alpha@3', rssi: -40 });
      cb(null, { id: 'mb-1', localName: 'MoonBoard A', rssi: -60 });
      cb(null, { id: 'mb-2', localName: 'MoonBoard B', rssi: -61 });
      cb(null, { id: 'kb-1', localName: 'Kilter Board', rssi: -62 });
      cb(null, { id: 'mb-1', localName: 'MoonBoard A', rssi: -60 }); // repeat
    });

    act(() => {
      vi.advanceTimersByTime(15_000);
    });

    // `found_count` stays serials-only so its series is unbroken.
    expect(analytics.track).toHaveBeenCalledWith('Board Quickstart Scan Finished', {
      outcome: 'completed',
      found_count: 1,
      serialless_count: 3,
      moonboard_count: 2,
      trigger: 'picker_tap',
    });
    expect(result.current.status).toBe('done');
  });

  it('clears the boards it heard on reset and counts afresh', async () => {
    const { result } = await startScan();
    act(() => {
      scanCallback()(null, { id: 'mb-1', localName: 'MoonBoard A', rssi: -60 });
    });
    act(() => {
      result.current.reset();
    });
    expect(result.current.devices).toEqual([]);
    expect(analytics.track).toHaveBeenCalledWith('Board Quickstart Scan Finished', {
      outcome: 'stopped',
      found_count: 0,
      serialless_count: 1,
      moonboard_count: 1,
      trigger: 'picker_tap',
    });
    analytics.track.mockClear();

    await act(async () => {
      await result.current.start('picker_tap');
    });
    act(() => {
      vi.advanceTimersByTime(15_000);
    });
    expect(analytics.track).toHaveBeenCalledWith('Board Quickstart Scan Finished', {
      outcome: 'completed',
      found_count: 0,
      serialless_count: 0,
      moonboard_count: 0,
      trigger: 'picker_tap',
    });
  });
});

// The iOS alert used to appear at launch, before sign-in. Binaries that expose
// the native authorization read ask at the first scan instead, and this sheet's
// scan is the tap that asks.
describe('useBoardScan asking for Bluetooth on iOS at the first scan', () => {
  beforeEach(() => {
    permissionStatusOverride.status = null;
    vi.clearAllMocks();
    vi.useFakeTimers();
    resetReactNativePermissionHarness();
    resetNativeBluetoothAuthorizationHarness();
    reactNativePermissionHarness.platform.OS = 'ios';
    mockBleManager.state.mockResolvedValue('PoweredOn');
    mockBleManager.onStateChange.mockReturnValue({ remove: vi.fn() });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function trackedEventNames(): unknown[] {
    return analytics.track.mock.calls.map(([eventName]) => eventName);
  }

  function requestMock() {
    const request = nativeBluetoothAuthorizationHarness.nativeModule?.requestBluetoothAuthorization;
    if (!request || !vi.isMockFunction(request)) throw new Error('installIosBluetoothAuthorization first');
    return request;
  }

  it('asks at the scan tap, then scans straight after an Allow', async () => {
    installIosBluetoothAuthorization('notDetermined', 'allowedAlways');
    const { result } = renderHook(() => useBoardScan());

    await act(async () => {
      await result.current.start('picker_tap');
    });

    expect(nativeBluetoothAuthorizationHarness.requestCount).toBe(1);
    // ble-plx is only created (its first state read) once the answer is known,
    // so its own central never raises a second alert.
    expect(requestMock().mock.invocationCallOrder[0]).toBeLessThan(mockBleManager.state.mock.invocationCallOrder[0]);
    expect(result.current.status).toBe('scanning');
    expect(mockBleManager.startDeviceScan).toHaveBeenCalledOnce();
  });

  it("shows the blocked state after Don't Allow, without creating ble-plx", async () => {
    installIosBluetoothAuthorization('notDetermined', 'denied');
    const { result } = renderHook(() => useBoardScan());

    await act(async () => {
      await result.current.start('picker_tap');
    });

    expect(result.current.status).toBe('unavailable');
    expect(result.current.unavailableReason).toBe('unauthorized');
    expect(analytics.track).toHaveBeenCalledWith('Bluetooth Unavailable', {
      reason: 'unauthorized',
      surface: 'quickstart_scan',
      platform: 'ios',
    });
    expect(mockBleManager.state).not.toHaveBeenCalled();
    expect(mockBleManager.startDeviceScan).not.toHaveBeenCalled();
  });

  it('treats an unanswered alert as not asked yet, never as Bluetooth Unavailable', async () => {
    installIosBluetoothAuthorization('notDetermined', 'notDetermined');
    const { result } = renderHook(() => useBoardScan());

    await act(async () => {
      await result.current.start('picker_tap');
    });

    expect(result.current.status).toBe('unavailable');
    expect(result.current.unavailableReason).toBe('not_asked');
    expect(trackedEventNames()).not.toContain('Bluetooth Unavailable');
    expect(mockBleManager.state).not.toHaveBeenCalled();
  });

  it('does not ask again once the climber has answered', async () => {
    installIosBluetoothAuthorization('allowedAlways');
    const { result } = renderHook(() => useBoardScan());

    await act(async () => {
      await result.current.start('picker_tap');
    });

    expect(nativeBluetoothAuthorizationHarness.requestCount).toBe(0);
    expect(result.current.status).toBe('scanning');
  });
});

// The board picker's in-range slot scans by itself on most picker opens, so it
// says who started each scan, takes ble-plx's one scan only when nobody holds
// it, and keeps what it heard when it ends early.
describe('useBoardScan for the board picker', () => {
  beforeEach(() => {
    permissionStatusOverride.status = null;
    vi.clearAllMocks();
    vi.useFakeTimers();
    resetReactNativePermissionHarness();
    resetNativeBluetoothAuthorizationHarness();
    mockBleManager.state.mockResolvedValue('PoweredOn');
    mockBleManager.onStateChange.mockReturnValue({ remove: vi.fn() });
    // The slot is module state: start every test with nobody holding it.
    const owner = currentBleScanOwner();
    if (owner) releaseBleScan(owner);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(['picker_auto', 'picker_tap'] as const)('reports the %s trigger on the scan it started', async (trigger) => {
    const { result } = renderHook(() => useBoardScan());
    await act(async () => {
      await result.current.start(trigger);
    });
    act(() => {
      vi.advanceTimersByTime(15_000);
    });

    expect(analytics.track).toHaveBeenCalledWith('Board Quickstart Scan Finished', {
      outcome: 'completed',
      found_count: 0,
      serialless_count: 0,
      moonboard_count: 0,
      trigger,
    });
  });

  it('claims a free scan slot and gives it back when the scan ends', async () => {
    const { result } = renderHook(() => useBoardScan());
    await act(async () => {
      await result.current.start('picker_auto');
    });

    expect(result.current.status).toBe('scanning');
    expect(currentBleScanOwner()).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(15_000);
    });
    expect(currentBleScanOwner()).toBeNull();
    expect(mockBleManager.stopDeviceScan).toHaveBeenCalledOnce();
  });

  it("skips, never steals, a scan someone else holds (the rest timer's, an Android connect's)", async () => {
    const restTimerScan = Symbol('rest-timer');
    claimBleScan(restTimerScan);
    const { result, unmount } = renderHook(() => useBoardScan());
    await act(async () => {
      await result.current.start('picker_auto');
    });

    expect(result.current.status).toBe('busy');
    expect(mockBleManager.startDeviceScan).not.toHaveBeenCalled();
    expect(currentBleScanOwner()).toBe(restTimerScan);
    unmount();
    // Nothing started, so nothing is stopped and nothing is reported.
    expect(mockBleManager.stopDeviceScan).not.toHaveBeenCalled();
    expect(currentBleScanOwner()).toBe(restTimerScan);
    expect(analytics.track).not.toHaveBeenCalledWith('Board Quickstart Scan Finished', expect.anything());
    releaseBleScan(restTimerScan);
  });

  it('gives the radio to a scan someone asked for, ending at done with what it heard', async () => {
    const { result, unmount } = renderHook(() => useBoardScan());
    await act(async () => {
      await result.current.start('picker_auto');
    });
    act(() => {
      scanCallback()(null, { id: 'moon-1', localName: 'MoonBoard A', rssi: -60 });
    });

    // The rest timer's connect claims the scan, then starts its own.
    const restTimerScan = Symbol('rest-timer');
    let stopsBeforeHandOver = -1;
    act(() => {
      expect(claimBleScan(restTimerScan)).toBe(true);
      stopsBeforeHandOver = mockBleManager.stopDeviceScan.mock.calls.length;
    });

    // Its listener is gone before the new scan starts: ble-plx would keep it.
    expect(stopsBeforeHandOver).toBe(1);
    expect(currentBleScanOwner()).toBe(restTimerScan);
    expect(result.current.status).toBe('done');
    expect(result.current.devices).toHaveLength(1);
    expect(analytics.track).toHaveBeenCalledWith('Board Quickstart Scan Finished', {
      outcome: 'preempted',
      found_count: 0,
      serialless_count: 1,
      moonboard_count: 1,
      trigger: 'picker_auto',
    });

    // Late advertisements, the old timeout and unmounting touch nothing of the
    // rest timer's.
    act(() => {
      scanCallback()(null, { id: 'moon-2', localName: 'MoonBoard B', rssi: -50 });
      vi.advanceTimersByTime(15_000);
    });
    unmount();
    expect(mockBleManager.stopDeviceScan).toHaveBeenCalledOnce();
    expect(currentBleScanOwner()).toBe(restTimerScan);
    expect(
      analytics.track.mock.calls.filter(([eventName]) => eventName === 'Board Quickstart Scan Finished'),
    ).toHaveLength(1);
    releaseBleScan(restTimerScan);
  });

  it('does not start the radio when the gate says no at the last moment', async () => {
    const mayStartRadio = vi.fn(() => false);
    const { result } = renderHook(() => useBoardScan({ mayStartRadio }));
    await act(async () => {
      await result.current.start('picker_auto');
    });

    expect(mayStartRadio).toHaveBeenCalledOnce();
    expect(result.current.status).toBe('idle');
    expect(mockBleManager.startDeviceScan).not.toHaveBeenCalled();
    expect(currentBleScanOwner()).toBeNull();
  });

  it('asks the gate only once the permission and the radio checks are done', async () => {
    mockBleManager.state.mockResolvedValue('PoweredOff');
    const mayStartRadio = vi.fn(() => true);
    const { result } = renderHook(() => useBoardScan({ mayStartRadio }));
    await act(async () => {
      await result.current.start('picker_auto');
    });
    expect(result.current.status).toBe('unavailable');
    expect(mayStartRadio).not.toHaveBeenCalled();
  });

  it('finishes early keeping the boards it heard, reported as stopped', async () => {
    const { result } = renderHook(() => useBoardScan());
    await act(async () => {
      await result.current.start('picker_auto');
    });
    act(() => {
      scanCallback()(null, { id: 'moon-1', localName: 'MoonBoard A', rssi: -60 });
    });

    act(() => {
      result.current.finish();
    });

    expect(result.current.status).toBe('done');
    expect(result.current.devices).toHaveLength(1);
    expect(currentBleScanOwner()).toBeNull();
    expect(analytics.track).toHaveBeenCalledWith('Board Quickstart Scan Finished', {
      outcome: 'stopped',
      found_count: 0,
      serialless_count: 1,
      moonboard_count: 1,
      trigger: 'picker_auto',
    });
    // A late advertisement and the old timeout change nothing.
    act(() => {
      scanCallback()(null, { id: 'moon-2', localName: 'MoonBoard B', rssi: -50 });
      vi.advanceTimersByTime(15_000);
    });
    expect(result.current.devices).toHaveLength(1);
    expect(
      analytics.track.mock.calls.filter(([eventName]) => eventName === 'Board Quickstart Scan Finished'),
    ).toHaveLength(1);
  });

  it('drops a start still waiting on the radio, and stays idle', async () => {
    mockBleManager.state.mockResolvedValue('Unknown');
    const stateListeners: Array<(state: string) => void> = [];
    mockBleManager.onStateChange.mockImplementation((listener: (state: string) => void) => {
      stateListeners.push(listener);
      return { remove: vi.fn() };
    });
    const { result } = renderHook(() => useBoardScan());

    await act(async () => {
      const startPromise = result.current.start('picker_auto');
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      result.current.finish();
      stateListeners[0]('PoweredOn');
      await startPromise;
    });

    expect(result.current.status).toBe('idle');
    expect(mockBleManager.startDeviceScan).not.toHaveBeenCalled();
    expect(currentBleScanOwner()).toBeNull();
  });
});
