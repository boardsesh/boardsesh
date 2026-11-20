import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  QUANTUM_LEGACY_SERVICE_UUID,
  QUANTUM_METADATA_CHARACTERISTIC_UUID,
  QUANTUM_NOTIFY_CHARACTERISTIC_UUID,
  QUANTUM_REQUESTED_MTU,
  QUANTUM_SERVICE_UUID,
  QUANTUM_STATE_CHARACTERISTIC_UUID,
  QUANTUM_WRITE_CHARACTERISTIC_UUID,
  QuantumCommand,
  encodeQuantumRosterRequest,
  encodeQuantumUuid,
} from '@boardsesh/ble-protocol/quantum';
import { SCAN_TIMEOUT_MS } from '@boardsesh/ble-protocol/scan-constants';
import type { DevicePickerFn, DiscoveredDevice } from '../types';

const manager = vi.hoisted(() => ({
  startDeviceScan: vi.fn(),
  stopDeviceScan: vi.fn(),
  connectToDevice: vi.fn(),
  cancelDeviceConnection: vi.fn(),
  cancelTransaction: vi.fn(),
  onDeviceDisconnected: vi.fn(),
}));

const platform = vi.hoisted(() => ({ OS: 'android' as 'android' | 'ios' }));

vi.mock('react-native', () => ({ Platform: platform }));
vi.mock('../ble-manager', () => ({ getBleManager: () => manager }));
vi.mock('../availability', () => ({ waitForBlePoweredOn: vi.fn(async () => true) }));

import { RNQuantumBluetoothTransport } from '../quantum-adapter';
import { waitForBlePoweredOn } from '../availability';

function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function metadata(controllerType: number, columns: number, rows: number): Uint8Array {
  const bytes = new Uint8Array(41);
  bytes[34] = controllerType;
  bytes[35] = (columns >>> 8) & 0xff;
  bytes[36] = columns & 0xff;
  bytes[37] = (rows >>> 8) & 0xff;
  bytes[38] = rows & 0xff;
  return bytes;
}

function rosterFrame(): Uint8Array {
  const frame = new Uint8Array(41);
  frame.set([1, QuantumCommand.REQUEST_USER_ROUTE_LIST, 1, 0]);
  frame.set(encodeQuantumUuid('10000000-0000-4000-8000-000000000001'), 4);
  frame.set(encodeQuantumUuid('20000000-0000-4000-8000-000000000001'), 20);
  frame.set([0, 60, 0, 255, 255], 36);
  return frame;
}

