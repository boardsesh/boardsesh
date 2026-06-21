import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the ble-protocol exports — the adapter only uses the UUID constants
// and parseSerialNumber for auto-select matching.
vi.mock('@boardsesh/ble-protocol', () => ({
  AURORA_ADVERTISED_SERVICE_UUID: 'AURORA-UUID',
  UART_SERVICE_UUID: 'UART-UUID',
  parseSerialNumber: (name?: string) => name?.match(/#([^@]+)/)?.[1] ?? undefined,
}));

// Mock the Expo native module the adapter delegates to. vi.hoisted runs
// before the vi.mock factory so the shared state is initialized in time.
type ScanListener = (payload: {
  device: { deviceId: string; name: string };
  localName: string;
  rssi: number;
  serviceUuids?: string[];
}) => void;
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
import { SERIAL_RECONNECT_GRACE_MS } from '@boardsesh/ble-protocol/scan-constants';

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
    // Let microtasks settle (startScan is async).
    await Promise.resolve();
    await Promise.resolve();

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
    await Promise.resolve();

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

  it('falls back to the picker (not a hard reject) when targetSerial never advertises', async () => {
    let pickerOpened = false;
    // Picker that stays open once shown (never resolves on its own).
    const adapter = new NativeIosBleAdapter(() => {
      pickerOpened = true;
      return new Promise<string>(() => {});
    });
    const connectPromise = adapter.requestAndConnect('NEEDLE-SERIAL').catch((error: Error) => error);
    await Promise.resolve();

    // Before the grace window the auto-select is still silent — no picker.
    vi.advanceTimersByTime(SERIAL_RECONNECT_GRACE_MS - 1);
    await Promise.resolve();
    expect(pickerOpened).toBe(false);

    // Grace window elapses with no serial match → the picker opens instead of
    // waiting out the full scan window and failing.
    vi.advanceTimersByTime(1);
    await Promise.resolve();
    expect(pickerOpened).toBe(true);

    // ...and with nothing ever discovered, the scan timeout rejects so the
    // sheet doesn't spin forever.
    vi.advanceTimersByTime(30_000);
    await vi.runAllTimersAsync();
    const result = await connectPromise;
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/no boards found/i);
  });

  it('lets the user pick the stored board after the grace window opens the picker', async () => {
    let manualPick: (deviceId: string) => void = () => {};
    const adapter = new NativeIosBleAdapter(
      () =>
        new Promise<string>((resolve) => {
          manualPick = resolve;
        }),
    );
    const connectPromise = adapter.requestAndConnect('NEEDLE-SERIAL');
    await Promise.resolve();

    // Grace window opens the picker.
    vi.advanceTimersByTime(SERIAL_RECONNECT_GRACE_MS);
    await Promise.resolve();

    // The board finally advertises after the picker opened — it shows up as a
    // pickable device (auto-select has stopped), and the user taps it.
    scanListeners[0]?.({
      device: { deviceId: 'late-dev', name: 'Garage Wall#NEEDLE-SERIAL@3' },
      localName: 'Garage Wall#NEEDLE-SERIAL@3',
      rssi: -50,
    });
    manualPick('late-dev');
    await vi.runAllTimersAsync();
    await connectPromise;

    expect(nativeMock.connect).toHaveBeenCalledWith('late-dev');
  });
});

