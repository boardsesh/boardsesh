// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { Alert } from 'react-native';
import type { HoldPlacement } from '../../../components/board-renderer/types';
import {
  reactNativePermissionHarness,
  resetReactNativePermissionHarness,
} from './react-native-permissions-test-harness';

// ── Mock native modules that use-board-bluetooth.ts imports transitively ──

const mockBleManager = vi.hoisted(() => ({
  state: vi.fn().mockResolvedValue('PoweredOn'),
  onStateChange: vi.fn(),
}));

vi.mock('react-native', async () => {
  const { reactNativePermissionHarness: harness } = await import('./react-native-permissions-test-harness');
  return {
    Alert: { alert: vi.fn() },
    AppState: { addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
    Platform: harness.platform,
    PermissionsAndroid: harness.permissionsAndroid,
  };
});

vi.mock('react-native-ble-plx', () => ({
  State: {
    PoweredOn: 'PoweredOn',
    PoweredOff: 'PoweredOff',
    Unknown: 'Unknown',
  },
}));

vi.mock('../ble-manager', () => ({
  bleManager: mockBleManager,
}));

vi.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: vi.fn().mockResolvedValue(undefined),
  deactivateKeepAwake: vi.fn().mockResolvedValue(undefined),
}));

const mockGetAuroraBluetoothPacket = vi.hoisted(() => vi.fn());
const mockParseApiLevel = vi.hoisted(() => vi.fn());
const mockParseSerialNumber = vi.hoisted(() => vi.fn());
vi.mock('@boardsesh/ble-protocol/aurora', () => ({
  getAuroraBluetoothPacket: mockGetAuroraBluetoothPacket,
  parseApiLevel: mockParseApiLevel,
  parseBoardTypeFromDeviceName: vi.fn(),
  parseSerialNumber: mockParseSerialNumber,
}));

const mockTrack = vi.hoisted(() => vi.fn());
vi.mock('../../analytics', () => ({
  track: mockTrack,
}));

const mockGetLedPlacements = vi.hoisted(() => vi.fn());
vi.mock('@boardsesh/board-constants/led-placements', () => ({
  getLedPlacements: mockGetLedPlacements,
}));