function setupController(
  options: {
    deviceId?: string;
    deviceName?: string;
    metadataBytes?: Uint8Array;
    hangMetadataRead?: boolean;
    hangWrite?: boolean;
    hangStateRead?: boolean;
    hangMtuRequest?: boolean;
    hangServiceDiscovery?: boolean;
    hangCharacteristicDiscovery?: boolean;
    hangNotificationSetup?: boolean;
    connectedMtu?: number;
    negotiatedMtu?: number;
  } = {},
) {
  const deviceId = options.deviceId ?? 'quantum-device';
  let notifyListener: ((error: null, characteristic: { value: string }) => void) | undefined;
  let notificationReady = false;
  const monitorRemove = vi.fn();
  const writeWithResponse = vi.fn((_frame?: string, _transactionId?: string) =>
    options.hangWrite ? new Promise<undefined>(() => {}) : Promise.resolve(undefined),
  );
  const stateRead = vi.fn((_transactionId?: string) =>
    options.hangStateRead
      ? new Promise<{ value: string }>(() => {})
      : Promise.resolve({ value: base64(rosterFrame()) }),
  );
  const metadataRead = vi.fn((_transactionId?: string) =>
    options.hangMetadataRead
      ? new Promise<{ value: string }>(() => {})
      : Promise.resolve({ value: base64(options.metadataBytes ?? metadata(1, 12, 12)) }),
  );
  const writeWithoutResponse = vi.fn(async () => undefined);
  const characteristic = (uuid: string) => ({
    isWritableWithResponse: true,
    isWritableWithoutResponse: true,
    writeWithoutResponse,
    uuid,
    get isNotifying() {
      return uuid === QUANTUM_NOTIFY_CHARACTERISTIC_UUID && notificationReady;
    },
    writeWithResponse,
    read: uuid === QUANTUM_METADATA_CHARACTERISTIC_UUID ? metadataRead : stateRead,
    monitor: vi.fn((listener: typeof notifyListener) => {
      notifyListener = listener;
      if (!options.hangNotificationSetup) notificationReady = true;
      return { remove: monitorRemove };
    }),
  });
  const characteristics = [
    characteristic(QUANTUM_NOTIFY_CHARACTERISTIC_UUID),
    characteristic(QUANTUM_WRITE_CHARACTERISTIC_UUID),
    characteristic(QUANTUM_STATE_CHARACTERISTIC_UUID),
    characteristic(QUANTUM_METADATA_CHARACTERISTIC_UUID),
  ];
  const discovered = {
    id: deviceId,
    mtu: options.negotiatedMtu ?? QUANTUM_REQUESTED_MTU,
    characteristicsForService: vi.fn((serviceUuid: string) =>
      options.hangCharacteristicDiscovery
        ? new Promise<typeof characteristics>(() => {})
        : Promise.resolve(serviceUuid === QUANTUM_LEGACY_SERVICE_UUID ? characteristics : []),
    ),
    discoverAllServicesAndCharacteristics: vi.fn(),
  };
  discovered.discoverAllServicesAndCharacteristics.mockImplementation(() =>
    options.hangServiceDiscovery ? new Promise<typeof discovered>(() => {}) : Promise.resolve(discovered),
  );
  const requestMTU = vi.fn((_requestedMtu: number, _transactionId: string) =>
    options.hangMtuRequest ? new Promise<typeof discovered>(() => {}) : Promise.resolve(discovered),
  );
  const connectedDevice = {
    ...discovered,
    id: deviceId,
    mtu: options.connectedMtu ?? 23,
    requestMTU,
  };
  manager.connectToDevice.mockResolvedValue(connectedDevice);
  manager.onDeviceDisconnected.mockReturnValue({ remove: vi.fn() });
  manager.cancelDeviceConnection.mockResolvedValue(undefined);
  manager.cancelTransaction.mockResolvedValue(undefined);
  manager.startDeviceScan.mockImplementation(
    (_services: unknown, _options: unknown, callback: (error: null, device: unknown) => void) => {
      callback(null, { id: 'decoy', localName: 'QB_not-a-serial', rssi: -10 });
      callback(null, { id: deviceId, localName: options.deviceName ?? 'QB_AABBCCDDEEFF', rssi: -35 });
    },
  );

  const updates: DiscoveredDevice[][] = [];
  const picker: DevicePickerFn = async (subscribe) => {
    subscribe((devices) => updates.push(devices));
    return deviceId;
  };
  return {
    adapter: new RNQuantumBluetoothTransport(picker),
    writeWithoutResponse,
    requestMTU,
    writeWithResponse,
    stateRead,
    metadataRead,
    connectedDevice,
    updates,
    emitNotification(bytes: Uint8Array) {
      notifyListener?.(null, { value: base64(bytes) });
    },
  };
}