describe('NativeIosBleAdapter connect flow', () => {
  it('auto-selects a discovered device matching targetSerial', async () => {
    const adapter = new NativeIosBleAdapter(() => Promise.reject(new Error('picker should not open')));
    const connectPromise = adapter.requestAndConnect('A1B2C3');
    await Promise.resolve();

    scanListeners[0]?.({
      device: { deviceId: 'dev-9', name: 'Kilter Board#A1B2C3@3' },
      localName: 'Kilter Board#A1B2C3@3',
      rssi: -55,
    });
    await vi.runAllTimersAsync();
    await connectPromise;

    expect(nativeMock.connect).toHaveBeenCalledWith('dev-9');
    expect(nativeMock.startScan).toHaveBeenCalledWith(['AURORA-UUID']);
  });

  it('deduplicates repeated board names even when native reports a different device id', async () => {
    let manualPick: (deviceId: string) => void = () => {};
    const seenDeviceIdsByUpdate: string[][] = [];
    const adapter = new NativeIosBleAdapter(
      (subscribe) =>
        new Promise<string>((resolve) => {
          manualPick = resolve;
          subscribe((devices) => {
            seenDeviceIdsByUpdate.push(devices.map((device) => device.deviceId));
          });
        }),
    );
    const connectPromise = adapter.requestAndConnect();
    await Promise.resolve();
    await Promise.resolve();

    scanListeners[0]?.({
      device: { deviceId: 'first-native-id', name: 'Kilter Board#751737@3' },
      localName: 'Kilter Board#751737@3',
      rssi: -50,
    });
    scanListeners[0]?.({
      device: { deviceId: 'second-native-id', name: 'Kilter Board#751737@3' },
      localName: 'Kilter Board#751737@3',
      rssi: -45,
    });

    manualPick('second-native-id');
    await vi.runAllTimersAsync();
    await connectPromise;

    expect(seenDeviceIdsByUpdate).toEqual([[], ['first-native-id'], ['second-native-id']]);
    expect(nativeMock.connect).toHaveBeenCalledWith('second-native-id');
  });

  it('replaces an unnamed row when a later scan response adds the board name', async () => {
    let manualPick: (deviceId: string) => void = () => {};
    const seenDevicesByUpdate: Array<Array<{ deviceId: string; name?: string }>> = [];
    const adapter = new NativeIosBleAdapter(
      (subscribe) =>
        new Promise<string>((resolve) => {
          manualPick = resolve;
          subscribe((devices) => {
            seenDevicesByUpdate.push(devices.map((device) => ({ deviceId: device.deviceId, name: device.name })));
          });
        }),
    );
    const connectPromise = adapter.requestAndConnect();
    await Promise.resolve();
    await Promise.resolve();

    scanListeners[0]?.({
      device: { deviceId: 'late-name-device', name: '' },
      localName: '',
      rssi: -50,
    });
    scanListeners[0]?.({
      device: { deviceId: 'late-name-device', name: 'Kilter Board#751737@3' },
      localName: 'Kilter Board#751737@3',
      rssi: -45,
    });

    manualPick('late-name-device');
    await vi.runAllTimersAsync();
    await connectPromise;

    expect(seenDevicesByUpdate).toEqual([
      [],
      [{ deviceId: 'late-name-device', name: undefined }],
      [{ deviceId: 'late-name-device', name: 'Kilter Board#751737@3' }],
    ]);
  });

  it('does not mask the original failure when stopScan rejects in the cleanup path', async () => {
    nativeMock.stopScan.mockRejectedValueOnce(new Error('bluetooth turned off'));
    const adapter = new NativeIosBleAdapter(() => Promise.reject(new Error('Device selection cancelled')));

    // Must surface the user-cancel, not the stopScan error — otherwise the
    // hook misclassifies the cancel and pops a spurious failure alert.
    await expect(adapter.requestAndConnect()).rejects.toThrow('Device selection cancelled');
  });

  it('flushes the native write queue when an in-flight write is aborted', async () => {
    const adapter = new NativeIosBleAdapter(() => Promise.reject(new Error('picker should not open')));
    const connectPromise = adapter.requestAndConnect('A1B2C3');
    await Promise.resolve();
    scanListeners[0]?.({
      device: { deviceId: 'dev-9', name: 'Kilter Board#A1B2C3@3' },
      localName: 'Kilter Board#A1B2C3@3',
      rssi: -55,
    });
    await vi.runAllTimersAsync();
    await connectPromise;

    let rejectNativeWrite!: (error: Error) => void;
    nativeMock.write.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectNativeWrite = reject;
        }),
    );
    const abortController = new AbortController();
    const writePromise = adapter.write(new Uint8Array([0x01]), abortController.signal);
    await Promise.resolve();

    abortController.abort();
    expect(nativeMock.cancelWrites).toHaveBeenCalled();

    // The native queue rejects the cancelled write with its own error; the
    // adapter normalises it to AbortError so callers treat it as cancellation.
    rejectNativeWrite(new Error('BLE write cancelled'));
    await expect(writePromise).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('does not call native.disconnect on a never-connected adapter', async () => {
    const adapter = new NativeIosBleAdapter(() => Promise.reject(new Error('picker should not open')));

    await expect(adapter.disconnect()).resolves.toBeUndefined();
    expect(nativeMock.disconnect).not.toHaveBeenCalled();
  });

  it('skips native.disconnect after the device self-cleaned on a disconnected event', async () => {
    const adapter = new NativeIosBleAdapter(() => Promise.reject(new Error('picker should not open')));
    const connectPromise = adapter.requestAndConnect('A1B2C3');
    await Promise.resolve();
    scanListeners[0]?.({
      device: { deviceId: 'dev-9', name: 'Kilter Board#A1B2C3@3' },
      localName: 'Kilter Board#A1B2C3@3',
      rssi: -55,
    });
    await vi.runAllTimersAsync();
    await connectPromise;

    // The native side reports the board dropped — the adapter self-cleans and
    // nulls connectedDeviceId.
    disconnectListeners[0]?.({ deviceId: 'dev-9' });

    // A blind native.disconnect() here could cancel a connection a newer
    // adapter adopted after this one was abandoned, so it must be skipped.
    await adapter.disconnect();
    expect(nativeMock.disconnect).not.toHaveBeenCalled();
  });

  it('calls native.disconnect after adoptConnection while still tracking a device', async () => {
    const adapter = new NativeIosBleAdapter(() => Promise.reject(new Error('picker should not open')));

    adapter.adoptConnection('adopted-dev');
    await adapter.disconnect();

    expect(nativeMock.disconnect).toHaveBeenCalled();
  });

  it('adoptConnection wires writes and the disconnect callback without scanning', async () => {
    const adapter = new NativeIosBleAdapter(() => Promise.reject(new Error('picker should not open')));

    adapter.adoptConnection('adopted-dev');
    await adapter.write(new Uint8Array([0x01, 0x02]));
    expect(nativeMock.write).toHaveBeenCalled();
    expect(nativeMock.startScan).not.toHaveBeenCalled();

    const onDisconnect = vi.fn();
    adapter.onDisconnect(onDisconnect);
    disconnectListeners[0]?.({ deviceId: 'adopted-dev' });
    expect(onDisconnect).toHaveBeenCalled();
  });
});