const mockGetMoonboardBluetoothPacket = vi.hoisted(() => vi.fn());
vi.mock('@boardsesh/ble-protocol/moonboard', () => ({
  getMoonboardBluetoothPacket: mockGetMoonboardBluetoothPacket,
  isMoonboardDeviceName: vi.fn((name?: string) => !!name && name.startsWith('MoonBoard')),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

// The serial-recording path imports the GraphQL HTTP client, which transitively
// pulls in expo-secure-store (via the auth interceptor) — unavailable in the
// test environment. Short-circuit it; these tests only exercise the pure helpers.
vi.mock('../../graphql/client', () => ({
  getHttpClient: vi.fn(() => ({ request: vi.fn().mockResolvedValue({ recordBoardSerial: null }) })),
}));

// The serial-recording path also reads the stored auth token to skip the
// mutation when signed out. auth-store imports expo-secure-store directly, which
// is unavailable in the test environment — stub it with a present token.
vi.mock('../../auth-store', () => ({
  getAuthToken: vi.fn().mockResolvedValue('test-token'),
}));

vi.mock('../adapter', () => ({
  RNBleAdapter: vi.fn(),
}));

// The remembered-board persistence store pulls in AsyncStorage transitively;
// mock it so the hook's persist/hydrate wiring can be asserted without a native
// module, and so its behaviour is observable via these spies (#3609).
const mockLastConnectedBoardStore = vi.hoisted(() => ({
  getStoredLastConnectedBoard: vi.fn(
    async (): Promise<{ configKey: string; serial?: string; deviceId?: string } | null> => null,
  ),
  setStoredLastConnectedBoard: vi.fn(async () => {}),
  clearStoredLastConnectedBoard: vi.fn(async () => {}),
}));
vi.mock('../last-connected-board-store', () => mockLastConnectedBoardStore);

// Spy on reportHandledError (keep the real noise-policy/other exports) so a
// connect failure's Sentry tags can be asserted (#3480).
vi.mock('../../error-reporting', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../error-reporting')>();
  return { ...actual, reportHandledError: vi.fn() };
});

// adapter-factory pulls in modules/live-activity/src/index, which pulls in
// expo-modules-core, which references the React Native `__DEV__` global at
// import time. Short-circuiting the factory here avoids that chain — the
// tests below only exercise the pure helpers `convertToMirroredFramesString`
// and `dispatchMoonboardPacket`.
vi.mock('../adapter-factory', () => ({
  createBluetoothAdapter: vi.fn(),
  isNativeIosBleAdapter: vi.fn().mockReturnValue(false),
  // Adoption seam: null/absent = platform without native connection adoption.
  subscribeNativeBleConnected: vi.fn(() => null),
  getNativeBleConnectedDevice: vi.fn(async () => null),
}));

import {
  createBluetoothAdapter,
  getNativeBleConnectedDevice,
  isNativeIosBleAdapter,
  subscribeNativeBleConnected,
} from '../adapter-factory';
import { parseBoardTypeFromDeviceName, parseSerialNumber } from '@boardsesh/ble-protocol/aurora';
// The Woods encoder is left unmocked (unlike MoonBoard's) — it is pure, and the
// dispatch tests below assert the real ASCII command, so the LED table is read
// here rather than restated as magic numbers.
import { WOODS_LED_MAPS } from '@boardsesh/board-constants/woods';
import {
  bleConnectReportLevel,
  bleWriteDiagnosticsProperties,
  convertToMirroredFramesString,
  dispatchMoonboardPacket,
  dispatchWoodsPacket,
  moonboardNumRowsForNative,
  resolveWriteSignal,
  useBoardBluetooth,
  type BleConnectionHandle,
} from '../use-board-bluetooth';
import { getBleEncodingSignature } from '../encoding-signature';
import type { BleWriteDiagnostics } from '../types';
import { reportHandledError } from '../../error-reporting';
import { createBleWriteActivityStore } from '../write-activity-store';

// ── Factory helpers ────────────────────────────────────────────────────────

function makePlacement(id: number, mirroredHoldId: number | null): HoldPlacement {
  return { id, mirroredHoldId, cx: 0, cy: 0, r: 10 };
}

type FakeAdapterOverrides = Partial<Record<'isAvailable' | 'requestAndConnect' | 'disconnect' | 'write', unknown>>;

/**
 * A `write` spy typed with the adapter's real signature, so a test can decode the
 * bytes that reached the board. `makeFakeAdapter`'s override map is `unknown`-typed
 * (it takes any shape of stub), which erases that on the returned object.
 */
function makeWriteSpy() {
  return vi.fn<(data: Uint8Array, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);
}

function makeFakeAdapter(overrides: FakeAdapterOverrides = {}) {
  return {
    isAvailable: vi.fn().mockResolvedValue(true),
    requestAndConnect: vi.fn().mockResolvedValue({ deviceId: 'device-1', deviceName: 'Kilter Board#123@3' }),
    disconnect: vi.fn().mockResolvedValue(undefined),
    write: vi.fn().mockResolvedValue(undefined),
    onDisconnect: vi.fn(() => () => {}),
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('useBoardBluetooth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetReactNativePermissionHarness();
    mockBleManager.state.mockResolvedValue('PoweredOn');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows permission copy and stops before adapter availability when Android BLE permission is denied', async () => {
    reactNativePermissionHarness.permissionsAndroid.requestMultiple.mockResolvedValue({
      BLUETOOTH_SCAN: 'denied',
      BLUETOOTH_CONNECT: 'granted',
    });
    const { result } = renderHook(() =>
      useBoardBluetooth({
        boardName: 'kilter',
        layoutId: 1,
        sizeId: 1,
      }),
    );

    let connected = true;
    await act(async () => {
      connected = await result.current.connect();
    });

    expect(connected).toBe(false);
    expect(Alert.alert).toHaveBeenCalledWith('ble.permissionRequired', 'ble.errorPermissionDenied');
    expect(createBluetoothAdapter).not.toHaveBeenCalled();
  });

  it('reports a denied BLE permission to analytics — the Alert used to be the only trace', async () => {
    // Before this event existed, a refusal raised a dialog and emitted nothing,
    // so a whole class of "Bluetooth doesn't work" was invisible in telemetry.
    // The location state rides along because on Android 12+ a permission denial
    // and a location-suppressed empty scan look identical from the outside.
    reactNativePermissionHarness.platform.Version = 33;
    reactNativePermissionHarness.permissionsAndroid.requestMultiple.mockResolvedValue({
      BLUETOOTH_SCAN: 'denied',
      BLUETOOTH_CONNECT: 'denied',
    });
    reactNativePermissionHarness.permissionsAndroid.check.mockResolvedValue(false);

    const { result } = renderHook(() =>
      useBoardBluetooth({
        boardName: 'kilter',
        layoutId: 1,
        sizeId: 1,
      }),
    );

    await act(async () => {
      await result.current.connect();
    });

    await waitFor(() => {
      expect(mockTrack).toHaveBeenCalledWith('Bluetooth Permission Denied', {
        surface: 'connect',
        boardName: 'kilter',
        platform: 'android',
        androidApiLevel: 33,
        androidLocationPermissionGranted: false,
      });
    });
  });

  it('ignores a second connect while one is already in flight', async () => {
    let resolveRequest!: (connection: { deviceId: string; deviceName?: string }) => void;
    const fakeAdapter = makeFakeAdapter({
      requestAndConnect: vi.fn(
        () =>
          new Promise<{ deviceId: string; deviceName?: string }>((resolve) => {
            resolveRequest = resolve;
          }),
      ),
    });
    vi.mocked(createBluetoothAdapter).mockReturnValue(
      fakeAdapter as unknown as ReturnType<typeof createBluetoothAdapter>,
    );

    const { result } = renderHook(() => useBoardBluetooth({ boardName: 'moonboard', layoutId: 1, sizeId: 1 }));

    let firstConnect!: Promise<boolean>;
    let secondConnectResult = true;
    await act(async () => {
      firstConnect = result.current.connect();
      // Let the first attempt get past permissions and adapter creation.
      await Promise.resolve();
      secondConnectResult = await result.current.connect();
    });

    expect(secondConnectResult).toBe(false);
    expect(createBluetoothAdapter).toHaveBeenCalledTimes(1);
    expect(createBluetoothAdapter).toHaveBeenCalledWith(expect.any(Function), 'moonboard', {
      preferWriteWithResponse: false,
    });

    await act(async () => {
      resolveRequest({ deviceId: 'device-1', deviceName: 'MoonBoard' });
      await firstConnect;
    });
    expect(result.current.isConnected).toBe(true);
  });

  it('alerts on a "cancelled"-flavoured native failure instead of staying silent', async () => {
    // CoreBluetooth/ble-plx reject with "Operation was cancelled" for real
    // failures. The old bare /cancel/i regex treated this as a user cancel and
    // showed nothing — the headline "tapped connect and nothing happened" bug.
    const fakeAdapter = makeFakeAdapter({
      requestAndConnect: vi.fn().mockRejectedValue(new Error('Operation was cancelled')),
    });
    vi.mocked(createBluetoothAdapter).mockReturnValue(
      fakeAdapter as unknown as ReturnType<typeof createBluetoothAdapter>,
    );

    const { result } = renderHook(() => useBoardBluetooth({ boardName: 'kilter', layoutId: 1, sizeId: 1 }));

    await act(async () => {
      await result.current.connect();
    });

    expect(createBluetoothAdapter).toHaveBeenCalledWith(expect.any(Function), 'aurora', {
      preferWriteWithResponse: false,
    });
    expect(Alert.alert).toHaveBeenCalledWith('ble.connectionFailedTitle', 'bluetooth.unknownError');
  });

  it('stays silent when the user dismisses the device picker', async () => {
    const fakeAdapter = makeFakeAdapter({
      requestAndConnect: vi.fn().mockRejectedValue(new Error('Device selection cancelled')),
    });
    vi.mocked(createBluetoothAdapter).mockReturnValue(
      fakeAdapter as unknown as ReturnType<typeof createBluetoothAdapter>,
    );

    const { result } = renderHook(() => useBoardBluetooth({ boardName: 'kilter', layoutId: 1, sizeId: 1 }));

    await act(async () => {
      await result.current.connect();
    });

    expect(Alert.alert).not.toHaveBeenCalled();
  });

  it('maps a connect timeout to the connect-failed copy', async () => {
    const fakeAdapter = makeFakeAdapter({
      requestAndConnect: vi.fn().mockRejectedValue(new Error('Connection timed out — board may be powered off')),
    });
    vi.mocked(createBluetoothAdapter).mockReturnValue(
      fakeAdapter as unknown as ReturnType<typeof createBluetoothAdapter>,
    );

    const { result } = renderHook(() => useBoardBluetooth({ boardName: 'kilter', layoutId: 1, sizeId: 1 }));

    await act(async () => {
      await result.current.connect();
    });

    expect(Alert.alert).toHaveBeenCalledWith('ble.connectionFailedTitle', 'bluetooth.connectFailed');
  });

  it('tags a service_missing failure with the services the board exposed (#3480)', async () => {
    const fakeAdapter = makeFakeAdapter({
      requestAndConnect: vi.fn().mockRejectedValue(new Error('UART service was not found')),
    });
    // Newer binary: the adapter can report what the board actually exposed.
    (fakeAdapter as Record<string, unknown>).getLastConnectDiagnostics = vi
      .fn()
      .mockResolvedValue({ discoveredServices: ['180a', '180f'] });
    vi.mocked(createBluetoothAdapter).mockReturnValue(
      fakeAdapter as unknown as ReturnType<typeof createBluetoothAdapter>,
    );

    const { result } = renderHook(() => useBoardBluetooth({ boardName: 'moonboard', layoutId: 1, sizeId: 1 }));

    await act(async () => {
      await result.current.connect();
    });

    expect(Alert.alert).toHaveBeenCalledWith('ble.connectionFailedTitle', 'bluetooth.serviceMissing');
    expect(reportHandledError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: {
          source: 'ble-connect',
          failure_category: 'service_missing',
          ble_discovered_services: '180a,180f',
        },
      }),
    );
  });

  it('tags service_missing with "none" when the board exposed no services (#3480)', async () => {
    const fakeAdapter = makeFakeAdapter({
      requestAndConnect: vi.fn().mockRejectedValue(new Error('UART service was not found')),
    });
    (fakeAdapter as Record<string, unknown>).getLastConnectDiagnostics = vi
      .fn()
      .mockResolvedValue({ discoveredServices: [] });
    vi.mocked(createBluetoothAdapter).mockReturnValue(
      fakeAdapter as unknown as ReturnType<typeof createBluetoothAdapter>,
    );

    const { result } = renderHook(() => useBoardBluetooth({ boardName: 'moonboard', layoutId: 1, sizeId: 1 }));

    await act(async () => {
      await result.current.connect();
    });

    expect(reportHandledError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ ble_discovered_services: 'none' }),
      }),
    );
  });

  it('omits the discovered-services tag on an old binary without the accessor (#3480)', async () => {
    // No getLastConnectDiagnostics on the adapter → no tag, but still reports.
    const fakeAdapter = makeFakeAdapter({
      requestAndConnect: vi.fn().mockRejectedValue(new Error('UART service was not found')),
    });
    vi.mocked(createBluetoothAdapter).mockReturnValue(
      fakeAdapter as unknown as ReturnType<typeof createBluetoothAdapter>,
    );

    const { result } = renderHook(() => useBoardBluetooth({ boardName: 'moonboard', layoutId: 1, sizeId: 1 }));

    await act(async () => {
      await result.current.connect();
    });

    expect(reportHandledError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { source: 'ble-connect', failure_category: 'service_missing' },
      }),
    );
  });

  it('serialises overlapping sendFramesToBoard calls so chunks never interleave', async () => {
    const writeActivityStore = createBleWriteActivityStore();
    const writeEvents: string[] = [];
    let releaseFirstWrite!: () => void;
    const write = vi.fn((packet: Uint8Array) => {
      const label = String(packet[0]);
      writeEvents.push(`start-${label}`);
      if (writeEvents.length === 1) {
        return new Promise<void>((resolve) => {
          releaseFirstWrite = () => {
            writeEvents.push(`end-${label}`);
            resolve();
          };
        });
      }
      writeEvents.push(`end-${label}`);
      return Promise.resolve();
    });
    const fakeAdapter = makeFakeAdapter({ write });
    vi.mocked(createBluetoothAdapter).mockReturnValue(
      fakeAdapter as unknown as ReturnType<typeof createBluetoothAdapter>,
    );
    mockGetMoonboardBluetoothPacket
      .mockReturnValueOnce({ packet: new Uint8Array([1]) })
      .mockReturnValueOnce({ packet: new Uint8Array([2]) });

    const { result } = renderHook(() =>
      useBoardBluetooth({ boardName: 'moonboard', layoutId: 1, sizeId: 1, writeActivityStore }),
    );

    await act(async () => {
      await result.current.connect();
    });

    let firstSend!: Promise<boolean | undefined>;
    let secondSend!: Promise<boolean | undefined>;
    await act(async () => {
      firstSend = result.current.sendFramesToBoard('p1r12');
      secondSend = result.current.sendFramesToBoard('p2r12');
      // Give the second send every chance to start out of order.
      await Promise.resolve();
      await Promise.resolve();
      expect(writeEvents).toEqual(['start-1']);
      expect(writeActivityStore.getSnapshot()).toBe(true);
      releaseFirstWrite();
      await Promise.all([firstSend, secondSend]);
    });

    expect(writeEvents).toEqual(['start-1', 'end-1', 'start-2', 'end-2']);
    expect(writeActivityStore.getSnapshot()).toBe(false);
  });

  it('does not report write activity for the early no-adapter guard', async () => {
    const writeActivityStore = createBleWriteActivityStore();
    const listener = vi.fn();
    writeActivityStore.subscribe(listener);
    const { result } = renderHook(() =>
      useBoardBluetooth({ boardName: 'kilter', layoutId: 1, sizeId: 1, writeActivityStore }),
    );

    let sendResult: boolean | undefined = true;
    await act(async () => {
      sendResult = await result.current.sendFramesToBoard('p1r12');
    });

    expect(sendResult).toBeUndefined();
    expect(writeActivityStore.getSnapshot()).toBe(false);
    expect(listener).not.toHaveBeenCalled();
  });

  it('releases write activity when an adapter write rejects', async () => {
    const writeActivityStore = createBleWriteActivityStore();
    const activityListener = vi.fn();
    writeActivityStore.subscribe(activityListener);
    const fakeAdapter = makeFakeAdapter({ write: vi.fn().mockRejectedValue(new Error('transient write failure')) });
    vi.mocked(createBluetoothAdapter).mockReturnValue(
      fakeAdapter as unknown as ReturnType<typeof createBluetoothAdapter>,
    );
    mockGetMoonboardBluetoothPacket.mockReturnValue({
      packet: new Uint8Array([1]),
      skippedRoleCount: 0,
      skippedPositionCount: 0,
      totalPlacements: 1,
      isClear: false,
    });
    const { result } = renderHook(() =>
      useBoardBluetooth({ boardName: 'moonboard', layoutId: 1, sizeId: 1, writeActivityStore }),
    );

    await act(async () => {
      await result.current.connect();
    });
    let sendResult: boolean | undefined = true;
    await act(async () => {
      sendResult = await result.current.sendFramesToBoard('p1r12');
    });

    expect(sendResult).toBe(false);
    expect(writeActivityStore.getSnapshot()).toBe(false);
    expect(activityListener).toHaveBeenCalledTimes(2);
  });

  it('uses an updated moonboardLightAdjacentHolds setting on the live connection', async () => {
    const fakeAdapter = makeFakeAdapter();
    vi.mocked(createBluetoothAdapter).mockReturnValue(
      fakeAdapter as unknown as ReturnType<typeof createBluetoothAdapter>,
    );
    mockGetMoonboardBluetoothPacket.mockReturnValue({
      packet: new Uint8Array([1]),
      skippedRoleCount: 0,
      skippedPositionCount: 0,
      totalPlacements: 1,
      isClear: false,
    });
    const { result, rerender } = renderHook(
      ({ lightAdjacentHolds }) =>
        useBoardBluetooth({
          boardName: 'moonboard',
          layoutId: 1,
          sizeId: 1,
          moonboardLightAdjacentHolds: lightAdjacentHolds,
        }),
      { initialProps: { lightAdjacentHolds: false } },
    );

    await act(async () => {
      await result.current.connect();
    });
    await act(async () => {
      await result.current.sendFramesToBoard('p1r12');
    });
    rerender({ lightAdjacentHolds: true });
    await act(async () => {
      await result.current.sendFramesToBoard('p1r12');
    });

    expect(mockGetMoonboardBluetoothPacket).toHaveBeenNthCalledWith(1, 'p1r12', 18, { lightAdjacentHolds: false });
    expect(mockGetMoonboardBluetoothPacket).toHaveBeenNthCalledWith(2, 'p1r12', 18, { lightAdjacentHolds: true });
  });

  it('tracks connect-initial MoonBoard frames until the adapter write settles', async () => {
    const writeActivityStore = createBleWriteActivityStore();
    let resolveWrite!: () => void;
    const fakeAdapter = makeFakeAdapter({
      write: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveWrite = resolve;
          }),
      ),
    });
    vi.mocked(createBluetoothAdapter).mockReturnValue(
      fakeAdapter as unknown as ReturnType<typeof createBluetoothAdapter>,
    );
    mockGetMoonboardBluetoothPacket.mockReturnValue({
      packet: new Uint8Array([1]),
      skippedRoleCount: 0,
      skippedPositionCount: 0,
      totalPlacements: 1,
      isClear: false,
    });
    const { result } = renderHook(() =>
      useBoardBluetooth({ boardName: 'moonboard', layoutId: 1, sizeId: 1, writeActivityStore }),
    );

    let connectPromise!: Promise<boolean>;
    act(() => {
      connectPromise = result.current.connect('p1r12');
    });
    await waitFor(() => expect(writeActivityStore.getSnapshot()).toBe(true));

    await act(async () => {
      resolveWrite();
      await connectPromise;
    });

    expect(result.current.isConnected).toBe(true);
    expect(writeActivityStore.getSnapshot()).toBe(false);
  });

  it('resets a dropped generation and ignores its late release after a new write begins', async () => {
    const writeActivityStore = createBleWriteActivityStore();
    let resolveOldWrite!: () => void;
    let resolveNewWrite!: () => void;
    const oldAdapter = makeFakeAdapter({
      write: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveOldWrite = resolve;
          }),
      ),
    });
    const newAdapter = makeFakeAdapter({
      write: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveNewWrite = resolve;
          }),
      ),
    });
    vi.mocked(createBluetoothAdapter)
      .mockReturnValueOnce(oldAdapter as unknown as ReturnType<typeof createBluetoothAdapter>)
      .mockReturnValueOnce(newAdapter as unknown as ReturnType<typeof createBluetoothAdapter>);
    mockGetMoonboardBluetoothPacket.mockReturnValue({
      packet: new Uint8Array([1]),
      skippedRoleCount: 0,
      skippedPositionCount: 0,
      totalPlacements: 1,
      isClear: false,
    });
    const { result } = renderHook(() =>
      useBoardBluetooth({ boardName: 'moonboard', layoutId: 1, sizeId: 1, writeActivityStore }),
    );

    await act(async () => {
      await result.current.connect();
    });
    let oldSend!: Promise<boolean | undefined>;
    act(() => {
      oldSend = result.current.sendFramesToBoard('p1r12');
    });
    await waitFor(() => expect(writeActivityStore.getSnapshot()).toBe(true));

    await act(async () => {
      await result.current.disconnect();
    });
    expect(writeActivityStore.getSnapshot()).toBe(false);

    await act(async () => {
      await result.current.connect();
    });
    let newSend!: Promise<boolean | undefined>;
    act(() => {
      newSend = result.current.sendFramesToBoard('p2r12');
    });
    await waitFor(() => expect(writeActivityStore.getSnapshot()).toBe(true));

    await act(async () => {
      resolveOldWrite();
      await oldSend;
    });
    expect(writeActivityStore.getSnapshot()).toBe(true);

    await act(async () => {
      resolveNewWrite();
      await newSend;
    });
    expect(writeActivityStore.getSnapshot()).toBe(false);
  });

  it('resets write activity on hook unmount even when an adapter ignores abort', async () => {
    const writeActivityStore = createBleWriteActivityStore();
    let resolveWrite!: () => void;
    const fakeAdapter = makeFakeAdapter({
      write: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveWrite = resolve;
          }),
      ),
    });
    vi.mocked(createBluetoothAdapter).mockReturnValue(
      fakeAdapter as unknown as ReturnType<typeof createBluetoothAdapter>,
    );
    mockGetMoonboardBluetoothPacket.mockReturnValue({
      packet: new Uint8Array([1]),
      skippedRoleCount: 0,
      skippedPositionCount: 0,
      totalPlacements: 1,
      isClear: false,
    });
    const { result, unmount } = renderHook(() =>
      useBoardBluetooth({ boardName: 'moonboard', layoutId: 1, sizeId: 1, writeActivityStore }),
    );

    await act(async () => {
      await result.current.connect();
    });
    let send!: Promise<boolean | undefined>;
    act(() => {
      send = result.current.sendFramesToBoard('p1r12');
    });
    await waitFor(() => expect(writeActivityStore.getSnapshot()).toBe(true));

    unmount();
    expect(writeActivityStore.getSnapshot()).toBe(false);

    await act(async () => {
      resolveWrite();
      await send;
    });
    expect(writeActivityStore.getSnapshot()).toBe(false);
  });

  it('refuses a mirrored send on a mirroring board when holdsData is missing (never sends un-mirrored frames)', async () => {
    // Tension layout 1 supports mirroring. holdsData is intentionally omitted —
    // the provider must thread it in; without it we must NOT silently send the
    // un-mirrored frames (which would light the wrong holds on the wall).
    const fakeAdapter = makeFakeAdapter({
      requestAndConnect: vi.fn().mockResolvedValue({ deviceId: 'dev-1', deviceName: 'Tension A1#0042@3' }),
    });
    vi.mocked(createBluetoothAdapter).mockReturnValue(
      fakeAdapter as unknown as ReturnType<typeof createBluetoothAdapter>,
    );
    mockParseApiLevel.mockReturnValue(3);
    mockParseSerialNumber.mockReturnValue('0042');

    const { result } = renderHook(() => useBoardBluetooth({ boardName: 'tension', layoutId: 1, sizeId: 1 }));

    await act(async () => {
      await result.current.connect();
    });

    let sendResult: boolean | undefined;
    await act(async () => {
      sendResult = await result.current.sendFramesToBoard('p1r12', true);
    });

    expect(sendResult).toBe(false);
    expect(Alert.alert).toHaveBeenCalledWith('ble.sendFailedTitle', 'ble.errorIncompatible');
    // The board must never receive the original (un-mirrored) frames.
    expect(fakeAdapter.write).not.toHaveBeenCalled();
    const failureCall = mockTrack.mock.calls.find(([name]) => name === 'Climb Sent to Board Failure');
    expect(failureCall?.[1]).toMatchObject({ failureReason: 'missing_mirror_data', mirrored: true });
  });

  it('mirrors and sends when holdsData is present on a mirroring board', async () => {
    const fakeAdapter = makeFakeAdapter({
      requestAndConnect: vi.fn().mockResolvedValue({ deviceId: 'dev-1', deviceName: 'Tension A1#0042@3' }),
    });
    vi.mocked(createBluetoothAdapter).mockReturnValue(
      fakeAdapter as unknown as ReturnType<typeof createBluetoothAdapter>,
    );
    mockParseApiLevel.mockReturnValue(3);
    mockParseSerialNumber.mockReturnValue('0042');
    // A non-empty placement map lets the write proceed past the empty-placement guard.
    mockGetLedPlacements.mockReturnValue({ 1: 0, 99: 1 });
    mockGetAuroraBluetoothPacket.mockReturnValue({
      packet: new Uint8Array([0x01]),
      skippedPositionCount: 0,
      skippedRoleCount: 0,
      totalPlacements: 1,
    });

    const holdsData = [makePlacement(1, 99)];
    const { result } = renderHook(() => useBoardBluetooth({ boardName: 'tension', layoutId: 1, sizeId: 1, holdsData }));

    await act(async () => {
      await result.current.connect();
    });

    let sendResult: boolean | undefined;
    await act(async () => {
      sendResult = await result.current.sendFramesToBoard('p1r12', true);
    });

    expect(sendResult).toBe(true);
    expect(fakeAdapter.write).toHaveBeenCalledTimes(1);
    // The mirrored frame (hold 1 -> 99) must have been fed to the packet builder.
    expect(mockGetAuroraBluetoothPacket).toHaveBeenCalledWith('p99r12', expect.anything(), 'tension', 3, undefined);
  });

  it('passes configured Aurora role colours to the packet builder', async () => {
    const fakeAdapter = makeFakeAdapter({
      requestAndConnect: vi.fn().mockResolvedValue({ deviceId: 'dev-1', deviceName: 'Kilter A1#0042@3' }),
    });
    vi.mocked(createBluetoothAdapter).mockReturnValue(
      fakeAdapter as unknown as ReturnType<typeof createBluetoothAdapter>,
    );
    mockParseApiLevel.mockReturnValue(3);
    mockParseSerialNumber.mockReturnValue('0042');
    mockGetLedPlacements.mockReturnValue({ 100: 7 });
    mockGetAuroraBluetoothPacket.mockReturnValue({
      packet: new Uint8Array([0x01]),
      skippedPositionCount: 0,
      skippedRoleCount: 0,
      totalPlacements: 1,
    });
    const ledColorOverrides = { HAND: '#123456' };

    const { result } = renderHook(() =>
      useBoardBluetooth({ boardName: 'kilter', layoutId: 1, sizeId: 1, ledColorOverrides }),
    );

    await act(async () => {
      await result.current.connect();
    });

    await act(async () => {
      await result.current.sendFramesToBoard('p100r13');
    });

    expect(mockGetAuroraBluetoothPacket).toHaveBeenCalledWith(
      'p100r13',
      expect.anything(),
      'kilter',
      3,
      ledColorOverrides,
    );
  });

  it('aborts queued and in-flight writes on disconnect', async () => {
    const write = vi.fn(
      (_packet: Uint8Array, signal?: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new DOMException('Write aborted', 'AbortError')));
        }),
    );
    const fakeAdapter = makeFakeAdapter({ write });
    vi.mocked(createBluetoothAdapter).mockReturnValue(
      fakeAdapter as unknown as ReturnType<typeof createBluetoothAdapter>,
    );
    mockGetMoonboardBluetoothPacket.mockReturnValue({ packet: new Uint8Array([1]) });

    const { result } = renderHook(() => useBoardBluetooth({ boardName: 'moonboard', layoutId: 1, sizeId: 1 }));

    await act(async () => {
      await result.current.connect();
    });

    let pendingSend!: Promise<boolean | undefined>;
    await act(async () => {
      pendingSend = result.current.sendFramesToBoard('p1r12');
      await Promise.resolve();
      await result.current.disconnect();
    });

    // The aborted write resolves as a cancellation (undefined), not a failure.
    await expect(pendingSend).resolves.toBeUndefined();
    expect(fakeAdapter.disconnect).toHaveBeenCalled();
  });

  it('disposes the adapter when a write fails on a dead link', async () => {
    // A write that rejects with a disconnection signature ("Not connected") is
    // often the only signal we get when another device grabs the board — the
    // adapter's disconnect event may never fire. The drop path must dispose the
    // leaked adapter (and its native link / subscriptions), not just flip state.
    const fakeAdapter = makeFakeAdapter({
      write: vi.fn().mockRejectedValue(new Error('Not connected')),
    });
    vi.mocked(createBluetoothAdapter).mockReturnValue(
      fakeAdapter as unknown as ReturnType<typeof createBluetoothAdapter>,
    );
    mockGetLedPlacements.mockReturnValue({ 100: 7 });
    mockGetAuroraBluetoothPacket.mockReturnValue({
      packet: new Uint8Array([9]),
      skippedPositionCount: 0,
      skippedRoleCount: 0,
      totalPlacements: 1,
    });

    const { result } = renderHook(() => useBoardBluetooth({ boardName: 'kilter', layoutId: 1, sizeId: 1 }));

    await act(async () => {
      await result.current.connect();
    });
    expect(result.current.isConnected).toBe(true);

    await act(async () => {
      await result.current.sendFramesToBoard('p100r12');
    });

    expect(fakeAdapter.disconnect).toHaveBeenCalled();
    expect(result.current.isConnected).toBe(false);
  });

  it('tracks incompatible_climb with skip counts and the provided send context', async () => {
    const fakeAdapter = makeFakeAdapter();
    vi.mocked(createBluetoothAdapter).mockReturnValue(
      fakeAdapter as unknown as ReturnType<typeof createBluetoothAdapter>,
    );
    mockGetLedPlacements.mockReturnValue({ 100: 7 });
    // Empty packet + skipped placements = every placement was dropped → incompatible.
    mockGetAuroraBluetoothPacket.mockReturnValue({
      packet: new Uint8Array([]),
      skippedPositionCount: 3,
      skippedRoleCount: 1,
      totalPlacements: 4,
    });

    const { result } = renderHook(() =>
      useBoardBluetooth({
        boardName: 'kilter',
        layoutId: 1,
        sizeId: 1,
        getConnectedViaMismatchOverride: () => true,
      }),
    );
    await act(async () => {
      await result.current.connect();
    });

    let sendResult: boolean | undefined;
    await act(async () => {
      sendResult = await result.current.sendFramesToBoard('p100r12', false, undefined, {
        sendSource: 'auto',
        targetQueueItemUuid: 'q-1',
        climbUuid: 'c-1',
        climbBoardType: 'tension',
        climbLayoutId: 1,
      });
    });

    expect(sendResult).toBe(false);
    expect(Alert.alert).toHaveBeenCalledWith('ble.sendFailedTitle', 'ble.errorIncompatible');
    const failure = mockTrack.mock.calls.find(([name]) => name === 'Climb Sent to Board Failure');
    expect(failure?.[1]).toMatchObject({
      failureReason: 'incompatible_climb',
      skippedPositionCount: 3,
      skippedRoleCount: 1,
      totalPlacements: 4,
      sendSource: 'auto',
      targetQueueItemUuid: 'q-1',
      climbUuid: 'c-1',
      climbBoardType: 'tension',
      climbLayoutId: 1,
      connectedViaMismatchOverride: true,
    });
  });

  it('attaches connectedViaMismatchOverride to the connection-success event', async () => {
    const fakeAdapter = makeFakeAdapter();
    vi.mocked(createBluetoothAdapter).mockReturnValue(
      fakeAdapter as unknown as ReturnType<typeof createBluetoothAdapter>,
    );

    const { result } = renderHook(() =>
      useBoardBluetooth({ boardName: 'kilter', layoutId: 1, sizeId: 1, getConnectedViaMismatchOverride: () => true }),
    );
    await act(async () => {
      await result.current.connect();
    });

    const successCall = mockTrack.mock.calls.find(([name]) => name === 'Bluetooth Connection Success');
    expect(successCall?.[1]).toMatchObject({ connectedViaMismatchOverride: true });
  });

  it('emits apiLevel and deviceNamePresent on the connection-success event', async () => {
    const fakeAdapter = makeFakeAdapter({
      requestAndConnect: vi.fn().mockResolvedValue({ deviceId: 'dev-1', deviceName: 'Kilter A1#0042@3' }),
    });
    vi.mocked(createBluetoothAdapter).mockReturnValue(
      fakeAdapter as unknown as ReturnType<typeof createBluetoothAdapter>,
    );
    mockParseApiLevel.mockReturnValue(3);
    mockParseSerialNumber.mockReturnValue('0042');

    const { result } = renderHook(() => useBoardBluetooth({ boardName: 'kilter', layoutId: 1, sizeId: 1 }));

    await act(async () => {
      await result.current.connect();
    });

    const successCall = mockTrack.mock.calls.find(([name]) => name === 'Bluetooth Connection Success');
    expect(successCall).toBeDefined();
    expect(successCall?.[1]).toMatchObject({ apiLevel: 3, deviceNamePresent: true });
  });

  it('reports deviceNamePresent=false and the v2 fallback level when no name is advertised', async () => {
    const fakeAdapter = makeFakeAdapter({
      requestAndConnect: vi.fn().mockResolvedValue({ deviceId: 'dev-2', deviceName: undefined }),
    });
    vi.mocked(createBluetoothAdapter).mockReturnValue(
      fakeAdapter as unknown as ReturnType<typeof createBluetoothAdapter>,
    );
    // Mirrors parseApiLevel's real default for a missing/unparseable name.
    mockParseApiLevel.mockReturnValue(2);
    mockParseSerialNumber.mockReturnValue(undefined);

    const { result } = renderHook(() => useBoardBluetooth({ boardName: 'kilter', layoutId: 1, sizeId: 1 }));

    await act(async () => {
      await result.current.connect();
    });

    const successCall = mockTrack.mock.calls.find(([name]) => name === 'Bluetooth Connection Success');
    expect(successCall).toBeDefined();
    expect(successCall?.[1]).toMatchObject({ apiLevel: 2, deviceNamePresent: false });
  });

  it('attaches per-write transport diagnostics to the send-success event (#3230)', async () => {
    const writeDiagnostics: BleWriteDiagnostics = {
      chunkSize: 244,
      chunkCount: 2,
      negotiatedMtu: 247,
      lastResumeSource: 'poll',
    };
    // The adapter reports getLastWriteDiagnostics — the iOS-native / ble-plx path.
    const fakeAdapter = {
      ...makeFakeAdapter(),
      getLastWriteDiagnostics: vi.fn().mockResolvedValue(writeDiagnostics),
    };
    vi.mocked(createBluetoothAdapter).mockReturnValue(
      fakeAdapter as unknown as ReturnType<typeof createBluetoothAdapter>,
    );
    mockGetLedPlacements.mockReturnValue({ 100: 7 });
    mockGetAuroraBluetoothPacket.mockReturnValue({
      packet: new Uint8Array([0x01]),
      skippedPositionCount: 0,
      skippedRoleCount: 0,
      totalPlacements: 1,
    });

    const { result } = renderHook(() => useBoardBluetooth({ boardName: 'kilter', layoutId: 1, sizeId: 1 }));
    await act(async () => {
      await result.current.connect();
    });
    await act(async () => {
      await result.current.sendFramesToBoard('p100r13');
    });

    expect(fakeAdapter.getLastWriteDiagnostics).toHaveBeenCalled();
    const successCall = mockTrack.mock.calls.find(([name]) => name === 'Climb Sent to Board Success');
    expect(successCall?.[1]).toMatchObject({
      bleChunkSize: 244,
      bleChunkCount: 2,
      bleNegotiatedMtu: 247,
      bleLastResumeSource: 'poll',
    });
  });

  it('attaches write diagnostics to the MoonBoard send-success event too (#3230)', async () => {
    // MoonBoard sends route through dispatchMoonboardPacket rather than the
    // Aurora branch — the diagnostics wiring must reach this track call too.
    const fakeAdapter = {
      ...makeFakeAdapter(),
      getLastWriteDiagnostics: vi.fn().mockResolvedValue({ negotiatedMtu: 23, chunkSize: 20, chunkCount: 3 }),
    };
    vi.mocked(createBluetoothAdapter).mockReturnValue(
      fakeAdapter as unknown as ReturnType<typeof createBluetoothAdapter>,
    );
    mockGetMoonboardBluetoothPacket.mockReturnValue({
      packet: new Uint8Array([0x01]),
      skippedRoleCount: 0,
      skippedPositionCount: 0,
      totalPlacements: 1,
    });

    const { result } = renderHook(() => useBoardBluetooth({ boardName: 'moonboard', layoutId: 1, sizeId: 1 }));
    await act(async () => {
      await result.current.connect();
    });
    await act(async () => {
      await result.current.sendFramesToBoard('p100r12');
    });

    const successCall = mockTrack.mock.calls.find(([name]) => name === 'Climb Sent to Board Success');
    expect(successCall?.[1]).toMatchObject({
      bleNegotiatedMtu: 23,
      bleChunkSize: 20,
      bleChunkCount: 3,
    });
  });

  it('fires Board Lights Cleared (not Climb Sent to Board Success) on a MoonBoard deliberate clear (#3420)', async () => {
    // Empty frames sends `l##` (isClear), and sendSource 'clear' marks it a
    // user-initiated clear — tracked as a clear, never as a climb send.
    const fakeAdapter = makeFakeAdapter();
    vi.mocked(createBluetoothAdapter).mockReturnValue(
      fakeAdapter as unknown as ReturnType<typeof createBluetoothAdapter>,
    );
    mockGetMoonboardBluetoothPacket.mockReturnValue({
      packet: new TextEncoder().encode('l##'),
      skippedRoleCount: 0,
      skippedPositionCount: 0,
      totalPlacements: 0,
      isClear: true,
    });

    const { result } = renderHook(() => useBoardBluetooth({ boardName: 'moonboard', layoutId: 1, sizeId: 1 }));
    await act(async () => {
      await result.current.connect();
    });
    let cleared: boolean | undefined;
    await act(async () => {
      cleared = await result.current.sendFramesToBoard('', false, undefined, { sendSource: 'clear' });
    });

    expect(cleared).toBe(true);
    expect(fakeAdapter.write).toHaveBeenCalled();
    const clearedCall = mockTrack.mock.calls.find(([name]) => name === 'Board Lights Cleared');
    expect(clearedCall?.[1]).toMatchObject({ boardName: 'moonboard', layoutId: 1, sizeId: 1, sendSource: 'clear' });
    expect(mockTrack.mock.calls.find(([name]) => name === 'Climb Sent to Board Success')).toBeUndefined();
  });

  it('fires Board Lights Cleared on an Aurora deliberate clear (#3420)', async () => {
    // The Aurora clear branch is separate from dispatchMoonboardPacket, so its
    // sendSource-gated tracking needs its own pin.
    const writeActivityStore = createBleWriteActivityStore();
    const activityListener = vi.fn();
    writeActivityStore.subscribe(activityListener);
    const fakeAdapter = makeFakeAdapter();
    vi.mocked(createBluetoothAdapter).mockReturnValue(
      fakeAdapter as unknown as ReturnType<typeof createBluetoothAdapter>,
    );
    mockGetAuroraBluetoothPacket.mockReturnValue({ packet: new Uint8Array([0x01, 0x02]) });

    const { result } = renderHook(() =>
      useBoardBluetooth({ boardName: 'kilter', layoutId: 1, sizeId: 1, writeActivityStore }),
    );
    await act(async () => {
      await result.current.connect();
    });
    let cleared: boolean | undefined;
    await act(async () => {
      cleared = await result.current.sendFramesToBoard('', false, undefined, { sendSource: 'clear' });
    });

    expect(cleared).toBe(true);
    expect(fakeAdapter.write).toHaveBeenCalled();
    expect(writeActivityStore.getSnapshot()).toBe(false);
    expect(activityListener).toHaveBeenCalledTimes(2);
    const clearedCall = mockTrack.mock.calls.find(([name]) => name === 'Board Lights Cleared');
    expect(clearedCall?.[1]).toMatchObject({ boardName: 'kilter', sendSource: 'clear' });
    expect(mockTrack.mock.calls.find(([name]) => name === 'Climb Sent to Board Success')).toBeUndefined();
  });

  it('clears the wall silently for auto-sent empty frames — no clear or success event (#3420)', async () => {
    // A queue/presence climb whose frames are empty still overwrites the wall
    // (Aurora parity) but is not a user clear action: the write goes out and
    // neither Board Lights Cleared nor Climb Sent to Board Success fires.
    const fakeAdapter = makeFakeAdapter();
    vi.mocked(createBluetoothAdapter).mockReturnValue(
      fakeAdapter as unknown as ReturnType<typeof createBluetoothAdapter>,
    );
    mockGetMoonboardBluetoothPacket.mockReturnValue({
      packet: new TextEncoder().encode('l##'),
      skippedRoleCount: 0,
      skippedPositionCount: 0,
      totalPlacements: 0,
      isClear: true,
    });

    const { result } = renderHook(() => useBoardBluetooth({ boardName: 'moonboard', layoutId: 1, sizeId: 1 }));
    await act(async () => {
      await result.current.connect();
    });
    let sent: boolean | undefined;
    await act(async () => {
      sent = await result.current.sendFramesToBoard('');
    });

    expect(sent).toBe(true);
    expect(fakeAdapter.write).toHaveBeenCalled();
    expect(mockTrack.mock.calls.find(([name]) => name === 'Board Lights Cleared')).toBeUndefined();
    expect(mockTrack.mock.calls.find(([name]) => name === 'Climb Sent to Board Success')).toBeUndefined();
  });

  // ── Woods ─────────────────────────────────────────────────────────────────
  // Mobile is the only surface that drives a Woods board (the web Web-Bluetooth
  // path has no Woods encoder), so the branch is pinned here against the real
  // encoder and the real 8×10 LED map rather than a mocked packet builder.
  // 8×10 maps baseHoldLocation 0 → LED 24 and 1 → LED 25; 485+ has no LED.

  it('encodes a Woods climb as the ASCII led,role command and reports success', async () => {
    const woodsWrite = makeWriteSpy();
    const fakeAdapter = {
      ...makeFakeAdapter({ write: woodsWrite }),
      getLastWriteDiagnostics: vi.fn().mockResolvedValue({ negotiatedMtu: 23, chunkSize: 20, chunkCount: 1 }),
    };
    vi.mocked(createBluetoothAdapter).mockReturnValue(
      fakeAdapter as unknown as ReturnType<typeof createBluetoothAdapter>,
    );

    const { result } = renderHook(() => useBoardBluetooth({ boardName: 'woods', layoutId: 1, sizeId: 1 }));
    await act(async () => {
      await result.current.connect();
    });
    let sent: boolean | undefined;
    await act(async () => {
      // p0r4 = Start on LED 24, p1r2 = Hand on LED 25.
      sent = await result.current.sendFramesToBoard('p0r4p1r2');
    });

    expect(sent).toBe(true);
    expect(new TextDecoder().decode(woodsWrite.mock.calls[0]![0])).toBe('24,4,25,2,!');
    const successCall = mockTrack.mock.calls.find(([name]) => name === 'Climb Sent to Board Success');
    expect(successCall?.[1]).toMatchObject({
      boardName: 'woods',
      bleNegotiatedMtu: 23,
      bleChunkSize: 20,
      bleChunkCount: 1,
    });
  });

  it('fires Board Lights Cleared (not a climb send) on a Woods deliberate clear', async () => {
    // Woods encodes "clear" as the bare terminator, so the clear rides the same
    // branch as a climb — the sendSource gate is the only thing separating them.
    const woodsWrite = makeWriteSpy();
    const fakeAdapter = makeFakeAdapter({ write: woodsWrite });
    vi.mocked(createBluetoothAdapter).mockReturnValue(
      fakeAdapter as unknown as ReturnType<typeof createBluetoothAdapter>,
    );

    const { result } = renderHook(() => useBoardBluetooth({ boardName: 'woods', layoutId: 1, sizeId: 1 }));
    await act(async () => {
      await result.current.connect();
    });
    let cleared: boolean | undefined;
    await act(async () => {
      cleared = await result.current.sendFramesToBoard('', false, undefined, { sendSource: 'clear' });
    });

    expect(cleared).toBe(true);
    expect(new TextDecoder().decode(woodsWrite.mock.calls[0]![0])).toBe(',!');
    const clearedCall = mockTrack.mock.calls.find(([name]) => name === 'Board Lights Cleared');
    expect(clearedCall?.[1]).toMatchObject({ boardName: 'woods', sendSource: 'clear' });
    expect(mockTrack.mock.calls.find(([name]) => name === 'Climb Sent to Board Success')).toBeUndefined();
  });

  it('still lights a partially unmapped Woods climb but records the skip', async () => {
    // Two holds land, one has no LED on the 8×10 board. The wall must still light
    // what it can; the encoder is silent by design, so the skip counts it returns
    // — reported here via reportHandledError — are the only trace of the miss.
    const woodsWrite = makeWriteSpy();
    const fakeAdapter = makeFakeAdapter({ write: woodsWrite });
    vi.mocked(createBluetoothAdapter).mockReturnValue(
      fakeAdapter as unknown as ReturnType<typeof createBluetoothAdapter>,
    );

    const { result } = renderHook(() => useBoardBluetooth({ boardName: 'woods', layoutId: 1, sizeId: 1 }));
    await act(async () => {
      await result.current.connect();
    });
    let sent: boolean | undefined;
    await act(async () => {
      sent = await result.current.sendFramesToBoard('p0r4p485r2p1r2');
    });

    expect(sent).toBe(true);
    expect(new TextDecoder().decode(woodsWrite.mock.calls[0]![0])).toBe('24,4,25,2,!');
    const [reportedError, reportContext] = vi.mocked(reportHandledError).mock.calls[0] ?? [];
    expect((reportedError as Error).message).toContain('1 of 3 Woods placements skipped');
    expect(reportContext).toMatchObject({
      level: 'warning',
      tags: { board: 'woods' },
      extra: { skippedPositionCount: 1, skippedRoleCount: 0, totalPlacements: 3 },
    });
  });

  it('refuses a Woods climb whose every hold is unmapped instead of darking the wall', async () => {
    // An all-skipped climb would encode to the bare `,!` — the clear command —
    // so sending it would blank the board while reporting success.
    const fakeAdapter = makeFakeAdapter();
    vi.mocked(createBluetoothAdapter).mockReturnValue(
      fakeAdapter as unknown as ReturnType<typeof createBluetoothAdapter>,
    );

    const { result } = renderHook(() => useBoardBluetooth({ boardName: 'woods', layoutId: 1, sizeId: 1 }));
    await act(async () => {
      await result.current.connect();
    });
    let sent: boolean | undefined;
    await act(async () => {
      sent = await result.current.sendFramesToBoard('p485r2p486r4');
    });

    expect(sent).toBe(false);
    expect(fakeAdapter.write).not.toHaveBeenCalled();
    expect(Alert.alert).toHaveBeenCalledWith('ble.sendFailedTitle', 'ble.errorIncompatible');
    const failureCall = mockTrack.mock.calls.find(([name]) => name === 'Climb Sent to Board Failure');
    expect(failureCall?.[1]).toMatchObject({ boardName: 'woods', failureReason: 'incompatible_climb' });
  });

  it('refuses a Woods send when the size id maps to no LED table', async () => {
    const fakeAdapter = makeFakeAdapter();
    vi.mocked(createBluetoothAdapter).mockReturnValue(
      fakeAdapter as unknown as ReturnType<typeof createBluetoothAdapter>,
    );

    const { result } = renderHook(() => useBoardBluetooth({ boardName: 'woods', layoutId: 1, sizeId: 99 }));
    await act(async () => {
      await result.current.connect();
    });
    let sent: boolean | undefined;
    await act(async () => {
      sent = await result.current.sendFramesToBoard('p0r4');
    });

    expect(sent).toBe(false);
    expect(fakeAdapter.write).not.toHaveBeenCalled();
    const failureCall = mockTrack.mock.calls.find(([name]) => name === 'Climb Sent to Board Failure');
    expect(failureCall?.[1]).toMatchObject({ boardName: 'woods', failureReason: 'missing_led_placements' });
  });

  it('asks the factory for acknowledged writes on Woods and never configures the native board', async () => {
    // Woods firmware takes write requests (protocol spec §8); the preference
    // also keeps the board off the native iOS adapter, whose Swift encoder has
    // no Woods support (#3314) — hence no configureBoard handoff.
    const fakeAdapter = { ...makeFakeAdapter(), configureBoard: vi.fn().mockResolvedValue(undefined) };
    vi.mocked(createBluetoothAdapter).mockReturnValue(
      fakeAdapter as unknown as ReturnType<typeof createBluetoothAdapter>,
    );

    const { result } = renderHook(() => useBoardBluetooth({ boardName: 'woods', layoutId: 1, sizeId: 1 }));
    await act(async () => {
      await result.current.connect();
    });

    expect(createBluetoothAdapter).toHaveBeenCalledWith(expect.any(Function), 'moonboard', {
      preferWriteWithResponse: true,
    });
    expect(fakeAdapter.configureBoard).not.toHaveBeenCalled();
  });

  it('attaches write diagnostics alongside failureReason on a failed send (#3230)', async () => {
    const writeDiagnostics: BleWriteDiagnostics = {
      chunkSize: 244,
      chunkCount: 2,
      watchdogTripped: true,
      parkCount: 5,
    };
    const fakeAdapter = {
      // A write-resume stall on a still-live link (classifies as write_timeout).
      ...makeFakeAdapter({
        write: vi.fn().mockRejectedValue(new Error('BLE write timed out waiting for the board to accept data')),
      }),
      getLastWriteDiagnostics: vi.fn().mockResolvedValue(writeDiagnostics),
    };
    vi.mocked(createBluetoothAdapter).mockReturnValue(
      fakeAdapter as unknown as ReturnType<typeof createBluetoothAdapter>,
    );
    mockGetLedPlacements.mockReturnValue({ 100: 7 });
    mockGetAuroraBluetoothPacket.mockReturnValue({
      packet: new Uint8Array([0x09]),
      skippedPositionCount: 0,
      skippedRoleCount: 0,
      totalPlacements: 1,
    });

    const { result } = renderHook(() => useBoardBluetooth({ boardName: 'kilter', layoutId: 1, sizeId: 1 }));
    await act(async () => {
      await result.current.connect();
    });
    await act(async () => {
      await result.current.sendFramesToBoard('p100r12');
    });

    const failureCall = mockTrack.mock.calls.find(([name]) => name === 'Climb Sent to Board Failure');
    expect(failureCall?.[1]).toMatchObject({
      failureReason: 'write_timeout',
      bleChunkSize: 244,
      bleChunkCount: 2,
      bleWatchdogTripped: true,
      bleParkCount: 5,
    });
  });

  it('suppresses the failure event when the drop event lands before the write rejection (#3365)', async () => {
    let hookDisconnectCallback: ((info?: unknown) => void) | null = null;
    const fakeAdapter = {
      ...makeFakeAdapter(),
      onDisconnect: vi.fn((callback: (info?: unknown) => void) => {
        hookDisconnectCallback = callback;
        return () => {};
      }),
      getLastWriteDiagnostics: vi.fn().mockResolvedValue({ chunkSize: 20 }),
    };
    // A mid-write link drop where the adapter delivers the disconnect event
    // BEFORE the write rejection reaches performSend's catch. The disconnect
    // handler runs clearConnectionAfterDrop, which aborts the write generation
    // — so the catch classifies this send as aborted and must NOT emit a
    // ClimbSentToBoardFailure event: the drop is reported once, via the
    // Bluetooth Disconnected transition, not double-counted as a send failure.
    // (This is also why the diagnostics fetch reads the captured send adapter,
    // not adapterRef — the ref is already null in this ordering.)
    fakeAdapter.write = vi.fn().mockImplementation(() => {
      hookDisconnectCallback?.({ source: 'ble-plx' });
      return Promise.reject(new Error('Device disconnected during write'));
    });
    vi.mocked(createBluetoothAdapter).mockReturnValue(
      fakeAdapter as unknown as ReturnType<typeof createBluetoothAdapter>,
    );
    mockGetLedPlacements.mockReturnValue({ 100: 7 });
    mockGetAuroraBluetoothPacket.mockReturnValue({
      packet: new Uint8Array([0x09]),
      skippedPositionCount: 0,
      skippedRoleCount: 0,
      totalPlacements: 1,
    });

    const { result } = renderHook(() => useBoardBluetooth({ boardName: 'kilter', layoutId: 1, sizeId: 1 }));
    await act(async () => {
      await result.current.connect();
    });
    await act(async () => {
      await result.current.sendFramesToBoard('p100r12');
    });

    const failureCall = mockTrack.mock.calls.find(([name]) => name === 'Climb Sent to Board Failure');
    expect(failureCall).toBeUndefined();
    expect(result.current.isConnected).toBe(false);
  });

  it('drops a MoonBoard only after consecutive dead-link writes so the lightbulb goes out', async () => {
    // A 2016 MoonBoard supervision-timeout drop surfaces as a generic
    // `write_failed` (the native "No board is connected" slips past
    // isDisconnectionError). But a one-off transient write error looks identical,
    // and force-dropping a live MoonBoard is costly — some controllers need a
    // power cycle before a new connection — so a single failure must NOT drop the
    // link; only a genuine drop, which fails every subsequent send, does.
    const fakeAdapter = makeFakeAdapter({
      requestAndConnect: vi.fn().mockResolvedValue({ deviceId: 'moon-1', deviceName: 'MoonBoard' }),
      write: vi.fn().mockRejectedValue(new Error('Write failed')),
    });
    vi.mocked(createBluetoothAdapter).mockReturnValue(
      fakeAdapter as unknown as ReturnType<typeof createBluetoothAdapter>,
    );
    mockGetMoonboardBluetoothPacket.mockReturnValue({
      packet: new Uint8Array([0x09]),
      skippedRoleCount: 0,
      skippedPositionCount: 0,
      totalPlacements: 1,
      isClear: false,
    });

    const { result } = renderHook(() => useBoardBluetooth({ boardName: 'moonboard', layoutId: 1, sizeId: 1 }));
    await act(async () => {
      await result.current.connect();
    });
    expect(result.current.isConnected).toBe(true);

    // First dead-link write: reported, but the link is kept (could be transient).
    await act(async () => {
      await result.current.sendFramesToBoard('p100r12');
    });
    expect(result.current.isConnected).toBe(true);
    expect(fakeAdapter.disconnect).not.toHaveBeenCalled();

    // Second consecutive failure: now treat it as dead and drop so the bulb goes out.
    await act(async () => {
      await result.current.sendFramesToBoard('p101r12');
    });
    expect(result.current.isConnected).toBe(false);
    expect(fakeAdapter.disconnect).toHaveBeenCalled();

    const failures = mockTrack.mock.calls.filter(([name]) => name === 'Climb Sent to Board Failure');
    expect(failures).toHaveLength(2);
    expect(failures[0][1]).toMatchObject({ failureReason: 'write_failed' });
    // A link timeout isn't a steal — don't fire the tug-of-war event.
    expect(mockTrack.mock.calls.find(([name]) => name === 'Bluetooth Connection Stolen')).toBeUndefined();
  });

  it('reports the first ambiguous MoonBoard write_failed as an error, only downgrading once the streak confirms a dead link', async () => {
    // The first `write_failed` could be a genuine write bug unrelated to a dead
    // link — it must still surface at 'error' level so it isn't drowned out.
    // Only the second (streak-confirmed) failure, which drops the connection,
    // downgrades to 'warning' — mirroring the routine-disconnect treatment.
    const fakeAdapter = makeFakeAdapter({
      requestAndConnect: vi.fn().mockResolvedValue({ deviceId: 'moon-1', deviceName: 'MoonBoard' }),
      write: vi.fn().mockRejectedValue(new Error('Write failed')),
    });
    vi.mocked(createBluetoothAdapter).mockReturnValue(
      fakeAdapter as unknown as ReturnType<typeof createBluetoothAdapter>,
    );
    mockGetMoonboardBluetoothPacket.mockReturnValue({
      packet: new Uint8Array([0x09]),
      skippedRoleCount: 0,
      skippedPositionCount: 0,
      totalPlacements: 1,
      isClear: false,
    });

    const { result } = renderHook(() => useBoardBluetooth({ boardName: 'moonboard', layoutId: 1, sizeId: 1 }));
    await act(async () => {
      await result.current.connect();
    });

    await act(async () => {
      await result.current.sendFramesToBoard('p100r12');
    });
    const sendFailureCalls = vi
      .mocked(reportHandledError)
      .mock.calls.filter(([, options]) => options?.tags?.source === 'ble-send');
    expect(sendFailureCalls).toHaveLength(1);
    expect(sendFailureCalls[0][1]).toMatchObject({ level: 'error' });

    await act(async () => {
      await result.current.sendFramesToBoard('p101r12');
    });
    const sendFailureCallsAfterDrop = vi
      .mocked(reportHandledError)
      .mock.calls.filter(([, options]) => options?.tags?.source === 'ble-send');
    expect(sendFailureCallsAfterDrop).toHaveLength(2);
    expect(sendFailureCallsAfterDrop[1][1]).toMatchObject({ level: 'warning' });
  });

  it('resets the MoonBoard dead-link streak after a successful write (no drop on isolated glitches)', async () => {
    // Two write failures with a success between them must not drop the link: the
    // success proves the board is alive, so the streak resets and the second
    // failure is treated as a fresh glitch, not a dead link.
    const write = vi
      .fn()
      .mockRejectedValueOnce(new Error('Write failed'))
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('Write failed'));
    const fakeAdapter = makeFakeAdapter({
      requestAndConnect: vi.fn().mockResolvedValue({ deviceId: 'moon-1', deviceName: 'MoonBoard' }),
      write,
    });
    vi.mocked(createBluetoothAdapter).mockReturnValue(
      fakeAdapter as unknown as ReturnType<typeof createBluetoothAdapter>,
    );
    mockGetMoonboardBluetoothPacket.mockReturnValue({
      packet: new Uint8Array([0x09]),
      skippedRoleCount: 0,
      skippedPositionCount: 0,
      totalPlacements: 1,
      isClear: false,
    });

    const { result } = renderHook(() => useBoardBluetooth({ boardName: 'moonboard', layoutId: 1, sizeId: 1 }));
    await act(async () => {
      await result.current.connect();
    });

    await act(async () => {
      await result.current.sendFramesToBoard('a'); // fail → streak 1
    });
    await act(async () => {
      await result.current.sendFramesToBoard('b'); // success → streak reset to 0
    });
    await act(async () => {
      await result.current.sendFramesToBoard('c'); // fail → streak 1 (not 2)
    });

    expect(result.current.isConnected).toBe(true);
    expect(fakeAdapter.disconnect).not.toHaveBeenCalled();
  });

  it('keeps a MoonBoard connected when a write stalls (write_timeout self-recovers)', async () => {
    // write_timeout is the native layer's own self-recovery path (#3181); it must
    // NOT be torn down here even on a MoonBoard.
    const fakeAdapter = makeFakeAdapter({
      requestAndConnect: vi.fn().mockResolvedValue({ deviceId: 'moon-1', deviceName: 'MoonBoard' }),
      write: vi.fn().mockRejectedValue(new Error('BLE write timed out waiting for the board to accept data')),
    });
    vi.mocked(createBluetoothAdapter).mockReturnValue(
      fakeAdapter as unknown as ReturnType<typeof createBluetoothAdapter>,
    );
    mockGetMoonboardBluetoothPacket.mockReturnValue({
      packet: new Uint8Array([0x09]),
      skippedRoleCount: 0,
      skippedPositionCount: 0,
      totalPlacements: 1,
      isClear: false,
    });

    const { result } = renderHook(() => useBoardBluetooth({ boardName: 'moonboard', layoutId: 1, sizeId: 1 }));
    await act(async () => {
      await result.current.connect();
    });
    await act(async () => {
      await result.current.sendFramesToBoard('p100r12');
    });

    const failureCall = mockTrack.mock.calls.find(([name]) => name === 'Climb Sent to Board Failure');
    expect(failureCall?.[1]).toMatchObject({ failureReason: 'write_timeout' });
    expect(result.current.isConnected).toBe(true);
  });

  it('does not drop a Kilter connection on a generic write_failed (MoonBoard-scoped)', async () => {
    // The dead-link-on-write_failed teardown is scoped to MoonBoard; an Aurora
    // board keeps the existing behaviour (only explicit disconnect signatures
    // tear it down), so a one-off Kilter write hiccup doesn't drop the link.
    const fakeAdapter = makeFakeAdapter({
      write: vi.fn().mockRejectedValue(new Error('Write failed')),
    });
    vi.mocked(createBluetoothAdapter).mockReturnValue(
      fakeAdapter as unknown as ReturnType<typeof createBluetoothAdapter>,
    );
    mockGetLedPlacements.mockReturnValue({ 100: 7 });
    mockGetAuroraBluetoothPacket.mockReturnValue({
      packet: new Uint8Array([0x09]),
      skippedPositionCount: 0,
      skippedRoleCount: 0,
      totalPlacements: 1,
    });

    const { result } = renderHook(() => useBoardBluetooth({ boardName: 'kilter', layoutId: 1, sizeId: 1 }));
    await act(async () => {
      await result.current.connect();
    });
    await act(async () => {
      await result.current.sendFramesToBoard('p100r12');
    });

    const failureCall = mockTrack.mock.calls.find(([name]) => name === 'Climb Sent to Board Failure');
    expect(failureCall?.[1]).toMatchObject({ failureReason: 'write_failed' });
    expect(result.current.isConnected).toBe(true);
  });

  it('remembers a MoonBoard by device id and reconnects to it without the picker', async () => {
    // MoonBoards carry no parseable serial, so we remember the BLE peripheral id
    // and pass it back as the reconnect target; the adapter then silently
    // auto-selects that device instead of opening the picker.
    const requestAndConnect = vi.fn().mockResolvedValue({ deviceId: 'moon-abc', deviceName: 'MoonBoard' });
    const fakeAdapter = makeFakeAdapter({ requestAndConnect });
    vi.mocked(createBluetoothAdapter).mockReturnValue(
      fakeAdapter as unknown as ReturnType<typeof createBluetoothAdapter>,
    );

    const { result } = renderHook(() => useBoardBluetooth({ boardName: 'moonboard', layoutId: 1, sizeId: 1 }));
    await act(async () => {
      await result.current.connect();
    });

    expect(mockLastConnectedBoardStore.setStoredLastConnectedBoard).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: 'moon-abc' }),
    );
    expect(result.current.reconnectDeviceIdForCurrentBoard).toBe('moon-abc');
    expect(result.current.reconnectSerialForCurrentBoard).toBeNull();

    await act(async () => {
      await result.current.connect(undefined, undefined, undefined, 'moon-abc');
    });
    // The reconnect forwards the device id as the second requestAndConnect arg.
    expect(requestAndConnect.mock.calls.at(-1)).toEqual([undefined, 'moon-abc']);
  });

  it('ends an explicitly disconnected generation exactly once', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-01T00:00:00.000Z'));
    const fakeAdapter = makeFakeAdapter();
    vi.mocked(createBluetoothAdapter).mockReturnValue(
      fakeAdapter as unknown as ReturnType<typeof createBluetoothAdapter>,
    );
    const onConnectionEnded = vi.fn();
    const { result } = renderHook(() =>
      useBoardBluetooth({ boardName: 'kilter', layoutId: 1, sizeId: 1, onConnectionEnded }),
    );

    await act(async () => {
      await result.current.connect();
    });
    vi.setSystemTime(new Date('2026-08-01T00:00:06.600Z'));
    await act(async () => {
      await Promise.all([result.current.disconnect(), result.current.disconnect()]);
    });

    expect(onConnectionEnded).toHaveBeenCalledOnce();
    expect(onConnectionEnded).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'user',
        disconnectTrigger: 'explicit_user',
        connectionDurationSec: 7,
        boardName: 'kilter',
      }),
    );
    expect(fakeAdapter.disconnect).toHaveBeenCalledOnce();
  });

  it('uses the session state current when a pending connect opens its lifetime', async () => {
    let resolveConnect!: (connection: { deviceId: string; deviceName?: string }) => void;
    const fakeAdapter = makeFakeAdapter({
      requestAndConnect: vi.fn(
        () =>
          new Promise<{ deviceId: string; deviceName?: string }>((resolve) => {
            resolveConnect = resolve;
          }),
      ),
    });
    vi.mocked(createBluetoothAdapter).mockReturnValue(
      fakeAdapter as unknown as ReturnType<typeof createBluetoothAdapter>,
    );
    const onConnectionEnded = vi.fn();
    const { result, rerender } = renderHook((props) => useBoardBluetooth(props), {
      initialProps: {
        boardName: 'kilter',
        layoutId: 1,
        sizeId: 1,
        analyticsInSession: false,
        onConnectionEnded,
      },
    });

    let connectPromise!: Promise<boolean>;
    await act(async () => {
      connectPromise = result.current.connect();
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      rerender({
        boardName: 'kilter',
        layoutId: 1,
        sizeId: 1,
        analyticsInSession: true,
        onConnectionEnded,
      });
    });

    await act(async () => {
      resolveConnect({ deviceId: 'device-1', deviceName: 'Kilter Board#123@3' });
      await connectPromise;
      await result.current.disconnect();
    });

    expect(onConnectionEnded).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'user',
        disconnectTrigger: 'explicit_user',
        inSession: true,
      }),
    );
  });

  it('attributes adapter replacement to the old generation', async () => {
    const firstAdapter = makeFakeAdapter();
    const secondAdapter = makeFakeAdapter({
      requestAndConnect: vi.fn().mockResolvedValue({ deviceId: 'device-2', deviceName: 'Kilter Board#456@3' }),
    });
    vi.mocked(createBluetoothAdapter)
      .mockReturnValueOnce(firstAdapter as unknown as ReturnType<typeof createBluetoothAdapter>)
      .mockReturnValueOnce(secondAdapter as unknown as ReturnType<typeof createBluetoothAdapter>);
    const onConnectionEnded = vi.fn();
    const onConnectSuccess = vi.fn((_serial: string | null, connection: BleConnectionHandle) => {
      connection.setAnalyticsBoardId(41);
    });
    const { result } = renderHook(() =>
      useBoardBluetooth({
        boardName: 'kilter',
        layoutId: 1,
        sizeId: 1,
        onConnectSuccess,
        onConnectionEnded,
      }),
    );

    await act(async () => {
      await result.current.connect();
      await result.current.connect();
    });

    expect(onConnectionEnded).toHaveBeenCalledOnce();
    expect(onConnectionEnded).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'user',
        disconnectTrigger: 'connection_replacement',
        boardId: 41,
      }),
    );
    expect(firstAdapter.disconnect).toHaveBeenCalledOnce();
    expect(result.current.isConnected).toBe(true);
  });

  it('rejects a generation-one board id that resolves during generation two, then accepts generation two', async () => {
    const firstAdapter = makeFakeAdapter();
    const secondAdapter = makeFakeAdapter({
      requestAndConnect: vi.fn().mockResolvedValue({ deviceId: 'device-2', deviceName: 'Kilter Board#456@3' }),
    });
    vi.mocked(createBluetoothAdapter)
      .mockReturnValueOnce(firstAdapter as unknown as ReturnType<typeof createBluetoothAdapter>)
      .mockReturnValueOnce(secondAdapter as unknown as ReturnType<typeof createBluetoothAdapter>);
    const onConnectionEnded = vi.fn();
    const connectionHandles: BleConnectionHandle[] = [];
    const onConnectSuccess = vi.fn((_serial: string | null, connection: BleConnectionHandle) => {
      connectionHandles.push(connection);
    });
    const { result } = renderHook(() =>
      useBoardBluetooth({
        boardName: 'kilter',
        layoutId: 1,
        sizeId: 1,
        setIds: '1,20',
        onConnectSuccess,
        onConnectionEnded,
      }),
    );

    await act(async () => {
      await result.current.connect();
      await result.current.connect();
    });
    expect(connectionHandles).toHaveLength(2);
    expect(connectionHandles[0]?.generation).not.toBe(connectionHandles[1]?.generation);
    expect(connectionHandles[0]?.configIdentity).toBe(connectionHandles[1]?.configIdentity);
    expect(connectionHandles[1]?.config).toEqual({
      boardName: 'kilter',
      layoutId: 1,
      sizeId: 1,
      setIds: '1,20',
    });
    expect(connectionHandles[0]?.setAnalyticsBoardId(41)).toBe(false);
    expect(connectionHandles[1]?.setAnalyticsBoardId(55)).toBe(true);
    await act(async () => {
      await result.current.disconnect();
    });

    expect(onConnectionEnded).toHaveBeenCalledWith(expect.objectContaining({ boardId: 55 }));
  });

  it('consumes a live generation silently on unmount', async () => {
    const fakeAdapter = makeFakeAdapter();
    vi.mocked(createBluetoothAdapter).mockReturnValue(
      fakeAdapter as unknown as ReturnType<typeof createBluetoothAdapter>,
    );
    const onConnectionEnded = vi.fn();
    const { result, unmount } = renderHook(() =>
      useBoardBluetooth({ boardName: 'kilter', layoutId: 1, sizeId: 1, onConnectionEnded }),
    );

    await act(async () => {
      await result.current.connect();
    });
    unmount();

    expect(fakeAdapter.disconnect).toHaveBeenCalledOnce();
    expect(onConnectionEnded).not.toHaveBeenCalled();
  });
});

