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
import {
  bleConnectReportLevel,
  convertToMirroredFramesString,
  dispatchMoonboardPacket,
  useBoardBluetooth,
} from '../use-board-bluetooth';
import { clearBleDiagnosticsLog, getBleDiagnosticsEvents } from '../ble-diagnostics-log';

// ── Factory helpers ────────────────────────────────────────────────────────

function makePlacement(id: number, mirroredHoldId: number | null): HoldPlacement {
  return { id, mirroredHoldId, cx: 0, cy: 0, r: 10 };
}

type FakeAdapterOverrides = Partial<Record<'isAvailable' | 'requestAndConnect' | 'disconnect' | 'write', unknown>>;

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
    clearBleDiagnosticsLog();
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
    expect(createBluetoothAdapter).toHaveBeenCalledWith(expect.any(Function), 'moonboard');

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

    expect(createBluetoothAdapter).toHaveBeenCalledWith(expect.any(Function), 'aurora');
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
    // A user-cancel is not a connection issue — it must NOT pollute the
    // opt-in bug-report diagnostics with a phantom connect_failure.
    expect(getBleDiagnosticsEvents().some((event) => event.type === 'connect_failure')).toBe(false);
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
    // A real (non-cancel) connect failure IS recorded for the bug report.
    const connectFailure = getBleDiagnosticsEvents().find((event) => event.type === 'connect_failure');
    expect(connectFailure).toMatchObject({ type: 'connect_failure', failureCategory: 'connect_failed' });
  });

  it('serialises overlapping sendFramesToBoard calls so chunks never interleave', async () => {
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

    const { result } = renderHook(() => useBoardBluetooth({ boardName: 'moonboard', layoutId: 1, sizeId: 1 }));

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
      releaseFirstWrite();
      await Promise.all([firstSend, secondSend]);
    });

    expect(writeEvents).toEqual(['start-1', 'end-1', 'start-2', 'end-2']);
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

    // Exactly one disconnect is logged for the stolen write, labelled 'stolen'.
    const disconnectsAfterWrite = getBleDiagnosticsEvents().filter((event) => event.type === 'disconnect');
    expect(disconnectsAfterWrite).toHaveLength(1);
    expect(disconnectsAfterWrite[0]).toMatchObject({ type: 'disconnect', kind: 'stolen' });

    // Some BLE stacks ALSO fire the adapter's own disconnect event for the same
    // physical drop. The per-generation guard must keep that from double-logging.
    const adapterDisconnectHandler = (fakeAdapter.onDisconnect.mock.calls[0] as unknown[] | undefined)?.[0] as
      | (() => void)
      | undefined;
    await act(async () => {
      adapterDisconnectHandler?.();
    });
    expect(getBleDiagnosticsEvents().filter((event) => event.type === 'disconnect')).toHaveLength(1);
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

    const { result } = renderHook(() => useBoardBluetooth({ boardName: 'kilter', layoutId: 1, sizeId: 1 }));

    await act(async () => {
      connectedListener?.({ deviceId: 'native-dev-1', deviceName: 'Kilter Board#9@3' });
    });
    expect(result.current.isConnected).toBe(true);

    await act(async () => {
      firstDisconnectCallback?.();
    });
    expect(result.current.isConnected).toBe(false);

    await act(async () => {
      connectedListener?.({ deviceId: 'native-dev-2', deviceName: 'Kilter Board#9@3' });
    });

    expect(secondAdapter.adoptConnection).toHaveBeenCalledWith('native-dev-2');
    expect(result.current.isConnected).toBe(true);
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
    expect(onConnectSuccess).toHaveBeenLastCalledWith('9');
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
    vi.mocked(subscribeNativeBleConnected).mockImplementation(() => null);
    vi.mocked(getNativeBleConnectedDevice).mockImplementation(async () => null);
    vi.mocked(isNativeIosBleAdapter).mockReturnValue(false);
    vi.mocked(parseBoardTypeFromDeviceName).mockReset();
    vi.mocked(parseSerialNumber).mockReset();
  });

  it('tears down the live connection when the board config switches', async () => {
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
    expect(result.current.isConnected).toBe(true);

    await act(async () => {
      rerender({ boardName: 'kilter', layoutId: 2, sizeId: 1 });
    });

    expect(fakeAdapter.disconnect).toHaveBeenCalled();
    expect(result.current.isConnected).toBe(false);
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
    // adapterRef and connectedConfigKeyRef are both null at that point, so the
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
    });
    const write = vi.fn().mockResolvedValue(undefined);

    const result = await dispatchMoonboardPacket('p1r12', write);

    expect(result).toBe(true);
  });

  it('returns undefined and skips write when frames is empty', async () => {
    const write = vi.fn();

    const result = await dispatchMoonboardPacket('', write);

    expect(result).toBeUndefined();
    expect(write).not.toHaveBeenCalled();
  });

  it('forwards the AbortSignal to write()', async () => {
    const fakePacket = new Uint8Array([0xaa]);
    mockGetMoonboardBluetoothPacket.mockReturnValue({
      packet: fakePacket,
      totalPlacements: 1,
      skippedRoleCount: 0,
      skippedPositionCount: 0,
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
    });
    const write = vi.fn().mockResolvedValue(undefined);

    const result = await dispatchMoonboardPacket('p1r99p2r98', write);

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
    });
    const write = vi.fn().mockResolvedValue(undefined);

    const result = await dispatchMoonboardPacket('p1r42p2r99', write);

    expect(result).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
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