describe('NativeIosBleAdapter on newer binaries (adoption surface present)', () => {
  beforeEach(() => {
    (nativeMock as Record<string, unknown>).getConnectedDevice = vi.fn().mockResolvedValue(null);
  });
  afterEach(() => {
    delete (nativeMock as Record<string, unknown>).getConnectedDevice;
  });

  it('scans unfiltered and filters scan results in JS so MoonBoards surface', async () => {
    let manualPick: (deviceId: string) => void = () => {};
    const seenDeviceIds: string[] = [];
    const adapter = new NativeIosBleAdapter(
      (subscribe) =>
        new Promise<string>((resolve) => {
          manualPick = resolve;
          subscribe((devices) => {
            seenDeviceIds.splice(0, seenDeviceIds.length, ...devices.map((device) => device.deviceId));
          });
        }),
      'moonboard',
    );
    const connectPromise = adapter.requestAndConnect();
    await Promise.resolve();
    await Promise.resolve();

    // Unfiltered scan on the newer surface — a native UUID filter would hide
    // MoonBoards, which don't reliably advertise the UART UUID.
    expect(nativeMock.startScan).toHaveBeenCalledWith([]);

    // A MoonBoard with no advertised UUIDs must surface; a nameless device
    // advertising nothing board-like must not.
    scanListeners[0]?.({
      device: { deviceId: 'moon-1', name: 'MoonBoard A1' },
      localName: 'MoonBoard A1',
      rssi: -40,
    });
    scanListeners[0]?.({
      device: { deviceId: 'mystery', name: '' },
      localName: '',
      rssi: -30,
    });

    expect(seenDeviceIds).toEqual(['moon-1']);

    manualPick('moon-1');
    await vi.runAllTimersAsync();
    await connectPromise;
    expect(nativeMock.connect).toHaveBeenCalledWith('moon-1');
  });

  it('uses the Aurora service filter and drops unrelated devices on Aurora scans', async () => {
    let manualPick: (deviceId: string) => void = () => {};
    const seenDeviceIds: string[] = [];
    const adapter = new NativeIosBleAdapter(
      (subscribe) =>
        new Promise<string>((resolve) => {
          manualPick = resolve;
          subscribe((devices) => {
            seenDeviceIds.splice(0, seenDeviceIds.length, ...devices.map((device) => device.deviceId));
          });
        }),
      'aurora',
    );
    const connectPromise = adapter.requestAndConnect();
    await Promise.resolve();
    await Promise.resolve();

    expect(nativeMock.startScan).toHaveBeenCalledWith(['AURORA-UUID']);

    scanListeners[0]?.({
      device: { deviceId: 'airpods', name: "Marco's AirPods #1" },
      localName: "Marco's AirPods #1",
      rssi: -30,
      serviceUuids: [],
    });
    scanListeners[0]?.({
      device: { deviceId: 'aurora-1', name: 'Kilter Board#751737@3' },
      localName: 'Kilter Board#751737@3',
      rssi: -40,
      serviceUuids: ['AURORA-UUID'],
    });

    expect(seenDeviceIds).toEqual(['aurora-1']);

    manualPick('aurora-1');
    await vi.runAllTimersAsync();
    await connectPromise;
    expect(nativeMock.connect).toHaveBeenCalledWith('aurora-1');
  });
});