// ── Native connection adoption (iOS) ───────────────────────────────────────

describe('useBoardBluetooth native connection adoption', () => {
  type ConnectedListener = (payload: { deviceId: string; deviceName?: string }) => void;
  let connectedListener: ConnectedListener | null = null;

  function makeAdoptableAdapter() {
    return {
      ...makeFakeAdapter(),
      adoptConnection: vi.fn(),
      configureBoard: vi.fn().mockResolvedValue(undefined),
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    resetReactNativePermissionHarness();
    connectedListener = null;
    vi.mocked(subscribeNativeBleConnected).mockImplementation((listener) => {
      connectedListener = listener;
      return { remove: vi.fn() };
    });
    vi.mocked(isNativeIosBleAdapter).mockReturnValue(true);
    vi.mocked(parseBoardTypeFromDeviceName).mockImplementation((name?: string) =>
      name?.toLowerCase().startsWith('kilter') ? 'kilter' : undefined,
    );
    vi.mocked(parseSerialNumber).mockImplementation((name?: string) => name?.match(/#([^@]+)/)?.[1]);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.mocked(subscribeNativeBleConnected).mockImplementation(() => null);
    vi.mocked(getNativeBleConnectedDevice).mockImplementation(async () => null);
    vi.mocked(isNativeIosBleAdapter).mockReturnValue(false);
    vi.mocked(parseBoardTypeFromDeviceName).mockReset();
    vi.mocked(parseSerialNumber).mockReset();
  });

  it('adopts a natively-connected board matching the active config', async () => {
    const adapter = makeAdoptableAdapter();
    vi.mocked(createBluetoothAdapter).mockReturnValue(adapter as unknown as ReturnType<typeof createBluetoothAdapter>);

    const { result } = renderHook(() => useBoardBluetooth({ boardName: 'kilter', layoutId: 1, sizeId: 1 }));

    await act(async () => {
      connectedListener?.({ deviceId: 'native-dev', deviceName: 'Kilter Board#9@3' });
    });

    expect(adapter.adoptConnection).toHaveBeenCalledWith('native-dev');
    expect(result.current.isConnected).toBe(true);
  });

  it('remembers an adopted MoonBoard by its device id (no serial)', async () => {
    const adapter = makeAdoptableAdapter();
    vi.mocked(createBluetoothAdapter).mockReturnValue(adapter as unknown as ReturnType<typeof createBluetoothAdapter>);

    const { result } = renderHook(() => useBoardBluetooth({ boardName: 'moonboard', layoutId: 1, sizeId: 1 }));

    await act(async () => {
      connectedListener?.({ deviceId: 'moon-native-dev', deviceName: 'MoonBoard A1' });
    });

    expect(adapter.adoptConnection).toHaveBeenCalledWith('moon-native-dev');
    expect(result.current.isConnected).toBe(true);
    // A MoonBoard has no serial, so an adopted native connection is remembered by
    // device id — so a later drop can reconnect to the same board on one tap.
    expect(mockLastConnectedBoardStore.setStoredLastConnectedBoard).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: 'moon-native-dev' }),
    );
    expect(result.current.reconnectDeviceIdForCurrentBoard).toBe('moon-native-dev');
  });

  it('reconfigures adopted native boards when role colour overrides change', async () => {
    const adapter = makeAdoptableAdapter();
    vi.mocked(createBluetoothAdapter).mockReturnValue(adapter as unknown as ReturnType<typeof createBluetoothAdapter>);

    const { rerender } = renderHook((props) => useBoardBluetooth(props), {
      initialProps: {
        boardName: 'kilter' as const,
        layoutId: 1,
        sizeId: 1,
        ledColorOverrides: { HAND: '#111111' },
      },
    });

    await act(async () => {
      connectedListener?.({ deviceId: 'native-dev', deviceName: 'Kilter Board#9@3' });
    });

    await waitFor(() => {
      expect(adapter.configureBoard).toHaveBeenCalledWith(
        expect.objectContaining({ colorOverrides: { HAND: '#111111' } }),
      );
    });

    rerender({
      boardName: 'kilter',
      layoutId: 1,
      sizeId: 1,
      ledColorOverrides: { HAND: '#222222' },
    });

    await waitFor(() => {
      expect(adapter.configureBoard).toHaveBeenCalledWith(
        expect.objectContaining({ colorOverrides: { HAND: '#222222' } }),
      );
    });
  });

  it('never arms adoption for Woods — no listener, no throwaway adapter, no configureBoard', async () => {
    // Woods always runs on the JS ble-plx adapter (acknowledged writes), so
    // there is never a native connection to adopt. The effect bails before it
    // subscribes, rather than building an adapter just to discover that.
    const adapter = makeAdoptableAdapter();
    vi.mocked(createBluetoothAdapter).mockReturnValue(adapter as unknown as ReturnType<typeof createBluetoothAdapter>);

    const { result } = renderHook(() => useBoardBluetooth({ boardName: 'woods', layoutId: 1, sizeId: 1 }));

    expect(subscribeNativeBleConnected).not.toHaveBeenCalled();
    expect(createBluetoothAdapter).not.toHaveBeenCalled();
    expect(adapter.adoptConnection).not.toHaveBeenCalled();
    expect(adapter.configureBoard).not.toHaveBeenCalled();
    expect(result.current.isConnected).toBe(false);
  });

  it('refuses to adopt a device it cannot positively identify as the active board type', async () => {
    const adapter = makeAdoptableAdapter();
    vi.mocked(createBluetoothAdapter).mockReturnValue(adapter as unknown as ReturnType<typeof createBluetoothAdapter>);

    const { result } = renderHook(() => useBoardBluetooth({ boardName: 'kilter', layoutId: 1, sizeId: 1 }));

    await act(async () => {
      // Unnamed device ('' from the bridge) — could be anything, e.g. a
      // MoonBoard that would receive Aurora-format packets.
      connectedListener?.({ deviceId: 'mystery-dev', deviceName: '' });
      // Recognisable, but the wrong family for the active config.
      connectedListener?.({ deviceId: 'moon-dev', deviceName: 'MoonBoard A1' });
    });

    expect(adapter.adoptConnection).not.toHaveBeenCalled();
    expect(result.current.isConnected).toBe(false);
  });

  it('clears stale adapters after native disconnects so later native connections can be adopted', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-01T00:00:00.000Z'));
    let firstDisconnectCallback: (() => void) | null = null;
    const firstAdapter = {
      ...makeAdoptableAdapter(),
      onDisconnect: vi.fn((callback: () => void) => {
        firstDisconnectCallback = callback;
        return vi.fn();
      }),
    };
    const secondAdapter = makeAdoptableAdapter();
    vi.mocked(createBluetoothAdapter)
      .mockReturnValueOnce(firstAdapter as unknown as ReturnType<typeof createBluetoothAdapter>)
      .mockReturnValueOnce(secondAdapter as unknown as ReturnType<typeof createBluetoothAdapter>);

    const onConnectionEnded = vi.fn();
    const onConnectSuccess = vi.fn((_serial: string | null, connection: BleConnectionHandle) => {
      connection.setAnalyticsBoardId(99);
    });
    const { result } = renderHook(() =>
      useBoardBluetooth({
        boardName: 'kilter',
        layoutId: 1,
        sizeId: 1,
        setIds: '1,20',
        analyticsInSession: true,
        onConnectSuccess,
        onConnectionEnded,
      }),
    );

    await act(async () => {
      connectedListener?.({ deviceId: 'native-dev-1', deviceName: 'Kilter Board#9@3' });
    });
    expect(result.current.isConnected).toBe(true);

    vi.setSystemTime(new Date('2026-08-01T00:00:09.600Z'));
    await act(async () => {
      firstDisconnectCallback?.();
    });
    expect(result.current.isConnected).toBe(false);
    expect(onConnectionEnded).toHaveBeenCalledWith({
      reason: 'unexpected',
      disconnectTrigger: 'link_drop',
      connectionDurationSec: 10,
      boardName: 'kilter',
      layoutId: 1,
      sizeId: 1,
      setIds: '1,20',
      boardId: 99,
      inSession: true,
    });

    await act(async () => {
      connectedListener?.({ deviceId: 'native-dev-2', deviceName: 'Kilter Board#9@3' });
    });

    expect(secondAdapter.adoptConnection).toHaveBeenCalledWith('native-dev-2');
    expect(result.current.isConnected).toBe(true);

    // A duplicate callback retained by the old native adapter cannot consume or
    // clear the newly adopted generation.
    await act(async () => {
      firstDisconnectCallback?.();
    });
    expect(result.current.isConnected).toBe(true);
    expect(onConnectionEnded).toHaveBeenCalledTimes(1);
  });

  it('adopts a nameless native reconnect when it matches the remembered current-board config', async () => {
    let firstDisconnectCallback: (() => void) | null = null;
    const firstAdapter = {
      ...makeAdoptableAdapter(),
      onDisconnect: vi.fn((callback: () => void) => {
        firstDisconnectCallback = callback;
        return vi.fn();
      }),
    };
    const secondAdapter = makeAdoptableAdapter();
    const onConnectSuccess = vi.fn();
    vi.mocked(createBluetoothAdapter)
      .mockReturnValueOnce(firstAdapter as unknown as ReturnType<typeof createBluetoothAdapter>)
      .mockReturnValueOnce(secondAdapter as unknown as ReturnType<typeof createBluetoothAdapter>);

    const { result } = renderHook(() =>
      useBoardBluetooth({ boardName: 'kilter', layoutId: 1, sizeId: 1, onConnectSuccess }),
    );

    await act(async () => {
      connectedListener?.({ deviceId: 'native-dev-1', deviceName: 'Kilter Board#9@3' });
    });
    await act(async () => {
      firstDisconnectCallback?.();
    });

    await act(async () => {
      connectedListener?.({ deviceId: 'native-dev-2', deviceName: '' });
    });

    expect(secondAdapter.adoptConnection).toHaveBeenCalledWith('native-dev-2');
    expect(result.current.isConnected).toBe(true);
    expect(onConnectSuccess).toHaveBeenLastCalledWith(
      '9',
      expect.objectContaining({
        generation: 2,
        config: { boardName: 'kilter', layoutId: 1, sizeId: 1, setIds: undefined },
        setAnalyticsBoardId: expect.any(Function),
      }),
    );
  });

  it('does not re-adopt after an explicit disconnect until the next deliberate connect', async () => {
    const adapter = makeAdoptableAdapter();
    vi.mocked(createBluetoothAdapter).mockReturnValue(adapter as unknown as ReturnType<typeof createBluetoothAdapter>);

    const { result } = renderHook(() => useBoardBluetooth({ boardName: 'kilter', layoutId: 1, sizeId: 1 }));

    await act(async () => {
      connectedListener?.({ deviceId: 'native-dev', deviceName: 'Kilter Board#9@3' });
    });
    expect(result.current.isConnected).toBe(true);

    await act(async () => {
      await result.current.disconnect();
    });
    expect(result.current.isConnected).toBe(false);

    // The native disconnect can still be in flight when the app foregrounds —
    // a late connected event (or getConnectedDevice poll) must not resurrect
    // the connection the user just closed.
    await act(async () => {
      connectedListener?.({ deviceId: 'native-dev', deviceName: 'Kilter Board#9@3' });
    });

    expect(adapter.adoptConnection).toHaveBeenCalledTimes(1);
    expect(result.current.isConnected).toBe(false);
  });
});

