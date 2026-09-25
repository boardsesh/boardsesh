import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the ble-protocol exports — the adapter only uses the UUID constants
// and parseSerialNumber for auto-select matching.
vi.mock('@boardsesh/ble-protocol', () => ({
  AURORA_ADVERTISED_SERVICE_UUID: 'AURORA-UUID',
  UART_SERVICE_UUID: 'UART-UUID',
  REDBEARLAB_SERVICE_UUID: 'REDBEARLAB-UUID',
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
type DisconnectListener = (payload: {
  deviceId: string;
  errorCode?: number;
  errorDomain?: string;
  errorDescription?: string;
  context?: string;
}) => void;
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
import type { BleWriteDiagnostics, DevicePickerFn } from '../types';
import { recordingTargetPicker } from './recording-target-picker';

// A targeted connect opens the picker at the tap in its searching state (#5658).
// Tests that only care about the auto-select or the connect after it use a picker
// that stays open and never picks, standing in for that searching sheet.
const pickerThatNeverPicks: DevicePickerFn = () => new Promise<string>(() => {});

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
  it('keeps an empty picker open with the scan stopped when nothing is discovered within 30s', async () => {
    // Picker that subscribes and stays open until the climber cancels it.
    const onScanStopped = vi.fn();
    let cancelPicker: (error: Error) => void = () => {};
    const adapter = new NativeIosBleAdapter(
      (subscribe) =>
        new Promise<string>((_resolve, reject) => {
          subscribe(() => {}, onScanStopped);
          cancelPicker = reject;
        }),
    );
    let settledWith: unknown = 'pending';
    const connectPromise = adapter.requestAndConnect().then(
      (connection) => (settledWith = connection),
      (error: unknown) => (settledWith = error),
    );
    // Let microtasks settle (startScan is async).
    await Promise.resolve();
    await Promise.resolve();

    vi.advanceTimersByTime(30_000);
    // Advance past any chained promise resolutions in the timeout handler.
    await vi.runAllTimersAsync();

    // The scan window closed empty: the picker drops its spinner for the empty
    // state (tips, Scan again) instead of the connect failing under it (#5654).
    expect(nativeMock.stopScan).toHaveBeenCalled();
    expect(onScanStopped).toHaveBeenCalledOnce();
    expect(settledWith).toBe('pending');

    cancelPicker(new Error('Device selection cancelled'));
    await connectPromise;
    expect((settledWith as Error).message).toBe('Device selection cancelled');
    expect(nativeMock.connect).not.toHaveBeenCalled();
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

  const needleAdvert = {
    device: { deviceId: 'needle-dev', name: 'Garage Wall#NEEDLE-SERIAL@3' },
    localName: 'Garage Wall#NEEDLE-SERIAL@3',
    rssi: -50,
  };

  it('opens the picker at the tap in its searching state and keeps the list back until the grace ends (#5658)', async () => {
    const { picker, record } = recordingTargetPicker();
    const adapter = new NativeIosBleAdapter(picker);
    let settledWith: unknown = 'pending';
    void adapter.requestAndConnect('NEEDLE-SERIAL').then(
      (connection) => (settledWith = connection),
      (error: unknown) => (settledWith = error),
    );

    // Mounted at the tap, searching for the saved board, not a blank wait.
    expect(record.opened).toBe(1);
    expect(record.targetSearch).toBeDefined();
    await Promise.resolve();

    // The list does not take over before the grace window ends (#3609).
    await vi.advanceTimersByTimeAsync(SERIAL_RECONNECT_GRACE_MS - 1);
    expect(record.searchEnded).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(record.searchEnded).toBe(1);
    expect(record.opened).toBe(1);

    // With nothing ever discovered, the scan timeout stops the spinner and
    // leaves the picker up for its empty state, rather than failing (#5654).
    await vi.advanceTimersByTimeAsync(30_000);
    expect(record.scanStopped).toBe(1);
    expect(record.searchEnded).toBe(1);
    expect(settledWith).toBe('pending');
  });

  it('lets the user pick the saved board once the grace window has switched to the list', async () => {
    const { picker, record } = recordingTargetPicker();
    const adapter = new NativeIosBleAdapter(picker);
    const connectPromise = adapter.requestAndConnect('NEEDLE-SERIAL');
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(SERIAL_RECONNECT_GRACE_MS);
    expect(record.searchEnded).toBe(1);

    // The board finally advertises after the list took over: it shows up as a
    // pickable device (auto-select has stopped), and the climber taps it.
    scanListeners[0]?.(needleAdvert);
    expect(record.found).toBe(0);
    expect(nativeMock.connect).not.toHaveBeenCalled();
    record.pick('needle-dev');
    await vi.runAllTimersAsync();
    await connectPromise;

    expect(nativeMock.connect).toHaveBeenCalledWith('needle-dev');
  });

  it('auto-selects the saved board while searching, closes the picker and settles once (#3609, #5658)', async () => {
    const { picker, record } = recordingTargetPicker();
    const adapter = new NativeIosBleAdapter(picker);
    const connectPromise = adapter.requestAndConnect('NEEDLE-SERIAL');
    await Promise.resolve();

    // 6s in: past the old 4s grace, still inside the current one.
    await vi.advanceTimersByTimeAsync(6_000);
    scanListeners[0]?.(needleAdvert);

    const connection = await connectPromise;
    expect(connection.deviceId).toBe('needle-dev');
    expect(record.found).toBe(1);
    expect(record.searchEnded).toBe(0);
    // The picker's own reject on close did not beat the auto-select.
    expect(nativeMock.connect).toHaveBeenCalledTimes(1);

    // The grace window and the scan timeout change nothing afterwards.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(record.found).toBe(1);
    expect(record.searchEnded).toBe(0);
    expect(record.scanStopped).toBe(0);
  });

  it('lists a late match after "Search for any board" instead of auto-selecting it (#5658)', async () => {
    const { picker, record } = recordingTargetPicker();
    const adapter = new NativeIosBleAdapter(picker);
    const connectPromise = adapter.requestAndConnect('NEEDLE-SERIAL');
    await Promise.resolve();

    record.targetSearch?.searchAnyBoard();
    expect(record.searchEnded).toBe(1);
    // Idempotent: a second tap, and the grace window later, do nothing more.
    record.targetSearch?.searchAnyBoard();
    await vi.advanceTimersByTimeAsync(SERIAL_RECONNECT_GRACE_MS);
    expect(record.searchEnded).toBe(1);

    scanListeners[0]?.(needleAdvert);
    expect(record.found).toBe(0);
    expect(record.updates.at(-1)?.map((device) => device.deviceId)).toEqual(['needle-dev']);
    expect(nativeMock.connect).not.toHaveBeenCalled();

    record.pick('needle-dev');
    await vi.runAllTimersAsync();
    const connection = await connectPromise;
    expect(connection.deviceId).toBe('needle-dev');
  });
});

describe('NativeIosBleAdapter connect flow', () => {
  it('auto-selects a discovered device matching targetSerial', async () => {
    const adapter = new NativeIosBleAdapter(pickerThatNeverPicks);
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

  it('lists two bare-name boxes as two rows and connects to the one picked (#5601)', async () => {
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
      device: { deviceId: 'wall-a', name: 'Kilter Board' },
      localName: 'Kilter Board',
      rssi: -50,
    });
    scanListeners[0]?.({
      device: { deviceId: 'wall-b', name: 'Kilter Board' },
      localName: 'Kilter Board',
      rssi: -65,
    });

    manualPick('wall-a');
    await vi.runAllTimersAsync();
    await connectPromise;

    expect(seenDeviceIdsByUpdate.at(-1)).toEqual(['wall-a', 'wall-b']);
    expect(nativeMock.connect).toHaveBeenCalledWith('wall-a');
  });

  it('does not mask the original failure when stopScan rejects in the cleanup path', async () => {
    nativeMock.stopScan.mockRejectedValueOnce(new Error('bluetooth turned off'));
    const adapter = new NativeIosBleAdapter(() => Promise.reject(new Error('Device selection cancelled')));

    // Must surface the user-cancel, not the stopScan error — otherwise the
    // hook misclassifies the cancel and pops a spurious failure alert.
    await expect(adapter.requestAndConnect()).rejects.toThrow('Device selection cancelled');
  });

  it('flushes the native write queue when an in-flight write is aborted', async () => {
    const adapter = new NativeIosBleAdapter(pickerThatNeverPicks);
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
    const adapter = new NativeIosBleAdapter(pickerThatNeverPicks);

    await expect(adapter.disconnect()).resolves.toBeUndefined();
    expect(nativeMock.disconnect).not.toHaveBeenCalled();
  });

  it('skips native.disconnect after the device self-cleaned on a disconnected event', async () => {
    const adapter = new NativeIosBleAdapter(pickerThatNeverPicks);
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
    const adapter = new NativeIosBleAdapter(pickerThatNeverPicks);

    adapter.adoptConnection('adopted-dev');
    await adapter.disconnect();

    expect(nativeMock.disconnect).toHaveBeenCalled();
  });

  it('adoptConnection wires writes and the disconnect callback without scanning', async () => {
    const adapter = new NativeIosBleAdapter(pickerThatNeverPicks);

    adapter.adoptConnection('adopted-dev');
    await adapter.write(new Uint8Array([0x01, 0x02]));
    expect(nativeMock.write).toHaveBeenCalled();
    expect(nativeMock.startScan).not.toHaveBeenCalled();

    const onDisconnect = vi.fn();
    adapter.onDisconnect(onDisconnect);
    disconnectListeners[0]?.({ deviceId: 'adopted-dev' });
    expect(onDisconnect).toHaveBeenCalled();
  });

  it('forwards the native disconnect reason fields as BleDisconnectInfo', () => {
    const adapter = new NativeIosBleAdapter(pickerThatNeverPicks);

    adapter.adoptConnection('adopted-dev');
    const onDisconnect = vi.fn();
    adapter.onDisconnect(onDisconnect);
    // Shaped like an iOS peer-terminated drop (CBError code 7) — what a takeover
    // of the last-connection-wins board looks like once the Swift layer attaches
    // the NSError.
    disconnectListeners[0]?.({
      deviceId: 'adopted-dev',
      errorCode: 7,
      errorDomain: 'CBErrorDomain',
      errorDescription: 'The specified device has disconnected from us.',
    });

    expect(onDisconnect).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'native-ios',
        iosErrorCode: 7,
        errorDomain: 'CBErrorDomain',
        description: 'The specified device has disconnected from us.',
      }),
    );
  });

  it('forwards a write-stall context marker when the native layer caused the drop', () => {
    const adapter = new NativeIosBleAdapter(pickerThatNeverPicks);

    adapter.adoptConnection('adopted-dev');
    const onDisconnect = vi.fn();
    adapter.onDisconnect(onDisconnect);
    disconnectListeners[0]?.({ deviceId: 'adopted-dev', context: 'write_stall_budget_exhausted' });

    expect(onDisconnect).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'native-ios', context: 'write_stall_budget_exhausted' }),
    );
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

describe('NativeIosBleAdapter on older binaries (no adoption surface)', () => {
  beforeEach(() => {
    // Older native binary: getConnectedDevice absent → no unfiltered scan, so
    // MoonBoard must filter on BOTH controller generations.
    delete (nativeMock as Record<string, unknown>).getConnectedDevice;
  });

  it('filters a MoonBoard scan on both the UART and RedBearLab services', async () => {
    const adapter = new NativeIosBleAdapter(
      (subscribe) =>
        new Promise<string>(() => {
          subscribe(() => {});
        }),
      'moonboard',
    );
    void adapter.requestAndConnect();
    await Promise.resolve();
    await Promise.resolve();

    // Original RedBearLab MoonBoards advertise their own service, newer ones the
    // Nordic UART service — without an unfiltered scan we must list both.
    expect(nativeMock.startScan).toHaveBeenCalledWith(['UART-UUID', 'REDBEARLAB-UUID']);
  });
});

// ── Per-write transport diagnostics (#3230) ─────────────────────────────────

describe('NativeIosBleAdapter write diagnostics', () => {
  // A representative full-fidelity native diagnostics payload (iOS reports the
  // whole flow-control story). Shape-only — the adapter stores it verbatim.
  const sampleDiagnostics: BleWriteDiagnostics = {
    origin: 'native',
    writeType: 'withoutResponse',
    chunkSize: 244,
    chunkCount: 3,
    negotiatedMaxWriteWithoutResponse: 244,
    parkCount: 1,
    peripheralIsReadyFired: true,
    lastResumeSource: 'callback',
    maxParkMs: 12,
    totalParkMs: 12,
    watchdogTripped: false,
    durationMs: 40,
  };

  afterEach(() => {
    // Some cases attach the newer-binary getLastWriteDiagnostics; keep the
    // default native mock (old binary) clean for the next test.
    delete (nativeMock as Record<string, unknown>).getLastWriteDiagnostics;
  });

  it('stores the diagnostics the native write resolves on success', async () => {
    const adapter = new NativeIosBleAdapter(pickerThatNeverPicks);
    adapter.adoptConnection('adopted-dev');
    nativeMock.write.mockResolvedValueOnce(sampleDiagnostics);

    await adapter.write(new Uint8Array([0x01, 0x02]));

    await expect(adapter.getLastWriteDiagnostics()).resolves.toEqual(sampleDiagnostics);
  });

  it('records null (not undefined) when an old binary resolves no diagnostics', async () => {
    const adapter = new NativeIosBleAdapter(pickerThatNeverPicks);
    adapter.adoptConnection('adopted-dev');
    nativeMock.write.mockResolvedValueOnce(undefined);

    await expect(adapter.write(new Uint8Array([0x01]))).resolves.toBeUndefined();
    await expect(adapter.getLastWriteDiagnostics()).resolves.toBeNull();
  });

  it('fetches the native stash and rethrows when a write rejects on a newer binary', async () => {
    const adapter = new NativeIosBleAdapter(pickerThatNeverPicks);
    adapter.adoptConnection('adopted-dev');
    const writeError = new Error('write_timeout');
    nativeMock.write.mockRejectedValueOnce(writeError);
    const getStash = vi.fn().mockResolvedValue(sampleDiagnostics);
    (nativeMock as Record<string, unknown>).getLastWriteDiagnostics = getStash;

    await expect(adapter.write(new Uint8Array([0x01]))).rejects.toBe(writeError);
    expect(getStash).toHaveBeenCalledOnce();
    await expect(adapter.getLastWriteDiagnostics()).resolves.toEqual(sampleDiagnostics);
  });

  it('rethrows without a stash fetch when a write rejects on an old binary', async () => {
    // The default native mock has no getLastWriteDiagnostics — the old-binary
    // case where the reject path must not attempt (and must not throw from) a fetch.
    const adapter = new NativeIosBleAdapter(pickerThatNeverPicks);
    adapter.adoptConnection('adopted-dev');
    const writeError = new Error('write_timeout');
    nativeMock.write.mockRejectedValueOnce(writeError);

    await expect(adapter.write(new Uint8Array([0x01]))).rejects.toBe(writeError);
    await expect(adapter.getLastWriteDiagnostics()).resolves.toBeNull();
  });
});

describe('NativeIosBleAdapter connect diagnostics (#3480)', () => {
  afterEach(() => {
    delete (nativeMock as Record<string, unknown>).getLastConnectDiagnostics;
  });

  // Drive requestAndConnect to the point native.connect is invoked by
  // auto-selecting a device advertising the target serial.
  const driveConnect = (adapter: NativeIosBleAdapter, serial: string): Promise<unknown> => {
    const promise = adapter.requestAndConnect(serial).catch((error: Error) => error);
    void Promise.resolve().then(() => {
      scanListeners[0]?.({
        device: { deviceId: 'dev-1', name: `Kilter Board#${serial}@3` },
        localName: `Kilter Board#${serial}@3`,
        rssi: -55,
      });
    });
    return promise;
  };

  it('fetches the native stash and rethrows when a connect rejects on a newer binary', async () => {
    const adapter = new NativeIosBleAdapter(pickerThatNeverPicks);
    const connectError = new Error('UART service was not found');
    nativeMock.connect.mockRejectedValueOnce(connectError);
    const getStash = vi.fn().mockResolvedValue({ discoveredServices: ['AURORA-UUID'] });
    (nativeMock as Record<string, unknown>).getLastConnectDiagnostics = getStash;

    const connectPromise = driveConnect(adapter, 'A1B2C3');
    await vi.runAllTimersAsync();

    expect(await connectPromise).toBe(connectError);
    expect(getStash).toHaveBeenCalledOnce();
    await expect(adapter.getLastConnectDiagnostics()).resolves.toEqual({ discoveredServices: ['AURORA-UUID'] });
  });

  it('rethrows without a stash fetch when a connect rejects on an old binary', async () => {
    // Default native mock has no getLastConnectDiagnostics — the old-binary case
    // where the reject path must not attempt (or throw from) a fetch.
    const adapter = new NativeIosBleAdapter(pickerThatNeverPicks);
    const connectError = new Error('UART service was not found');
    nativeMock.connect.mockRejectedValueOnce(connectError);

    const connectPromise = driveConnect(adapter, 'A1B2C3');
    await vi.runAllTimersAsync();

    expect(await connectPromise).toBe(connectError);
    await expect(adapter.getLastConnectDiagnostics()).resolves.toBeNull();
  });

  it('clears stale connect diagnostics on a subsequent successful connect', async () => {
    const adapter = new NativeIosBleAdapter(pickerThatNeverPicks);
    const getStash = vi.fn().mockResolvedValue({ discoveredServices: [] });
    (nativeMock as Record<string, unknown>).getLastConnectDiagnostics = getStash;

    // First attempt fails and stashes diagnostics.
    nativeMock.connect.mockRejectedValueOnce(new Error('UART service was not found'));
    const firstAttempt = driveConnect(adapter, 'A1B2C3');
    await vi.runAllTimersAsync();
    await firstAttempt;
    await expect(adapter.getLastConnectDiagnostics()).resolves.toEqual({ discoveredServices: [] });

    // Second attempt succeeds — the stale diagnostics must be dropped.
    const secondAttempt = driveConnect(adapter, 'A1B2C3');
    await vi.runAllTimersAsync();
    await secondAttempt;
    await expect(adapter.getLastConnectDiagnostics()).resolves.toBeNull();
  });
});
