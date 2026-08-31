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
vi.mock('../ble-manager', () => ({ bleManager: manager }));
vi.mock('../availability', () => ({ waitForBlePoweredOn: vi.fn(async () => true) }));

import { RNQuantumBluetoothTransport } from '../quantum-adapter';

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
  const characteristic = (uuid: string) => ({
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
    id: 'quantum-device',
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
  const requestMTU = vi.fn(() =>
    options.hangMtuRequest ? new Promise<typeof discovered>(() => {}) : Promise.resolve(discovered),
  );
  const connectedDevice = {
    ...discovered,
    id: 'quantum-device',
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
      callback(null, { id: 'quantum-device', localName: 'QB_AABBCCDDEEFF', rssi: -35 });
    },
  );

  const updates: DiscoveredDevice[][] = [];
  const picker: DevicePickerFn = async (subscribe) => {
    subscribe((devices) => updates.push(devices));
    return 'quantum-device';
  };
  return {
    adapter: new RNQuantumBluetoothTransport(picker),
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
  });

  it('filters exact names, negotiates 512, discovers legacy GATT, and writes atomically with response', async () => {
    const controller = setupController();
    const connection = await controller.adapter.requestAndConnect('m');

    expect(connection.serial).toBe('AABBCCDDEEFF');
    expect(connection.metadata.model.id).toBe('m');
    expect(controller.updates.at(-1)?.map((device) => device.deviceId)).toEqual(['quantum-device']);
    expect(controller.requestMTU).toHaveBeenCalledWith(512, expect.stringMatching(/^quantum-MTU-request-/));

    const frame = Uint8Array.from({ length: 227 }, (_, index) => index & 0xff);
    await controller.adapter.writeWithResponse(frame);
    expect(controller.writeWithResponse).toHaveBeenCalledOnce();
    expect(controller.writeWithResponse).toHaveBeenCalledWith(base64(frame), expect.any(String));
  });

  it('aborts the picker contract on scan failure and an empty scan timeout', async () => {
    vi.useFakeTimers();
    try {
      const pickerSignals: AbortSignal[] = [];
      const picker: DevicePickerFn = (_subscribe, signal) => {
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

  it('reassembles FFF1 notifications newer than the explicit roster request', async () => {
    const controller = setupController();
    await controller.adapter.requestAndConnect('m');
    const frame = rosterFrame();

    await controller.adapter.writeWithResponse(encodeQuantumRosterRequest());
    const pending = controller.adapter.waitForNotification(1_000);
    controller.emitNotification(frame.slice(0, 8));
    controller.emitNotification(frame.slice(8));

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
    await controller.adapter.writeWithResponse(maximumQuantumFrame);

    expect(controller.writeWithResponse).toHaveBeenCalledOnce();
    expect(controller.writeWithResponse).toHaveBeenCalledWith(base64(maximumQuantumFrame), expect.any(String));
    await expect(controller.adapter.writeWithResponse(new Uint8Array(513))).rejects.toThrow('allows 512');
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
      const write = controller.adapter.writeWithResponse(encodeQuantumRosterRequest());
      const rejectedWrite = expect(write).rejects.toThrow('acknowledged write timed out');
      await vi.advanceTimersByTimeAsync(5_000);

      await rejectedWrite;
      expect(manager.cancelTransaction).toHaveBeenCalledWith(expect.stringMatching(/^quantum-acknowledged-write-/));
      expect(manager.cancelDeviceConnection).toHaveBeenCalledWith('quantum-device');
      expect(disconnected).toHaveBeenCalledWith({ description: 'Quantum acknowledged write timed out' });
      await expect(controller.adapter.readState()).rejects.toThrow('not connected');
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels a timed-out FFF4 read and keeps only the FFF1 notification fallback', async () => {
    const controller = setupController({ hangStateRead: true });
    await controller.adapter.requestAndConnect('m');
    await controller.adapter.writeWithResponse(encodeQuantumRosterRequest());

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
    await controller.adapter.writeWithResponse(encodeQuantumRosterRequest());
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