// ── Config-switch teardown ──────────────────────────────────────────────────

describe('useBoardBluetooth config-switch teardown', () => {
  type ConnectedListener = (payload: { deviceId: string; deviceName?: string }) => void;
  let connectedListener: ConnectedListener | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    resetReactNativePermissionHarness();
    mockBleManager.state.mockResolvedValue('PoweredOn');
    connectedListener = null;
    vi.mocked(subscribeNativeBleConnected).mockImplementation((listener) => {
      connectedListener = listener;
      return { remove: vi.fn() };
    });
    vi.mocked(isNativeIosBleAdapter).mockReturnValue(true);
    vi.mocked(parseBoardTypeFromDeviceName).mockImplementation((name?: string) =>
      name?.toLowerCase().startsWith('kilter') ? 'kilter' : undefined,
    );
    vi.mocked(parseSerialNumber).mockImplementation((name?: string) => name?.match(/#([^@]+)/)?.[1]);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.mocked(subscribeNativeBleConnected).mockImplementation(() => null);
    vi.mocked(getNativeBleConnectedDevice).mockImplementation(async () => null);
    vi.mocked(isNativeIosBleAdapter).mockReturnValue(false);
    vi.mocked(parseBoardTypeFromDeviceName).mockReset();
    vi.mocked(parseSerialNumber).mockReset();
  });

  it('tears down the live connection when the board config switches', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-01T00:00:00.000Z'));
    const fakeAdapter = makeFakeAdapter();
    vi.mocked(createBluetoothAdapter).mockReturnValue(
      fakeAdapter as unknown as ReturnType<typeof createBluetoothAdapter>,
    );

    const onConnectionEnded = vi.fn();
    const onConnectSuccess = vi.fn((_serial: string | null, connection: BleConnectionHandle) => {
      connection.setAnalyticsBoardId(41);
    });
    const { result, rerender } = renderHook((props) => useBoardBluetooth(props), {
      initialProps: {
        boardName: 'kilter',
        layoutId: 1,
        sizeId: 1,
        setIds: '1,20',
        analyticsInSession: true,
        onConnectSuccess,
        onConnectionEnded,
      },
    });

    await act(async () => {
      await result.current.connect();
    });
    expect(result.current.isConnected).toBe(true);

    vi.setSystemTime(new Date('2026-08-01T00:00:04.600Z'));
    await act(async () => {
      rerender({
        boardName: 'tension',
        layoutId: 2,
        sizeId: 1,
        setIds: '9',
        analyticsInSession: false,
        onConnectSuccess,
        onConnectionEnded,
      });
    });

    expect(fakeAdapter.disconnect).toHaveBeenCalled();
    expect(result.current.isConnected).toBe(false);
    expect(onConnectionEnded).toHaveBeenCalledOnce();
    expect(onConnectionEnded).toHaveBeenCalledWith({
      reason: 'user',
      disconnectTrigger: 'config_switch',
      connectionDurationSec: 5,
      boardName: 'kilter',
      layoutId: 1,
      sizeId: 1,
      setIds: '1,20',
      boardId: 41,
      inSession: true,
    });
  });

  it('treats a set-ids-only change as a config switch and preserves the old set attribution', async () => {
    const fakeAdapter = makeFakeAdapter();
    vi.mocked(createBluetoothAdapter).mockReturnValue(
      fakeAdapter as unknown as ReturnType<typeof createBluetoothAdapter>,
    );
    const onConnectionEnded = vi.fn();
    const onConnectSuccess = vi.fn((_serial: string | null, connection: BleConnectionHandle) => {
      connection.setAnalyticsBoardId(41);
    });
    const { result, rerender } = renderHook((props) => useBoardBluetooth(props), {
      initialProps: {
        boardName: 'kilter',
        layoutId: 1,
        sizeId: 1,
        setIds: '1,20',
        onConnectSuccess,
        onConnectionEnded,
      },
    });

    await act(async () => {
      await result.current.connect();
    });
    await act(async () => {
      rerender({
        boardName: 'kilter',
        layoutId: 1,
        sizeId: 1,
        setIds: '9',
        onConnectSuccess,
        onConnectionEnded,
      });
    });

    expect(result.current.isConnected).toBe(false);
    expect(onConnectionEnded).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'user',
        disconnectTrigger: 'config_switch',
        setIds: '1,20',
        boardId: 41,
      }),
    );
  });

  it('restores the silent reconnect serial when the config switches back', async () => {
    const fakeAdapter = makeFakeAdapter();
    vi.mocked(createBluetoothAdapter).mockReturnValue(
      fakeAdapter as unknown as ReturnType<typeof createBluetoothAdapter>,
    );

    const { result, rerender } = renderHook((props) => useBoardBluetooth(props), {
      initialProps: { boardName: 'kilter', layoutId: 1, sizeId: 1 },
    });

    await act(async () => {
      await result.current.connect();
    });
    // Default device name 'Kilter Board#123@3' parses to serial '123'.
    expect(result.current.reconnectSerialForCurrentBoard).toBe('123');

    await act(async () => {
      rerender({ boardName: 'kilter', layoutId: 2, sizeId: 1 });
    });
    // While on the other config the remembered board can't be silently reconnected.
    expect(result.current.reconnectSerialForCurrentBoard).toBeNull();

    await act(async () => {
      rerender({ boardName: 'kilter', layoutId: 1, sizeId: 1 });
    });
    // Switching back offers the silent reconnect again — lastConnectedBoard was
    // preserved through the config-switch teardown.
    expect(result.current.reconnectSerialForCurrentBoard).toBe('123');
  });

  it('does not tear down when an unrelated re-render keeps the config identical', async () => {
    const fakeAdapter = makeFakeAdapter();
    vi.mocked(createBluetoothAdapter).mockReturnValue(
      fakeAdapter as unknown as ReturnType<typeof createBluetoothAdapter>,
    );

    const { result, rerender } = renderHook((props) => useBoardBluetooth(props), {
      initialProps: { boardName: 'kilter', layoutId: 1, sizeId: 1 },
    });

    await act(async () => {
      await result.current.connect();
    });

    await act(async () => {
      rerender({ boardName: 'kilter', layoutId: 1, sizeId: 1 });
    });

    expect(fakeAdapter.disconnect).not.toHaveBeenCalled();
    expect(result.current.isConnected).toBe(true);
  });

  it('suppresses adoption after a config-switch teardown until the next deliberate connect', async () => {
    const firstAdapter = makeFakeAdapter();
    const adoptableSecond = {
      ...makeFakeAdapter(),
      adoptConnection: vi.fn(),
      configureBoard: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(createBluetoothAdapter)
      .mockReturnValueOnce(firstAdapter as unknown as ReturnType<typeof createBluetoothAdapter>)
      .mockReturnValue(adoptableSecond as unknown as ReturnType<typeof createBluetoothAdapter>);

    const { result, rerender } = renderHook((props) => useBoardBluetooth(props), {
      initialProps: { boardName: 'kilter', layoutId: 1, sizeId: 1 },
    });

    await act(async () => {
      await result.current.connect();
    });
    expect(result.current.isConnected).toBe(true);

    // Config switch tears down and suppresses adoption.
    await act(async () => {
      rerender({ boardName: 'kilter', layoutId: 2, sizeId: 1 });
    });
    expect(result.current.isConnected).toBe(false);

    // A late native connected event for the old wall must not resurrect it.
    await act(async () => {
      connectedListener?.({ deviceId: 'native-dev', deviceName: 'Kilter Board#9@3' });
    });
    expect(adoptableSecond.adoptConnection).not.toHaveBeenCalled();
    expect(result.current.isConnected).toBe(false);

    // A deliberate connect on the new config re-arms adoption and connects.
    await act(async () => {
      await result.current.connect();
    });
    expect(result.current.isConnected).toBe(true);
  });

  it('defers config-switch teardown until after an in-flight connect completes', async () => {
    // Race: config changes WHILE connect is awaiting requestAndConnect.
    // adapterRef and connectedConfigIdentityRef are both null at that point, so the
    // config-switch effect must return early. Once the connect resolves and
    // isConnected flips to true the effect re-runs, finds the mismatch, and
    // calls teardown.
    let resolveConnect!: (connection: { deviceId: string; deviceName?: string }) => void;
    const fakeAdapter = makeFakeAdapter({
      requestAndConnect: vi.fn(
        () =>
          new Promise<{ deviceId: string; deviceName?: string }>((resolve) => {
            resolveConnect = resolve;
          }),
      ),
    });
    vi.mocked(createBluetoothAdapter).mockReturnValue(
      fakeAdapter as unknown as ReturnType<typeof createBluetoothAdapter>,
    );

    const { result, rerender } = renderHook((props) => useBoardBluetooth(props), {
      initialProps: { boardName: 'kilter', layoutId: 1, sizeId: 1 },
    });

    // Start connect but do not let it complete — requestAndConnect is pending.
    let connectPromise!: Promise<boolean>;
    await act(async () => {
      connectPromise = result.current.connect();
      // Advance past the synchronous pre-connect awaits (permissions,
      // isAvailable) so the request is truly in-flight.
      await Promise.resolve();
      await Promise.resolve();
    });

    // Config switches while connect is blocked on requestAndConnect.
    // adapterRef.current is still null so the config-switch effect exits early.
    await act(async () => {
      rerender({ boardName: 'kilter', layoutId: 2, sizeId: 1 });
    });
    expect(fakeAdapter.disconnect).not.toHaveBeenCalled();
    expect(result.current.isConnected).toBe(false);

    // Connect resolves against the OLD config (kilter/1/1). isConnected briefly
    // flips to true, which re-triggers the config-switch effect; it sees the
    // mismatch and calls teardown.
    await act(async () => {
      resolveConnect({ deviceId: 'device-1', deviceName: 'Kilter Board#123@3' });
      await connectPromise;
    });
    expect(fakeAdapter.disconnect).toHaveBeenCalled();
    expect(result.current.isConnected).toBe(false);
  });
});