describe('RNQuantumBluetoothTransport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platform.OS = 'android';
    vi.mocked(waitForBlePoweredOn).mockReset().mockResolvedValue(true);
  });

  it('keeps native connect available without prompting for permission or touching the radio', async () => {
    platform.OS = 'ios';
    vi.mocked(waitForBlePoweredOn).mockResolvedValue(false);
    const { adapter } = setupController();
    expect(await adapter.isAvailable()).toBe(true);
    expect(waitForBlePoweredOn).not.toHaveBeenCalled();
    expect(manager.startDeviceScan).not.toHaveBeenCalled();
  });

  it('rechecks the radio on an explicit connect after it changes from off to on', async () => {
    const { adapter } = setupController();
    vi.mocked(waitForBlePoweredOn).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await expect(adapter.requestAndConnect('m')).rejects.toThrow('powered off');
    expect(manager.startDeviceScan).not.toHaveBeenCalled();
    expect(await adapter.isAvailable()).toBe(true);
    const connected = await adapter.requestAndConnect('m');
    expect(connected.serial).toBe('AABBCCDDEEFF');
    expect(waitForBlePoweredOn).toHaveBeenCalledTimes(2);
  });

  it('filters exact names, negotiates 512, discovers legacy GATT, and writes atomically with response', async () => {
    const controller = setupController();
    const connection = await controller.adapter.requestAndConnect('m');

    expect(connection.serial).toBe('AABBCCDDEEFF');
    expect(connection.metadata.model.id).toBe('m');
    expect(controller.updates.at(-1)?.map((device) => device.deviceId)).toEqual(['quantum-device']);
    expect(controller.requestMTU).toHaveBeenCalledWith(512, expect.stringMatching(/^quantum-MTU-request-/));

    const frame = Uint8Array.from({ length: 227 }, (_, index) => index & 0xff);
    await controller.adapter.writeFrame(frame);
    expect(controller.writeWithResponse).toHaveBeenCalledOnce();
    expect(controller.writeWithResponse).toHaveBeenCalledWith(base64(frame), expect.any(String));
  });

  it('aborts the picker contract on scan failure and an empty scan timeout', async () => {
    vi.useFakeTimers();
    try {
      const pickerSignals: AbortSignal[] = [];
      const picker: DevicePickerFn = (_subscribe, _targetSearch, signal) => {
        if (!signal) throw new Error('Quantum picker cancellation signal was not supplied');
        pickerSignals.push(signal);
        return new Promise<string>((_resolve, reject) => {
          const rejectFromAbort = () => reject(signal.reason ?? new Error('Device selection cancelled'));
          if (signal.aborted) rejectFromAbort();
          else signal.addEventListener('abort', rejectFromAbort, { once: true });
        });
      };

      manager.startDeviceScan.mockImplementationOnce(
        (
          _services: unknown,
          _options: unknown,
          callback: (error: { message: string } | null, device: unknown) => void,
        ) => callback({ message: 'radio failed' }, null),
      );
      const failedScan = new RNQuantumBluetoothTransport(picker).requestAndConnect('m');
      await expect(failedScan).rejects.toThrow('BLE scan failed: radio failed');
      expect(pickerSignals[0]?.aborted).toBe(true);

      manager.startDeviceScan.mockImplementationOnce(() => {});
      const timedOutScan = new RNQuantumBluetoothTransport(picker).requestAndConnect('m');
      const timedOutExpectation = expect(timedOutScan).rejects.toThrow('No Quantum controllers found');
      await vi.advanceTimersByTimeAsync(SCAN_TIMEOUT_MS);
      await timedOutExpectation;
      expect(pickerSignals[1]?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('receives complete FFF1 values newer than the explicit roster request', async () => {
    const controller = setupController();
    await controller.adapter.requestAndConnect('m');
    const frame = rosterFrame();

    await controller.adapter.writeFrame(encodeQuantumRosterRequest());
    const pending = controller.adapter.waitForNotification(1_000);
    controller.emitNotification(frame);

    await expect(pending).resolves.toEqual(frame);
  });

  it('fails closed when FFF5 metadata does not match the selected model', async () => {
    const controller = setupController({ metadataBytes: metadata(0, 15, 15) });
    await expect(controller.adapter.requestAndConnect('m')).rejects.toThrow('does not match');
    expect(manager.cancelDeviceConnection).toHaveBeenCalledWith('quantum-device');
  });

  it('retires a physical link that resolves after the connection attempt is cancelled', async () => {
    const controller = setupController();
    let resolveConnection!: (device: typeof controller.connectedDevice) => void;
    manager.connectToDevice.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveConnection = resolve;
      }),
    );

    const connection = controller.adapter.requestAndConnect('m');
    await vi.waitFor(() => expect(manager.connectToDevice).toHaveBeenCalledOnce());
    await controller.adapter.disconnect();
    resolveConnection(controller.connectedDevice);

    await expect(connection).rejects.toThrow('connection attempt cancelled');
    expect(manager.cancelDeviceConnection).toHaveBeenCalledWith('quantum-device');
  });

  it.each(['success', 'failure'] as const)(
    'does not tear down another adapter owning the same device after late setup %s',
    async (outcome) => {
      const first = setupController();
      let finishMetadata!: (characteristic: { value: string }) => void;
      let failMetadata!: (error: Error) => void;
      first.metadataRead.mockReturnValueOnce(
        new Promise((resolve, reject) => {
          finishMetadata = resolve;
          failMetadata = reject;
        }),
      );
      const firstConnect = first.adapter.requestAndConnect('m');
      const firstRejected = expect(firstConnect).rejects.toThrow(
        outcome === 'success' ? 'cancelled' : 'old setup rejected',
      );
      await vi.waitFor(() => expect(first.metadataRead).toHaveBeenCalledOnce());
      await first.adapter.disconnect();
      const second = setupController();
      await second.adapter.requestAndConnect('m');
      const firstTransactionId = first.metadataRead.mock.calls[0]?.[0];
      const secondTransactionId = second.metadataRead.mock.calls[0]?.[0];
      expect(firstTransactionId).not.toBe(secondTransactionId);
      const disconnects = manager.cancelDeviceConnection.mock.calls.length;
      const scanStops = manager.stopDeviceScan.mock.calls.length;
      manager.cancelTransaction.mockClear();
      if (outcome === 'success') finishMetadata({ value: base64(metadata(1, 12, 12)) });
      else failMetadata(new Error('old setup rejected'));
      await firstRejected;
      expect(manager.cancelDeviceConnection).toHaveBeenCalledTimes(disconnects);
      expect(manager.stopDeviceScan).toHaveBeenCalledTimes(scanStops);
      expect(manager.cancelTransaction).not.toHaveBeenCalledWith(secondTransactionId);
      await second.adapter.writeFrame(encodeQuantumRosterRequest());
      expect(second.writeWithResponse).toHaveBeenCalledOnce();
    },
  );

  it.each(['quantum-device', 'unrelated-device'])(
    'cleans up a late orphaned connect only while its physical device is still unclaimed (%s)',
    async (replacementDeviceId) => {
      const first = setupController();
      let finishConnection!: (device: typeof first.connectedDevice) => void;
      manager.connectToDevice.mockReturnValueOnce(
        new Promise((resolve) => {
          finishConnection = resolve;
        }),
      );
      const firstConnect = first.adapter.requestAndConnect('m');
      const firstRejected = expect(firstConnect).rejects.toThrow('cancelled');
      await vi.waitFor(() => expect(manager.connectToDevice).toHaveBeenCalledOnce());
      await first.adapter.disconnect();
      const second = setupController({ deviceId: replacementDeviceId });
      await second.adapter.requestAndConnect('m');
      manager.cancelDeviceConnection.mockClear();
      finishConnection(first.connectedDevice);
      await firstRejected;
      if (replacementDeviceId === 'quantum-device') expect(manager.cancelDeviceConnection).not.toHaveBeenCalled();
      else expect(manager.cancelDeviceConnection).toHaveBeenCalledExactlyOnceWith('quantum-device');
      await second.adapter.readState();
      expect(second.stateRead).toHaveBeenCalledOnce();
    },
  );

  it('keeps a replacement scan alive when another adapter cancels and receives late scan errors', async () => {
    manager.startDeviceScan.mockImplementation(() => {});
    const picker: DevicePickerFn = (_subscribe, _search, signal) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    const first = new RNQuantumBluetoothTransport(picker);
    const second = new RNQuantumBluetoothTransport(picker);
    const firstConnect = first.requestAndConnect('m');
    const firstRejected = expect(firstConnect).rejects.toThrow('cancelled');
    await vi.waitFor(() => expect(manager.startDeviceScan).toHaveBeenCalledOnce());
    const secondConnect = second.requestAndConnect('m');
    const secondRejected = expect(secondConnect).rejects.toThrow('cancelled');
    await vi.waitFor(() => expect(manager.startDeviceScan).toHaveBeenCalledTimes(2));
    await firstRejected;
    await first.disconnect();
    const firstScanCallback = manager.startDeviceScan.mock.calls[0]?.[2] as (
      error: { message: string },
      device: null,
    ) => void;
    firstScanCallback({ message: 'old scan failed late' }, null);
    expect(manager.stopDeviceScan).not.toHaveBeenCalled();
    await second.disconnect();
    await secondRejected;
    expect(manager.stopDeviceScan).toHaveBeenCalled();
  });

  it('does not cancel a replacement adapter transaction when an old setup times out', async () => {
    vi.useFakeTimers();
    try {
      const first = setupController({ hangMetadataRead: true });
      const firstConnect = first.adapter.requestAndConnect('m');
      const firstRejected = expect(firstConnect).rejects.toThrow('metadata read timed out');
      await vi.advanceTimersByTimeAsync(0);
      expect(first.metadataRead).toHaveBeenCalledOnce();
      await first.adapter.disconnect();
      await vi.advanceTimersByTimeAsync(1_000);
      const second = setupController();
      await second.adapter.requestAndConnect('m');
      let finishRead!: (characteristic: { value: string }) => void;
      second.stateRead.mockReturnValueOnce(
        new Promise((resolve) => {
          finishRead = resolve;
        }),
      );
      const secondRead = second.adapter.readState();
      await vi.advanceTimersByTimeAsync(0);
      const oldTransactionId = first.metadataRead.mock.calls[0]?.[0];
      const newTransactionId = second.stateRead.mock.calls[0]?.[0];
      expect(oldTransactionId).not.toBe(newTransactionId);
      manager.cancelTransaction.mockClear();
      manager.cancelDeviceConnection.mockClear();
      await vi.advanceTimersByTimeAsync(4_000);
      await firstRejected;
      expect(manager.cancelTransaction).not.toHaveBeenCalled();
      expect(manager.cancelDeviceConnection).not.toHaveBeenCalled();
      finishRead({ value: base64(rosterFrame()) });
      await expect(secondRead).resolves.toEqual(rosterFrame());
    } finally {
      vi.useRealTimers();
    }
  });

  it('fences queued GATT work and disconnect from a superseded live adapter', async () => {
    const first = setupController();
    await first.adapter.requestAndConnect('m');
    const second = setupController();
    await second.adapter.requestAndConnect('m');
    manager.cancelDeviceConnection.mockClear();
    await expect(first.adapter.writeFrame(encodeQuantumRosterRequest())).rejects.toThrow('not connected');
    expect(first.writeWithResponse).not.toHaveBeenCalled();
    await first.adapter.disconnect();
    expect(manager.cancelDeviceConnection).not.toHaveBeenCalled();
    await second.adapter.writeFrame(encodeQuantumRosterRequest());
    expect(second.writeWithResponse).toHaveBeenCalledOnce();
  });

  it('waits for an already-issued physical cancellation before connecting a replacement adapter', async () => {
    const first = setupController();
    await first.adapter.requestAndConnect('m');
    let finishCancellation!: () => void;
    manager.cancelDeviceConnection.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishCancellation = resolve;
      }),
    );
    const disconnecting = first.adapter.disconnect();
    await vi.waitFor(() => expect(manager.cancelDeviceConnection).toHaveBeenCalledOnce());
    const second = setupController();
    const secondConnect = second.adapter.requestAndConnect('m');
    await vi.waitFor(() => expect(manager.startDeviceScan).toHaveBeenCalledTimes(2));
    expect(manager.connectToDevice).toHaveBeenCalledOnce();
    finishCancellation();
    await disconnecting;
    await secondConnect;
    expect(manager.connectToDevice).toHaveBeenCalledTimes(2);
    await second.adapter.writeFrame(encodeQuantumRosterRequest());
    expect(second.writeWithResponse).toHaveBeenCalledOnce();
  });

  it('tries smaller Android MTUs and uses a single unacknowledged write on binary QBB', async () => {
    const controller = setupController({ deviceName: 'QBB_AABBCCDDEEFF', negotiatedMtu: 185 });
    controller.requestMTU
      .mockRejectedValueOnce(new Error('512 unavailable'))
      .mockRejectedValueOnce(new Error('247 unavailable'));
    await controller.adapter.requestAndConnect('m');
    expect(controller.requestMTU.mock.calls.map(([requestedMtu]) => requestedMtu)).toEqual([512, 247, 185]);
    expect(controller.adapter.maximumWriteBytes).toBe(182);
    await controller.adapter.writeFrame(encodeQuantumRosterRequest());
    expect(controller.writeWithoutResponse).toHaveBeenCalledOnce();
    expect(controller.writeWithResponse).not.toHaveBeenCalled();
  });
  it('probes the current service before the legacy fallback', async () => {
    const controller = setupController();
    await controller.adapter.requestAndConnect('m');
    const discovered = await controller.requestMTU.mock.results[0].value;
    expect(discovered.characteristicsForService.mock.calls.slice(0, 2).map(([uuid]: [string]) => uuid)).toEqual([
      QUANTUM_SERVICE_UUID,
      QUANTUM_LEGACY_SERVICE_UUID,
    ]);
  });

  it('uses CoreBluetooth acknowledged long-write capacity instead of iOS Device.mtu', async () => {
    platform.OS = 'ios';
    const controller = setupController({ connectedMtu: 185, negotiatedMtu: 185 });
    await controller.adapter.requestAndConnect('m');

    const maximumQuantumFrame = Uint8Array.from({ length: 227 }, (_, index) => index & 0xff);
    await controller.adapter.writeFrame(maximumQuantumFrame);

    expect(controller.writeWithResponse).toHaveBeenCalledOnce();
    expect(controller.writeWithResponse).toHaveBeenCalledWith(base64(maximumQuantumFrame), expect.any(String));
    await expect(controller.adapter.writeFrame(new Uint8Array(513))).rejects.toThrow('allows 512');
  });

  it('cancels a hanging Android MTU request and retires the setup connection', async () => {
    vi.useFakeTimers();
    try {
      const controller = setupController({ hangMtuRequest: true });
      const connection = controller.adapter.requestAndConnect('m');
      const rejectedConnection = expect(connection).rejects.toThrow('required Android MTU');
      await vi.advanceTimersByTimeAsync(5_000);

      await rejectedConnection;
      expect(manager.cancelTransaction).toHaveBeenCalledWith(expect.stringMatching(/^quantum-MTU-request-/));
      expect(manager.cancelDeviceConnection).toHaveBeenCalledWith('quantum-device');
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels a hanging service discovery and retires the setup connection', async () => {
    vi.useFakeTimers();
    try {
      const controller = setupController({ hangServiceDiscovery: true });
      const connection = controller.adapter.requestAndConnect('m');
      const rejectedConnection = expect(connection).rejects.toThrow('service discovery timed out');
      await vi.advanceTimersByTimeAsync(5_000);

      await rejectedConnection;
      expect(manager.cancelTransaction).toHaveBeenCalledWith(expect.stringMatching(/^quantum-service-discovery-/));
      expect(manager.cancelDeviceConnection).toHaveBeenCalledWith('quantum-device');
    } finally {
      vi.useRealTimers();
    }
  });

  it('retires a hanging characteristic discovery that has no ble-plx transaction ID', async () => {
    vi.useFakeTimers();
    try {
      const controller = setupController({ hangCharacteristicDiscovery: true });
      const connection = controller.adapter.requestAndConnect('m');
      const rejectedConnection = expect(connection).rejects.toThrow('characteristic discovery timed out');
      await vi.advanceTimersByTimeAsync(5_000);

      await rejectedConnection;
      expect(manager.cancelDeviceConnection).toHaveBeenCalledWith('quantum-device');
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits for notification readiness and retires a link whose CCCD setup hangs', async () => {
    vi.useFakeTimers();
    try {
      const controller = setupController({ hangNotificationSetup: true });
      const connection = controller.adapter.requestAndConnect('m');
      const rejectedConnection = expect(connection).rejects.toThrow('notification setup timed out');
      await vi.advanceTimersByTimeAsync(5_000);

      await rejectedConnection;
      expect(manager.cancelDeviceConnection).toHaveBeenCalledWith('quantum-device');
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels a timed-out metadata read and retires the setup connection', async () => {
    vi.useFakeTimers();
    try {
      const controller = setupController({ hangMetadataRead: true });
      const connection = controller.adapter.requestAndConnect('m');
      const rejectedConnection = expect(connection).rejects.toThrow('metadata read timed out');
      await vi.advanceTimersByTimeAsync(5_000);

      await rejectedConnection;
      const transactionId = controller.metadataRead.mock.calls[0]?.[0] as string;
      expect(transactionId).toMatch(/^quantum-metadata-read-/);
      expect(manager.cancelTransaction).toHaveBeenCalledWith(transactionId);
      expect(manager.cancelDeviceConnection).toHaveBeenCalledWith('quantum-device');
    } finally {
      vi.useRealTimers();
    }
  });

  it('retires the connection when an acknowledged write times out', async () => {
    const controller = setupController({ hangWrite: true });
    await controller.adapter.requestAndConnect('m');
    const disconnected = vi.fn();
    controller.adapter.onDisconnect(disconnected);

    vi.useFakeTimers();
    try {
      const write = controller.adapter.writeFrame(encodeQuantumRosterRequest());
      const rejectedWrite = expect(write).rejects.toThrow('acknowledged write timed out');
      await vi.advanceTimersByTimeAsync(5_000);

      await rejectedWrite;
      expect(manager.cancelTransaction).toHaveBeenCalledWith(expect.stringMatching(/^quantum-acknowledged-write-/));
      expect(manager.cancelDeviceConnection).toHaveBeenCalledWith('quantum-device');
      expect(disconnected).toHaveBeenCalledWith({ description: 'Quantum controller write timed out' });
      await expect(controller.adapter.readState()).rejects.toThrow('not connected');
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels a timed-out FFF4 read and keeps only the FFF1 notification fallback', async () => {
    const controller = setupController({ hangStateRead: true });
    await controller.adapter.requestAndConnect('m');
    await controller.adapter.writeFrame(encodeQuantumRosterRequest());

    vi.useFakeTimers();
    try {
      const read = controller.adapter.readState();
      const rejectedRead = expect(read).rejects.toThrow('state read timed out');
      await vi.advanceTimersByTimeAsync(5_000);
      await rejectedRead;

      const notification = controller.adapter.waitForNotification(1_000);
      controller.emitNotification(rosterFrame());
      await expect(notification).resolves.toEqual(rosterFrame());
      await expect(controller.adapter.readState()).resolves.toBeUndefined();
      expect(controller.stateRead).toHaveBeenCalledOnce();
      expect(manager.cancelDeviceConnection).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('retires the link when neither FFF4 nor FFF1 confirms a roster', async () => {
    const controller = setupController({ hangStateRead: true });
    await controller.adapter.requestAndConnect('m');
    await controller.adapter.writeFrame(encodeQuantumRosterRequest());
    const disconnected = vi.fn();
    controller.adapter.onDisconnect(disconnected);

    vi.useFakeTimers();
    try {
      const read = controller.adapter.readState();
      const rejectedRead = expect(read).rejects.toThrow('state read timed out');
      await vi.advanceTimersByTimeAsync(5_000);
      await rejectedRead;

      const notification = controller.adapter.waitForNotification(1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(notification).resolves.toBeUndefined();

      expect(manager.cancelDeviceConnection).toHaveBeenCalledWith('quantum-device');
      expect(disconnected).toHaveBeenCalledWith({ description: 'Quantum roster notification timed out' });
    } finally {
      vi.useRealTimers();
    }
  });
});
