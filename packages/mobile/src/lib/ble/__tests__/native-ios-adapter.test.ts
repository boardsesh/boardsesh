import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the ble-protocol exports — the adapter only uses the UUID constants
// and parseSerialNumber for auto-select matching.
vi.mock('@boardsesh/ble-protocol', () => ({
  AURORA_ADVERTISED_SERVICE_UUID: 'AURORA-UUID',
  UART_SERVICE_UUID: 'UART-UUID',
  parseSerialNumber: (name?: string) => name ?? null,
}));

// Mock the Expo native module the adapter delegates to. vi.hoisted runs
// before the vi.mock factory so the shared state is initialized in time.
type ScanListener = (payload: { device: { deviceId: string; name: string }; localName: string; rssi: number }) => void;
type DisconnectListener = (payload: { deviceId: string }) => void;
const harness = vi.hoisted(() => {
  const scanListeners: ScanListener[] = [];
  const disconnectListeners: DisconnectListener[] = [];
  return {
    scanListeners,
    disconnectListeners,
    nativeMock: {
      isAvailable: vi.fn().mockResolvedValue({ available: true }),
      startScan: vi.fn().mockResolvedValue(undefined),
      stopScan: vi.fn().mockResolvedValue(undefined),
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      write: vi.fn().mockResolvedValue(undefined),
      cancelWrites: vi.fn().mockResolvedValue(undefined),
      configureBoard: vi.fn().mockResolvedValue(undefined),
      addListener: vi.fn((event: string, listener: ScanListener | DisconnectListener) => {
        if (event === 'scanResult') {
          scanListeners.push(listener as ScanListener);
          return {
            remove: () => scanListeners.splice(scanListeners.indexOf(listener as ScanListener), 1),
          };
        }
        if (event === 'disconnected') {
          disconnectListeners.push(listener as DisconnectListener);
          return {
            remove: () => disconnectListeners.splice(disconnectListeners.indexOf(listener as DisconnectListener), 1),
          };
        }
        return { remove: () => {} };
      }),
    },
  };
});
const { scanListeners, disconnectListeners, nativeMock } = harness;

vi.mock('../../../../modules/live-activity/src/index', () => ({
  boardBleNative: harness.nativeMock,
}));

import { NativeIosBleAdapter } from '../native-ios-adapter';

const RESCAN_DISCONNECT_SETTLE_MS = 350;

async function settleRescanReset() {
  await Promise.resolve();
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(RESCAN_DISCONNECT_SETTLE_MS);
  await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  Object.values(nativeMock).forEach((fn) => {
    if ('mockClear' in fn) fn.mockClear();
  });
  scanListeners.length = 0;
  disconnectListeners.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('NativeIosBleAdapter scan timeout', () => {
  it('rejects the picker promise when no devices are discovered within 30s', async () => {
    // Picker callback that subscribes but never resolves — simulates a user
    // staring at an empty picker.
    const adapter = new NativeIosBleAdapter(() => new Promise(() => {}));
    const connectPromise = adapter.requestAndConnect().catch((error: Error) => error);
    await settleRescanReset();

    vi.advanceTimersByTime(30_000);
    // Advance past any chained promise resolutions in the timeout handler.
    await vi.runAllTimersAsync();

    const result = await connectPromise;
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/no boards found/i);
    expect(nativeMock.stopScan).toHaveBeenCalled();
  });

  it("does NOT reject the picker when devices have been discovered (user just hasn't picked yet)", async () => {
    // Returns a promise that resolves only when we call manualPick later —
    // mirrors the user tapping a device in the picker UI after scan times out.
    let manualPick: (deviceId: string) => void = () => {};
    const adapter = new NativeIosBleAdapter(
      () =>
        new Promise<string>((resolve) => {
          manualPick = resolve;
        }),
    );
    const connectPromise = adapter.requestAndConnect();
    await settleRescanReset();

    // Emit a scan result before the timeout fires.
    scanListeners[0]?.({
      device: { deviceId: 'dev-1', name: 'Kilter A1B2C3' },
      localName: 'Kilter A1B2C3',
      rssi: -60,
    });

    vi.advanceTimersByTime(30_000);
    await vi.runAllTimersAsync();

    // Picker promise must still be live — user can still pick the device
    // that was discovered before the timeout.
    manualPick('dev-1');
    await connectPromise;

    expect(nativeMock.connect).toHaveBeenCalledWith('dev-1');
  });

  it('rejects with "target not found" when targetSerial auto-select times out', async () => {
    const adapter = new NativeIosBleAdapter(() => Promise.reject(new Error('picker should not open')));
    const connectPromise = adapter.requestAndConnect('NEEDLE-SERIAL').catch((error: Error) => error);
    await settleRescanReset();

    vi.advanceTimersByTime(30_000);
    await vi.runAllTimersAsync();

    const result = await connectPromise;
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/target board not found/i);
  });
});

describe('NativeIosBleAdapter connect flow', () => {
  it('auto-selects a discovered device matching targetSerial', async () => {
    const adapter = new NativeIosBleAdapter(() => Promise.reject(new Error('picker should not open')));
    const connectPromise = adapter.requestAndConnect('Kilter A1B2C3');
    await settleRescanReset();

    scanListeners[0]?.({
      device: { deviceId: 'dev-9', name: 'Kilter A1B2C3' },
      localName: 'Kilter A1B2C3',
      rssi: -55,
    });
    await vi.runAllTimersAsync();
    await connectPromise;

    expect(nativeMock.connect).toHaveBeenCalledWith('dev-9');
    expect(nativeMock.startScan).toHaveBeenCalledWith(['AURORA-UUID', 'UART-UUID']);
  });

  it('clears any native iOS connection before scanning so boards advertise after a JS reload', async () => {
    const adapter = new NativeIosBleAdapter(() => new Promise(() => {}));
    void adapter.requestAndConnect().catch(() => {});
    await Promise.resolve();

    expect(nativeMock.stopScan).toHaveBeenCalledTimes(1);
    expect(nativeMock.disconnect).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(RESCAN_DISCONNECT_SETTLE_MS);
    await Promise.resolve();

    expect(nativeMock.startScan).toHaveBeenCalledWith(['AURORA-UUID', 'UART-UUID']);
  });
});