describe('useBoardBluetooth remembered-board persistence (#3609)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetReactNativePermissionHarness();
    mockBleManager.state.mockResolvedValue('PoweredOn');
    // Default device name 'Kilter Board#123@3' parses to serial '123'.
    vi.mocked(parseSerialNumber).mockImplementation((name?: string) => name?.match(/#([^@]+)/)?.[1]);
    // Reset the store spies (including any leftover once-implementations) to a
    // clean "nothing stored" default so each test starts from the same baseline.
    mockLastConnectedBoardStore.getStoredLastConnectedBoard.mockReset();
    mockLastConnectedBoardStore.getStoredLastConnectedBoard.mockResolvedValue(null);
    mockLastConnectedBoardStore.setStoredLastConnectedBoard.mockReset();
    mockLastConnectedBoardStore.setStoredLastConnectedBoard.mockResolvedValue(undefined);
    mockLastConnectedBoardStore.clearStoredLastConnectedBoard.mockReset();
    mockLastConnectedBoardStore.clearStoredLastConnectedBoard.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.mocked(parseSerialNumber).mockReset();
  });

  it('persists the board on a successful connect', async () => {
    const fakeAdapter = makeFakeAdapter();
    vi.mocked(createBluetoothAdapter).mockReturnValue(
      fakeAdapter as unknown as ReturnType<typeof createBluetoothAdapter>,
    );

    const { result } = renderHook(() => useBoardBluetooth({ boardName: 'kilter', layoutId: 1, sizeId: 1 }));

    await act(async () => {
      await result.current.connect();
    });

    expect(result.current.reconnectSerialForCurrentBoard).toBe('123');
    expect(mockLastConnectedBoardStore.setStoredLastConnectedBoard).toHaveBeenCalledWith({
      serial: '123',
      configKey: 'kilter::1::1',
    });
  });

  it('clears the persisted board on a deliberate disconnect', async () => {
    const fakeAdapter = makeFakeAdapter();
    vi.mocked(createBluetoothAdapter).mockReturnValue(
      fakeAdapter as unknown as ReturnType<typeof createBluetoothAdapter>,
    );

    const { result } = renderHook(() => useBoardBluetooth({ boardName: 'kilter', layoutId: 1, sizeId: 1 }));

    await act(async () => {
      await result.current.connect();
    });
    expect(result.current.reconnectSerialForCurrentBoard).toBe('123');

    await act(async () => {
      await result.current.disconnect();
    });

    expect(mockLastConnectedBoardStore.clearStoredLastConnectedBoard).toHaveBeenCalled();
    expect(result.current.reconnectSerialForCurrentBoard).toBeNull();
  });

  it('rehydrates a stored board on mount, guarded by the active config', async () => {
    // A board remembered for kilter/2/1 in a previous session (cold start).
    mockLastConnectedBoardStore.getStoredLastConnectedBoard.mockResolvedValueOnce({
      serial: '999',
      configKey: 'kilter::2::1',
    });
    const fakeAdapter = makeFakeAdapter();
    vi.mocked(createBluetoothAdapter).mockReturnValue(
      fakeAdapter as unknown as ReturnType<typeof createBluetoothAdapter>,
    );

    const { result, rerender } = renderHook((props) => useBoardBluetooth(props), {
      initialProps: { boardName: 'kilter', layoutId: 1, sizeId: 1 },
    });

    // While looking at a different config the stored board is never offered.
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.reconnectSerialForCurrentBoard).toBeNull();

    // Switching to the stored board's config offers the silent reconnect —
    // hydrated from storage, no connect needed.
    await act(async () => {
      rerender({ boardName: 'kilter', layoutId: 2, sizeId: 1 });
    });
    await waitFor(() => expect(result.current.reconnectSerialForCurrentBoard).toBe('999'));
  });
});

// connect() writes initialFrames before declaring success. That write can take
// the link with it. These tests pin the boundary: a lost link fails the connect,
// while a write the board merely refused does not.
//
// Which side of that boundary a test lands on is decided by the rejection
// message, via isDisconnectionError (@boardsesh/ble-protocol/connection-error):
// 'Not connected' matches its "definite drop" pattern and tears the connection
// down; 'GATT write failed' does not and leaves the link alive. Deliberately not
// re-derived in the test bodies — asserting against a locally rebuilt predicate
// is the tautology this repo has already shipped once. If a change to
// isDisconnectionError ever collapsed those two messages to the same verdict,
// the pair below would start agreeing and this comment is the breadcrumb.
describe('useBoardBluetooth connect() initial frame write (#3875)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetReactNativePermissionHarness();
    mockBleManager.state.mockResolvedValue('PoweredOn');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function mockAuroraSendable() {
    mockGetLedPlacements.mockReturnValue({ 100: 7, 999: 8 });
    mockGetAuroraBluetoothPacket.mockReturnValue({
      packet: new Uint8Array([0x01]),
      skippedPositionCount: 0,
      skippedRoleCount: 0,
      totalPlacements: 1,
    });
  }

  it('fails the connect when the initial write kills the link (#3875)', async () => {
    // The write rejects with a disconnection signature, so sendFramesToBoard tears
    // the connection down. connect() used to sail past that and light the
    // lightbulb over a null adapter: every later send then early-returned with
    // skipReason 'no_adapter' and the wall stayed dark until the climber toggled
    // the connection off and back on.
    const fakeAdapter = makeFakeAdapter({
      write: vi.fn().mockRejectedValue(new Error('Not connected')),
    });
    vi.mocked(createBluetoothAdapter).mockReturnValue(
      fakeAdapter as unknown as ReturnType<typeof createBluetoothAdapter>,
    );
    mockAuroraSendable();
    const onConnectSuccess = vi.fn();

    const { result } = renderHook(() =>
      useBoardBluetooth({ boardName: 'kilter', layoutId: 1, sizeId: 1, onConnectSuccess }),
    );

    let connected: boolean | undefined;
    await act(async () => {
      connected = await result.current.connect('p100r12');
    });

    expect(connected).toBe(false);
    expect(result.current.isConnected).toBe(false);
    expect(onConnectSuccess).not.toHaveBeenCalled();
    expect(mockTrack.mock.calls.find(([name]) => name === 'Bluetooth Connection Success')).toBeUndefined();
    const failure = mockTrack.mock.calls.find(([name]) => name === 'Bluetooth Connection Failed');
    expect(failure?.[1]).toMatchObject({ boardName: 'kilter', failureReason: 'dropped_after_connect' });
    expect(Alert.alert).toHaveBeenCalledWith('ble.connectionFailedTitle', 'bluetooth.connectFailed');
    expect(fakeAdapter.disconnect).toHaveBeenCalled();
  });

  it('fails the connect when a drop event lands during the initial write (#3875)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-01T00:00:00.000Z'));
    // The write itself RESOLVES — the adapter's own disconnect event fires while
    // it is in flight. sendFramesToBoard therefore returns true, so the return
    // value cannot see this at all; only the adapter identity can. If this test
    // is the only failing one, someone replaced the identity check with a check
    // on sendFramesToBoard's boolean.
    let dropLink: (() => void) | undefined;
    const fakeAdapter = {
      ...makeFakeAdapter(),
      onDisconnect: vi.fn((handler: (info?: { source: string }) => void) => {
        dropLink = () => handler({ source: 'adapter-event' });
        return () => {};
      }),
      write: vi.fn(async () => {
        vi.setSystemTime(new Date('2026-08-01T00:00:02.600Z'));
        dropLink?.();
      }),
    };
    vi.mocked(createBluetoothAdapter).mockReturnValue(
      fakeAdapter as unknown as ReturnType<typeof createBluetoothAdapter>,
    );
    mockAuroraSendable();

    const onConnectionEnded = vi.fn();
    const { result } = renderHook(() =>
      useBoardBluetooth({
        boardName: 'kilter',
        layoutId: 1,
        sizeId: 1,
        setIds: '1,20',
        analyticsBoardId: 99,
        analyticsInSession: true,
        onConnectionEnded,
      }),
    );

    let connected: boolean | undefined;
    await act(async () => {
      connected = await result.current.connect('p100r12');
    });

    expect(connected).toBe(false);
    expect(result.current.isConnected).toBe(false);
    expect(mockTrack.mock.calls.find(([name]) => name === 'Bluetooth Connection Success')).toBeUndefined();
    // Asserted here too, not just in the test above: this is the arm the boolean
    // return value cannot reach, so it needs its own proof that the climber is
    // told and the failure is recorded.
    expect(Alert.alert).toHaveBeenCalledWith('ble.connectionFailedTitle', 'bluetooth.connectFailed');
    const failure = mockTrack.mock.calls.find(([name]) => name === 'Bluetooth Connection Failed');
    expect(failure?.[1]).toMatchObject({ failureReason: 'dropped_after_connect' });
    // clearConnectionAfterDrop disposes the adapter on BOTH of its callers, not
    // just the write-failure one — the adapter self-cleans after firing its own
    // event, but the explicit disconnect is what stops a half-alive native link
    // and the onDeviceDisconnected subscription leaking.
    expect(fakeAdapter.disconnect).toHaveBeenCalled();
    expect(onConnectionEnded).toHaveBeenCalledOnce();
    expect(onConnectionEnded).toHaveBeenCalledWith({
      reason: 'unexpected',
      disconnectTrigger: 'link_drop',
      connectionDurationSec: 3,
      boardName: 'kilter',
      layoutId: 1,
      sizeId: 1,
      setIds: '1,20',
      inSession: true,
      disconnectInfo: { source: 'adapter-event' },
    });

    // The adapter may deliver the same native drop again after explicit cleanup;
    // the generation has already been consumed.
    await act(async () => {
      dropLink?.();
    });
    expect(onConnectionEnded).toHaveBeenCalledTimes(1);
  });

  it('still connects when the initial climb is incompatible with the board (#3875)', async () => {
    // Every placement skipped → sendFramesToBoard returns false, but the GATT
    // link is untouched. Failing the connect here (the fix the issue asked for)
    // would strand a live adapter behind a dark lightbulb and raise a bogus
    // "couldn't connect" on a board that is connected.
    const fakeAdapter = makeFakeAdapter();
    vi.mocked(createBluetoothAdapter).mockReturnValue(
      fakeAdapter as unknown as ReturnType<typeof createBluetoothAdapter>,
    );
    mockGetLedPlacements.mockReturnValue({ 100: 7 });
    mockGetAuroraBluetoothPacket.mockReturnValue({
      packet: new Uint8Array([]),
      skippedPositionCount: 3,
      skippedRoleCount: 1,
      totalPlacements: 4,
    });

    const { result } = renderHook(() => useBoardBluetooth({ boardName: 'kilter', layoutId: 1, sizeId: 1 }));

    let connected: boolean | undefined;
    await act(async () => {
      connected = await result.current.connect('p100r12');
    });

    expect(connected).toBe(true);
    expect(result.current.isConnected).toBe(true);
    expect(mockTrack.mock.calls.find(([name]) => name === 'Bluetooth Connection Success')).toBeDefined();
  });

  it('still connects when the initial write fails on a live link (#3875)', async () => {
    // The far more common flavour: an ordinary write rejection (write_failed /
    // write_timeout / characteristic_unavailable) that isDisconnectionError does
    // not match. The link is alive, so the connect stands.
    const fakeAdapter = makeFakeAdapter({
      write: vi.fn().mockRejectedValue(new Error('GATT write failed')),
    });
    vi.mocked(createBluetoothAdapter).mockReturnValue(
      fakeAdapter as unknown as ReturnType<typeof createBluetoothAdapter>,
    );
    mockAuroraSendable();

    const { result } = renderHook(() => useBoardBluetooth({ boardName: 'kilter', layoutId: 1, sizeId: 1 }));

    let connected: boolean | undefined;
    await act(async () => {
      connected = await result.current.connect('p100r12');
    });

    expect(connected).toBe(true);
    expect(result.current.isConnected).toBe(true);
    expect(mockTrack.mock.calls.find(([name]) => name === 'Bluetooth Connection Success')).toBeDefined();
  });

  it('attributes the initial write to sendSource "connect" (#3875)', async () => {
    // Makes the connect-time send separable in PostHog. Before this, telling a
    // connect-time failure from a mid-session one meant joining on a
    // sub-10ms gap against Bluetooth Connection Success.
    const fakeAdapter = makeFakeAdapter({
      write: vi.fn().mockRejectedValue(new Error('GATT write failed')),
    });
    vi.mocked(createBluetoothAdapter).mockReturnValue(
      fakeAdapter as unknown as ReturnType<typeof createBluetoothAdapter>,
    );
    mockAuroraSendable();

    const { result } = renderHook(() => useBoardBluetooth({ boardName: 'kilter', layoutId: 1, sizeId: 1 }));

    await act(async () => {
      await result.current.connect('p100r12');
    });

    const sendFailure = mockTrack.mock.calls.find(([name]) => name === 'Climb Sent to Board Failure');
    expect(sendFailure?.[1]).toMatchObject({ sendSource: 'connect' });
  });

  it('leaves the AutoSender dedup unseeded when the initial write failed (#3875)', async () => {
    // The seed tells the AutoSender "these frames are already on the wall".
    // Seeding it after a write that never landed made the AutoSender skip the
    // write (connected board, dark wall) and fire onWallConfirmed anyway, so the
    // party feed reported a climb as lit on a dark wall. The link is alive here,
    // so the connect itself must still succeed.
    const fakeAdapter = makeFakeAdapter({
      write: vi.fn().mockRejectedValue(new Error('GATT write failed')),
    });
    vi.mocked(createBluetoothAdapter).mockReturnValue(
      fakeAdapter as unknown as ReturnType<typeof createBluetoothAdapter>,
    );
    mockAuroraSendable();

    const { result } = renderHook(() => useBoardBluetooth({ boardName: 'kilter', layoutId: 1, sizeId: 1 }));

    await act(async () => {
      await result.current.connect('p100r12');
    });

    expect(result.current.isConnected).toBe(true);
    expect(result.current.connectInitialSendRef.current).toBeNull();
  });

  it('seeds the AutoSender dedup when the initial write landed (#3875)', async () => {
    // The mutation guard for the test above: clearing the seed unconditionally
    // would pass it while reintroducing the doubled connect haptic and the
    // redundant full-frame re-write the seed exists to prevent.
    const fakeAdapter = makeFakeAdapter();
    vi.mocked(createBluetoothAdapter).mockReturnValue(
      fakeAdapter as unknown as ReturnType<typeof createBluetoothAdapter>,
    );
    mockAuroraSendable();

    const { result } = renderHook(() => useBoardBluetooth({ boardName: 'kilter', layoutId: 1, sizeId: 1 }));

    await act(async () => {
      await result.current.connect('p100r12');
    });

    expect(result.current.connectInitialSendRef.current).toEqual({
      frames: 'p100r12',
      mirrored: false,
      colorSignature: expect.any(String),
      encodingSignature: 'default',
    });
  });

  it('clears a stale dedup seed when connecting without initial frames (#3875)', async () => {
    const fakeAdapter = makeFakeAdapter();
    vi.mocked(createBluetoothAdapter).mockReturnValue(
      fakeAdapter as unknown as ReturnType<typeof createBluetoothAdapter>,
    );
    mockAuroraSendable();

    const { result } = renderHook(() => useBoardBluetooth({ boardName: 'kilter', layoutId: 1, sizeId: 1 }));

    await act(async () => {
      await result.current.connect('p100r12');
    });
    expect(result.current.connectInitialSendRef.current).not.toBeNull();

    await act(async () => {
      await result.current.connect();
    });
    expect(result.current.connectInitialSendRef.current).toBeNull();
  });

  it('fails the connect when the board config switches during the initial write (#3875)', async () => {
    // The guard for commit 1 (connectedConfigIdentityRef assigned when the link opens
    // rather than after the initial send). That move is what makes this path
    // reachable at all: the config-switch effect early-returns while the ref is
    // null, so before it, a board switch landing inside the awaited write left
    // the stale connection up. Now the effect tears it down and the identity
    // bail below stops connect() lighting the lightbulb over a dead adapter.
    //
    // The alert asserted here is deliberately the generic "move closer" copy,
    // which does NOT describe what happened — the climber navigated away, the
    // link did not drop. That wart is accepted (see the comment beside the bail);
    // this assertion pins it so a future distinct bail reason updates the test on
    // purpose instead of silently changing what the climber is told.
    let releaseWrite: (() => void) | undefined;
    let writeReached: (() => void) | undefined;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const writeStarted = new Promise<void>((resolve) => {
      writeReached = resolve;
    });
    const fakeAdapter = makeFakeAdapter({
      write: vi.fn(async () => {
        writeReached?.();
        await writeGate;
      }),
    });
    vi.mocked(createBluetoothAdapter).mockReturnValue(
      fakeAdapter as unknown as ReturnType<typeof createBluetoothAdapter>,
    );
    mockAuroraSendable();

    const { result, rerender } = renderHook((props) => useBoardBluetooth(props), {
      initialProps: { boardName: 'kilter', layoutId: 1, sizeId: 1 },
    });

    // Park connect() on the initial write. Only then is adapterRef (and, thanks
    // to commit 1, connectedConfigIdentityRef) set, which is what stops the
    // config-switch effect early-returning and makes this test non-vacuous.
    let pending: Promise<boolean> | undefined;
    await act(async () => {
      pending = result.current.connect('p100r12');
      await writeStarted;
    });

    // The switch needs its own act: effects queued by rerender only flush when
    // the act scope exits, so doing this inside the block above would release the
    // write before the teardown had run.
    await act(async () => {
      rerender({ boardName: 'kilter', layoutId: 2, sizeId: 1 });
    });
    expect(fakeAdapter.disconnect).toHaveBeenCalled();

    let connected: boolean | undefined;
    await act(async () => {
      releaseWrite?.();
      connected = await pending;
    });

    expect(connected).toBe(false);
    expect(result.current.isConnected).toBe(false);
    expect(mockTrack.mock.calls.find(([name]) => name === 'Bluetooth Connection Success')).toBeUndefined();
    expect(Alert.alert).toHaveBeenCalledWith('ble.connectionFailedTitle', 'bluetooth.connectFailed');
    const failure = mockTrack.mock.calls.find(([name]) => name === 'Bluetooth Connection Failed');
    expect(failure?.[1]).toMatchObject({ failureReason: 'dropped_after_connect' });
    // The switched-away connection must not leave a seed behind for the new
    // board's AutoSender to inherit.
    expect(result.current.connectInitialSendRef.current).toBeNull();
  });
});

describe('convertToMirroredFramesString', () => {
  it('correctly maps hold IDs to mirrored IDs', () => {
    const holdsData: HoldPlacement[] = [makePlacement(100, 200), makePlacement(101, 201)];

    const frames = 'p100r12p101r14';
    const result = convertToMirroredFramesString(frames, holdsData);

    expect(result).toBe('p200r12p201r14');
  });

  it('handles a single hold', () => {
    const holdsData: HoldPlacement[] = [makePlacement(42, 84)];

    const frames = 'p42r5';
    const result = convertToMirroredFramesString(frames, holdsData);

    expect(result).toBe('p84r5');
  });

  it('handles multiple holds with different state codes', () => {
    const holdsData: HoldPlacement[] = [makePlacement(1, 10), makePlacement(2, 20), makePlacement(3, 30)];

    const frames = 'p1r1p2r2p3r3';
    const result = convertToMirroredFramesString(frames, holdsData);

    expect(result).toBe('p10r1p20r2p30r3');
  });

  it('handles empty frames string', () => {
    const holdsData: HoldPlacement[] = [makePlacement(1, 10)];

    const frames = '';
    const result = convertToMirroredFramesString(frames, holdsData);

    expect(result).toBe('');
  });

  it('throws when mirroredHoldId is undefined for a hold', () => {
    // Hold 42 has no mirrored ID (null)
    const holdsData: HoldPlacement[] = [makePlacement(42, null)];

    const frames = 'p42r5';

    expect(() => convertToMirroredFramesString(frames, holdsData)).toThrow(
      'Mirrored hold ID is not defined for hold ID 42.',
    );
  });

  it('throws when hold ID is not present in holdsData at all', () => {
    // holdsData is empty — no mapping exists for hold 99
    const holdsData: HoldPlacement[] = [];

    const frames = 'p99r7';

    expect(() => convertToMirroredFramesString(frames, holdsData)).toThrow(
      'Mirrored hold ID is not defined for hold ID 99.',
    );
  });

  it('preserves state codes exactly', () => {
    const holdsData: HoldPlacement[] = [makePlacement(500, 600)];

    const frames = 'p500r255';
    const result = convertToMirroredFramesString(frames, holdsData);

    expect(result).toBe('p600r255');
  });

  it('uses only holds with mirroredHoldId set in the map', () => {
    // Two holds: one with mirror, one without. Only the one with mirror is in frames.
    const holdsData: HoldPlacement[] = [
      makePlacement(10, 20),
      makePlacement(30, null), // no mirror
    ];

    // Only hold 10 is in frames, which has a valid mirror
    const frames = 'p10r1';
    const result = convertToMirroredFramesString(frames, holdsData);

    expect(result).toBe('p20r1');
  });
});

// ── dispatchMoonboardPacket ─────────────────────────────────────────────────

describe('dispatchMoonboardPacket', () => {
  beforeEach(() => {
    mockGetMoonboardBluetoothPacket.mockReset();
  });

  it('calls write() with the packet bytes, not the full packet object', async () => {
    const fakePacket = new Uint8Array([0x01, 0x02, 0x03]);
    mockGetMoonboardBluetoothPacket.mockReturnValue({
      packet: fakePacket,
      totalPlacements: 2,
      skippedRoleCount: 0,
      skippedPositionCount: 0,
      isClear: false,
    });
    const write = vi.fn().mockResolvedValue(undefined);

    await dispatchMoonboardPacket('p1r12p2r14', write);

    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(fakePacket, undefined);
    // Confirm the full object was NOT passed (catches the `.packet` omission regression)
    expect(write).not.toHaveBeenCalledWith({ packet: fakePacket }, undefined);
  });

  it('returns true on success', async () => {
    mockGetMoonboardBluetoothPacket.mockReturnValue({
      packet: new Uint8Array([0x00]),
      totalPlacements: 1,
      skippedRoleCount: 0,
      skippedPositionCount: 0,
      isClear: false,
    });
    const write = vi.fn().mockResolvedValue(undefined);

    const result = await dispatchMoonboardPacket('p1r12', write);

    expect(result).toBe(true);
  });

  it('writes the deliberate clear-all `l##` packet and returns true for empty frames (#3420)', async () => {
    // getMoonboardBluetoothPacket('') returns the clear-all packet with
    // totalPlacements 0, so the all-skipped guard never trips and the clear is
    // written — MoonBoard's deliberate clear path (web parity).
    const clearPacket = new TextEncoder().encode('l##');
    mockGetMoonboardBluetoothPacket.mockReturnValue({
      packet: clearPacket,
      totalPlacements: 0,
      skippedRoleCount: 0,
      skippedPositionCount: 0,
      isClear: true,
    });
    const write = vi.fn().mockResolvedValue(undefined);

    const result = await dispatchMoonboardPacket('', write);

    expect(result).toBe(true);
    expect(write).toHaveBeenCalledWith(clearPacket, undefined);
  });

  it('forwards the AbortSignal to write()', async () => {
    const fakePacket = new Uint8Array([0xaa]);
    mockGetMoonboardBluetoothPacket.mockReturnValue({
      packet: fakePacket,
      totalPlacements: 1,
      skippedRoleCount: 0,
      skippedPositionCount: 0,
      isClear: false,
    });
    const write = vi.fn().mockResolvedValue(undefined);
    const controller = new AbortController();

    await dispatchMoonboardPacket('p5r3', write, controller.signal);

    expect(write).toHaveBeenCalledWith(fakePacket, controller.signal);
  });

  it('returns false and never writes when every placement is skipped (board would go dark)', async () => {
    // getMoonboardBluetoothPacket emits the "clear all" packet `l##` with
    // skippedRoleCount === totalPlacements when no hold maps to a known role.
    // Writing that would silently dark the board while reporting success.
    mockGetMoonboardBluetoothPacket.mockReturnValue({
      packet: new TextEncoder().encode('l##'),
      totalPlacements: 2,
      skippedRoleCount: 2,
      skippedPositionCount: 0,
      isClear: false,
    });
    const write = vi.fn().mockResolvedValue(undefined);

    const result = await dispatchMoonboardPacket('p1r99p2r98', write);

    expect(result).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it('returns false and never writes for a degenerate non-empty frames string (#3420)', async () => {
    // A corrupt frames string like 'p' parses to zero placements, so the
    // builder emits `l##` with isClear false — writing it would dark the wall
    // on a climb send, so the zero-encodable guard must refuse.
    mockGetMoonboardBluetoothPacket.mockReturnValue({
      packet: new TextEncoder().encode('l##'),
      totalPlacements: 0,
      skippedRoleCount: 0,
      skippedPositionCount: 0,
      isClear: false,
    });
    const write = vi.fn().mockResolvedValue(undefined);

    const result = await dispatchMoonboardPacket('p', write);

    expect(result).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it('writes and returns true when only some placements are skipped', async () => {
    const fakePacket = new TextEncoder().encode('l#S0#');
    mockGetMoonboardBluetoothPacket.mockReturnValue({
      packet: fakePacket,
      totalPlacements: 2,
      skippedRoleCount: 1,
      skippedPositionCount: 0,
      isClear: false,
    });
    const write = vi.fn().mockResolvedValue(undefined);

    const result = await dispatchMoonboardPacket('p1r42p2r99', write);

    expect(result).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
  });
});

// ── dispatchWoodsPacket ─────────────────────────────────────────────────────

describe('dispatchWoodsPacket', () => {
  // Woods size ids: 1 = 8x10, 2 = 12x12 (WOODS_SIZES).
  const TWELVE_BY_TWELVE_SIZE_ID = 2;
  const ledMap = WOODS_LED_MAPS['12x12'];
  const [litPlacement, litLedIndex] = Object.entries(ledMap)[0];
  // A placement id far past the top of the table has no LED on either size, so
  // the encoder skips it as a position miss.
  const unlitPlacement = 99999;

  const decode = (packet: Uint8Array) => new TextDecoder().decode(packet);

  it('encodes the lit holds and writes the ASCII command bytes', async () => {
    const write = makeWriteSpy();

    const result = await dispatchWoodsPacket(`p${litPlacement}r2`, TWELVE_BY_TWELVE_SIZE_ID, write);

    expect(result).toEqual({
      kind: 'sent',
      size: '12x12',
      skippedRoleCount: 0,
      skippedPositionCount: 0,
      totalPlacements: 1,
    });
    expect(write).toHaveBeenCalledTimes(1);
    expect(decode(write.mock.calls[0][0])).toBe(`${litLedIndex},2,!`);
  });

  it('writes the bare `,!` clear command and reports it as a clear for empty frames', async () => {
    const write = makeWriteSpy();

    const result = await dispatchWoodsPacket('', TWELVE_BY_TWELVE_SIZE_ID, write);

    // 'cleared' is what tells the hook this was a deliberate wall-clear rather
    // than a climb send, so only a user-initiated clear is counted as one.
    expect(result).toEqual({
      kind: 'cleared',
      size: '12x12',
      skippedRoleCount: 0,
      skippedPositionCount: 0,
      totalPlacements: 0,
    });
    expect(decode(write.mock.calls[0][0])).toBe(',!');
  });

  it('forwards the AbortSignal to write()', async () => {
    const write = makeWriteSpy();
    const controller = new AbortController();

    await dispatchWoodsPacket(`p${litPlacement}r4`, TWELVE_BY_TWELVE_SIZE_ID, write, controller.signal);

    expect(write.mock.calls[0][1]).toBe(controller.signal);
  });

  it('returns unknown_size and never writes when the size id maps to no LED table', async () => {
    const write = makeWriteSpy();

    const result = await dispatchWoodsPacket(`p${litPlacement}r2`, 99, write);

    expect(result).toEqual({ kind: 'unknown_size' });
    expect(write).not.toHaveBeenCalled();
  });

  it('returns incompatible and never writes when every placement is skipped (board would go dark)', async () => {
    // Woods encodes "clear" as an empty hold list, so a climb whose holds all
    // miss the LED table produces the same bare `,!` — writing it would silently
    // dark the wall while the send reported success.
    const write = makeWriteSpy();

    const result = await dispatchWoodsPacket(
      `p${unlitPlacement}r2p${unlitPlacement}r4`,
      TWELVE_BY_TWELVE_SIZE_ID,
      write,
    );

    expect(result).toEqual({ kind: 'incompatible' });
    expect(write).not.toHaveBeenCalled();
  });

  it('returns incompatible for a frames string whose every role is unrecognised', async () => {
    const write = makeWriteSpy();

    const result = await dispatchWoodsPacket(`p${litPlacement}r99`, TWELVE_BY_TWELVE_SIZE_ID, write);

    expect(result).toEqual({ kind: 'incompatible' });
    expect(write).not.toHaveBeenCalled();
  });

  it('returns incompatible and writes nothing for Aurora multi-frame input', async () => {
    const write = makeWriteSpy();

    const result = await dispatchWoodsPacket(`p${litPlacement}r2,p${litPlacement}r4`, TWELVE_BY_TWELVE_SIZE_ID, write);

    expect(result).toEqual({ kind: 'incompatible' });
    expect(write).not.toHaveBeenCalled();
  });

  it('does not swallow unrelated write failures', async () => {
    const writeFailure = new Error('unrelated write failure');
    const write = makeWriteSpy();
    write.mockRejectedValue(writeFailure);

    await expect(dispatchWoodsPacket(`p${litPlacement}r2`, TWELVE_BY_TWELVE_SIZE_ID, write)).rejects.toBe(writeFailure);
  });

  it('writes and reports the skip counts when only some placements are skipped', async () => {
    // A partial miss still lights what it can — the counts are what the hook
    // reports to Sentry so a wall missing two holds is diagnosable from the field.
    const write = makeWriteSpy();

    const result = await dispatchWoodsPacket(
      `p${litPlacement}r2p${unlitPlacement}r2p${litPlacement}r99`,
      TWELVE_BY_TWELVE_SIZE_ID,
      write,
    );

    expect(result).toEqual({
      kind: 'sent',
      size: '12x12',
      skippedRoleCount: 1,
      skippedPositionCount: 1,
      totalPlacements: 3,
    });
    expect(decode(write.mock.calls[0][0])).toBe(`${litLedIndex},2,!`);
  });
});

describe('moonboardNumRowsForNative', () => {
  // The row count native re-encodes use to address the serpentine grid —
  // Mini layouts (6 = 2020, 7 = 2025) are 12 rows, everything else 18.
  it('resolves 12 rows for Mini layouts and 18 for standard walls', () => {
    expect(moonboardNumRowsForNative('moonboard', 6)).toBe(12);
    expect(moonboardNumRowsForNative('moonboard', 7)).toBe(12);
    expect(moonboardNumRowsForNative('moonboard', 1)).toBe(18);
    expect(moonboardNumRowsForNative('moonboard', 3)).toBe(18);
  });

  it('falls back to the standard 18-row wall for an unknown layout id', () => {
    // getMoonBoardGeometryByLayoutId returns STANDARD_MOONBOARD_GEOMETRY when
    // the layout lookup misses, so this never throws.
    expect(moonboardNumRowsForNative('moonboard', 999)).toBe(18);
  });

  it('is undefined for non-MoonBoard boards (Aurora has no grid maths)', () => {
    expect(moonboardNumRowsForNative('kilter', 6)).toBeUndefined();
    expect(moonboardNumRowsForNative(undefined, 6)).toBeUndefined();
  });
});

describe('bleConnectReportLevel', () => {
  it('does not report a user-cancelled picker dismissal (null)', () => {
    expect(bleConnectReportLevel('user_cancelled')).toBeNull();
  });

  it('downgrades environmental failures to warning', () => {
    expect(bleConnectReportLevel('board_not_found')).toBe('warning');
    expect(bleConnectReportLevel('connect_failed')).toBe('warning');
  });

  it('keeps genuine faults at error level', () => {
    expect(bleConnectReportLevel('unavailable')).toBe('error');
    expect(bleConnectReportLevel('service_missing')).toBe('error');
    expect(bleConnectReportLevel('unknown')).toBe('error');
  });
});

describe('getBleEncodingSignature', () => {
  it('changes when MoonBoard adjacent-hold encoding is enabled', () => {
    expect(getBleEncodingSignature('moonboard', false)).toBe('default');
    expect(getBleEncodingSignature('moonboard', true)).toBe('moonboard:adjacent-holds');
  });

  it('ignores the MoonBoard-only preference for Aurora boards', () => {
    expect(getBleEncodingSignature('kilter', false)).toBe('default');
    expect(getBleEncodingSignature('kilter', true)).toBe('default');
  });
});

describe('bleWriteDiagnosticsProperties', () => {
  it('returns an empty object for null or undefined diagnostics', () => {
    expect(bleWriteDiagnosticsProperties(null)).toEqual({});
    expect(bleWriteDiagnosticsProperties(undefined)).toEqual({});
  });

  it('drops unreported fields instead of spreading undefined keys (Android reports only MTU/chunking)', () => {
    expect(bleWriteDiagnosticsProperties({ origin: 'js', negotiatedMtu: 247, chunkSize: 244, chunkCount: 2 })).toEqual({
      bleWriteOrigin: 'js',
      bleNegotiatedMtu: 247,
      bleChunkSize: 244,
      bleChunkCount: 2,
    });
  });

  it('maps every field to its ble*-prefixed analytics prop', () => {
    const diagnostics: BleWriteDiagnostics = {
      origin: 'native',
      writeType: 'withoutResponse',
      initialWriteType: 'withoutResponse',
      finalWriteType: 'withResponse',
      writeTypeSource: 'watchdogFallback',
      chunkSize: 244,
      chunkCount: 3,
      negotiatedMaxWriteWithoutResponse: 244,
      negotiatedMtu: 247,
      parkCount: 2,
      peripheralIsReadyFired: true,
      lastResumeSource: 'poll',
      maxParkMs: 30,
      totalParkMs: 45,
      watchdogTripped: false,
      canSendAtTrip: true,
      durationMs: 88,
    };

    expect(bleWriteDiagnosticsProperties(diagnostics)).toEqual({
      bleWriteOrigin: 'native',
      bleWriteType: 'withResponse',
      bleInitialWriteType: 'withoutResponse',
      bleFinalWriteType: 'withResponse',
      bleWriteTypeSource: 'watchdogFallback',
      bleChunkSize: 244,
      bleChunkCount: 3,
      bleMaxWriteWithoutResponse: 244,
      bleNegotiatedMtu: 247,
      bleParkCount: 2,
      blePeripheralIsReadyFired: true,
      bleLastResumeSource: 'poll',
      bleMaxParkMs: 30,
      bleTotalParkMs: 45,
      bleWatchdogTripped: false,
      bleCanSendAtTrip: true,
      bleWriteDurationMs: 88,
    });
  });
});

describe('resolveWriteSignal', () => {
  // The Expo-web relight regression: after the connect-time first send (which
  // carries no caller signal), every AutoSender send passed a caller signal
  // through the native generation-signal merge. Web now bypasses that merge and
  // passes the caller signal straight through, mirroring the proven Next.js web
  // app. These lock in that platform split.

  it('web: passes the caller signal straight through (no merge wrapper)', () => {
    const caller = new AbortController();
    const generation = new AbortController();
    const { combinedSignal } = resolveWriteSignal(caller.signal, generation.signal, 'web');
    // Same object — not a merged wrapper — so nothing the app does to the
    // generation controller can touch this write.
    expect(combinedSignal).toBe(caller.signal);
  });

  it('web: aborting the generation controller does NOT abort the write signal', () => {
    const caller = new AbortController();
    const generation = new AbortController();
    const { combinedSignal } = resolveWriteSignal(caller.signal, generation.signal, 'web');

    generation.abort();

    // The whole point of the fix: a generation-controller abort can no longer
    // silently no-op a web relight the way the merged signal could.
    expect(combinedSignal.aborted).toBe(false);
  });

  it('web: falls back to the generation signal when there is no caller signal (connect-time send)', () => {
    const generation = new AbortController();
    const { combinedSignal } = resolveWriteSignal(undefined, generation.signal, 'web');
    expect(combinedSignal).toBe(generation.signal);
  });

  it('web: a caller signal already aborted before the call stays aborted (no silent swallow)', () => {
    const caller = new AbortController();
    caller.abort();
    const generation = new AbortController();
    const { combinedSignal } = resolveWriteSignal(caller.signal, generation.signal, 'web');
    // Passed straight through — an already-aborted caller signal must read as
    // aborted immediately, not get lost in a merge wrapper.
    expect(combinedSignal).toBe(caller.signal);
    expect(combinedSignal.aborted).toBe(true);
  });

  it('native: merges caller + generation so a reconnect (generation abort) cancels the write', () => {
    const caller = new AbortController();
    const generation = new AbortController();
    const { combinedSignal } = resolveWriteSignal(caller.signal, generation.signal, 'ios');

    // A distinct merged signal, not either input by identity.
    expect(combinedSignal).not.toBe(caller.signal);
    expect(combinedSignal).not.toBe(generation.signal);
    expect(combinedSignal.aborted).toBe(false);

    generation.abort();
    expect(combinedSignal.aborted).toBe(true);
  });

  it('native: the merged signal also aborts when the caller signal aborts', () => {
    const caller = new AbortController();
    const generation = new AbortController();
    const { combinedSignal } = resolveWriteSignal(caller.signal, generation.signal, 'android');

    caller.abort();
    expect(combinedSignal.aborted).toBe(true);
  });

  it('native: dispose detaches the merge listeners so a later abort is inert', () => {
    const caller = new AbortController();
    const generation = new AbortController();
    const { combinedSignal, dispose } = resolveWriteSignal(caller.signal, generation.signal, 'android');

    dispose();
    generation.abort();
    // Detached before the abort — the merged controller never saw it.
    expect(combinedSignal.aborted).toBe(false);
  });

  it('native: falls back to the generation signal when there is no caller signal', () => {
    const generation = new AbortController();
    const { combinedSignal } = resolveWriteSignal(undefined, generation.signal, 'ios');
    expect(combinedSignal).toBe(generation.signal);
  });
});
