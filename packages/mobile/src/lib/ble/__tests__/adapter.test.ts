import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DevicePickerFn, BoardScanFamily } from '../types';

// ── Hoisted mocks (available inside vi.mock factories) ──────────────────

const mockBleManager = vi.hoisted(() => ({
  state: vi.fn(),
  startDeviceScan: vi.fn(),
  stopDeviceScan: vi.fn(),
  connectToDevice: vi.fn(),
  cancelDeviceConnection: vi.fn(),
  onDeviceDisconnected: vi.fn(),
  onStateChange: vi.fn(),
}));

// ── Module mocks ────────────────────────────────────────────────────────

vi.mock('react-native-ble-plx', () => ({
  BleManager: vi.fn(),
  State: {
    PoweredOn: 'PoweredOn',
    PoweredOff: 'PoweredOff',
    Unknown: 'Unknown',
    Resetting: 'Resetting',
    Unauthorized: 'Unauthorized',
    Unsupported: 'Unsupported',
  },
}));

vi.mock('../ble-manager', () => ({
  bleManager: mockBleManager,
}));

vi.mock('@boardsesh/ble-protocol', () => ({
  AURORA_ADVERTISED_SERVICE_UUID: 'aurora-uuid',
  UART_SERVICE_UUID: 'uart-uuid',
  UART_WRITE_CHARACTERISTIC_UUID: 'uart-write-uuid',
  REDBEARLAB_SERVICE_UUID: 'redbearlab-uuid',
  REDBEARLAB_WRITE_CHARACTERISTIC_UUID: 'redbearlab-write-uuid',
  splitMessages: vi.fn((passedData: Uint8Array) => [passedData]),
  INTER_CHUNK_DELAY_MS: 0,
  parseSerialNumber: vi.fn(),
}));

// ── Import after mocks ─────────────────────────────────────────────────

import { RNBleAdapter } from '../adapter';
import { SCAN_TIMEOUT_MS, SERIAL_RECONNECT_GRACE_MS } from '@boardsesh/ble-protocol/scan-constants';
import { splitMessages } from '@boardsesh/ble-protocol';
import { State } from 'react-native-ble-plx';

// ── Helpers ─────────────────────────────────────────────────────────────

function createMockDevicePicker(): DevicePickerFn {
  return vi.fn();
}

// Wires up the scan → auto-pick → connect → discover flow for a single board so
// a test only has to supply the per-service characteristic lookup. The adapter
// is returned NOT yet connected so callers can either await
// requestAndConnect() (success) or assert on its rejection (no write char).
function setupConnectableAdapter(
  family: BoardScanFamily,
  deviceId: string,
  characteristicsForService: ReturnType<typeof vi.fn>,
): RNBleAdapter {
  mockBleManager.cancelDeviceConnection.mockResolvedValue(undefined);
  mockBleManager.onDeviceDisconnected.mockReturnValue({ remove: vi.fn() });

  // MoonBoards advertise no service UUID (unfiltered scan); Aurora boards carry
  // the advertised service so they survive the UUID-filtered scan.
  const scanName = family === 'aurora' ? 'Kilter Board#TEST@3' : 'MoonBoard A1';
  const serviceUUIDs = family === 'aurora' ? ['aurora-uuid'] : undefined;
  mockBleManager.startDeviceScan.mockImplementation(
    (_uuids: unknown, _opts: unknown, callback: (error: unknown, device: unknown) => void) => {
      callback(null, { id: deviceId, localName: scanName, name: scanName, rssi: -40, serviceUUIDs });
    },
  );

  const mockDeviceWithServices = {
    id: deviceId,
    characteristicsForService,
    requestMTU: vi.fn().mockResolvedValue(undefined),
    discoverAllServicesAndCharacteristics: vi.fn().mockReturnThis(),
  };
  mockBleManager.connectToDevice.mockResolvedValue({
    id: deviceId,
    requestMTU: vi.fn().mockResolvedValue(undefined),
    discoverAllServicesAndCharacteristics: vi.fn().mockReturnValue(mockDeviceWithServices),
  });

  return new RNBleAdapter(() => Promise.resolve(deviceId), family);
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('RNBleAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBleManager.onStateChange.mockReturnValue({ remove: vi.fn() });
  });

  describe('isAvailable', () => {
    it('returns true when bluetooth state is PoweredOn', async () => {
      mockBleManager.state.mockResolvedValue(State.PoweredOn);
      const adapter = new RNBleAdapter(createMockDevicePicker());

      const available = await adapter.isAvailable();

      expect(available).toBe(true);
      expect(mockBleManager.state).toHaveBeenCalledOnce();
    });

    it('returns false when bluetooth state is PoweredOff', async () => {
      mockBleManager.state.mockResolvedValue(State.PoweredOff);
      const adapter = new RNBleAdapter(createMockDevicePicker());

      const available = await adapter.isAvailable();

      expect(available).toBe(false);
    });

    it('returns false when bluetooth state is Unknown', async () => {
      vi.useFakeTimers();
      try {
        mockBleManager.state.mockResolvedValue(State.Unknown);
        const adapter = new RNBleAdapter(createMockDevicePicker());

        const availablePromise = adapter.isAvailable();
        await vi.advanceTimersByTimeAsync(2_500);
        const available = await availablePromise;

        expect(available).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('waits for transient bluetooth state to become PoweredOn', async () => {
      vi.useFakeTimers();
      try {
        const stateListeners: Array<(state: State) => void> = [];
        const removeListener = vi.fn();
        mockBleManager.state.mockResolvedValue(State.Unknown);
        mockBleManager.onStateChange.mockImplementation((listener: (state: State) => void) => {
          stateListeners.push(listener);
          return { remove: removeListener };
        });
        const adapter = new RNBleAdapter(createMockDevicePicker());

        const availablePromise = adapter.isAvailable();
        await Promise.resolve();
        expect(stateListeners).toHaveLength(1);
        stateListeners[0](State.PoweredOn);

        await expect(availablePromise).resolves.toBe(true);
        expect(removeListener).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
      }
    });

    it('returns false when state() throws', async () => {
      mockBleManager.state.mockRejectedValue(new Error('BLE not supported'));
      const adapter = new RNBleAdapter(createMockDevicePicker());

      const available = await adapter.isAvailable();

      expect(available).toBe(false);
    });
  });

  describe('disconnect', () => {
    it('cancels device connection when connected', async () => {
      mockBleManager.cancelDeviceConnection.mockResolvedValue(undefined);

      // Simulate a connected state by setting internal properties via
      // the requestAndConnect flow. We'll use a simplified approach by
      // directly testing disconnect after a mock connection.
      // To do this properly, we need to set up the adapter's internal
      // connectedDevice. We'll access it through a successful connect flow.

      // Set up mocks for a successful connection
      const mockCharacteristic = {
        uuid: 'uart-write-uuid',
        writeWithoutResponse: vi.fn().mockResolvedValue(undefined),
      };

      const mockDeviceWithServices = {
        id: 'test-device-id',
        characteristicsForService: vi.fn().mockResolvedValue([mockCharacteristic]),
        requestMTU: vi.fn().mockResolvedValue(undefined),
        discoverAllServicesAndCharacteristics: vi.fn().mockReturnThis(),
      };

      const mockConnectedDevice = {
        id: 'test-device-id',
        requestMTU: vi.fn().mockResolvedValue(undefined),
        discoverAllServicesAndCharacteristics: vi.fn().mockReturnValue(mockDeviceWithServices),
      };

      mockBleManager.connectToDevice.mockResolvedValue(mockConnectedDevice);
      mockBleManager.onDeviceDisconnected.mockReturnValue({ remove: vi.fn() });

      const devicePicker: DevicePickerFn = (subscribe) => {
        // Simulate scan finding a device, then immediately selecting it
        mockBleManager.startDeviceScan.mockImplementation(
          (_uuids: unknown, _opts: unknown, callback: (error: unknown, device: unknown) => void) => {
            callback(null, {
              id: 'test-device-id',
              localName: 'TestBoard',
              name: 'TestBoard',
              rssi: -50,
              serviceUUIDs: ['aurora-uuid'],
            });
          },
        );
        subscribe((devices) => {
          if (devices.length > 0) {
            // Auto-select first device
          }
        });
        return Promise.resolve('test-device-id');
      };

      const adapterWithConnection = new RNBleAdapter(devicePicker);
      await adapterWithConnection.requestAndConnect();

      // Now disconnect
      await adapterWithConnection.disconnect();

      expect(mockBleManager.cancelDeviceConnection).toHaveBeenCalledWith('test-device-id');
    });

    it('handles already-disconnected gracefully', async () => {
      mockBleManager.cancelDeviceConnection.mockRejectedValue(new Error('Device already disconnected'));

      const adapter = new RNBleAdapter(createMockDevicePicker());

      // Disconnect on an adapter with no connection should not throw
      await expect(adapter.disconnect()).resolves.toBeUndefined();
    });

    it('does not throw when cancelDeviceConnection fails', async () => {
      // Set up a connected adapter
      const mockCharacteristic = {
        uuid: 'uart-write-uuid',
        writeWithoutResponse: vi.fn().mockResolvedValue(undefined),
      };

      const mockDeviceWithServices = {
        id: 'device-1',
        characteristicsForService: vi.fn().mockResolvedValue([mockCharacteristic]),
        requestMTU: vi.fn().mockResolvedValue(undefined),
        discoverAllServicesAndCharacteristics: vi.fn().mockReturnThis(),
      };

      const mockConnectedDevice = {
        id: 'device-1',
        requestMTU: vi.fn().mockResolvedValue(undefined),
        discoverAllServicesAndCharacteristics: vi.fn().mockReturnValue(mockDeviceWithServices),
      };

      mockBleManager.connectToDevice.mockResolvedValue(mockConnectedDevice);
      mockBleManager.onDeviceDisconnected.mockReturnValue({ remove: vi.fn() });
      mockBleManager.cancelDeviceConnection.mockRejectedValue(new Error('BLE stack error'));

      const devicePicker: DevicePickerFn = () => Promise.resolve('device-1');
      const adapter = new RNBleAdapter(devicePicker);

      mockBleManager.startDeviceScan.mockImplementation(
        (_uuids: unknown, _opts: unknown, callback: (error: unknown, device: unknown) => void) => {
          callback(null, {
            id: 'device-1',
            localName: 'Kilter Board#TEST@3',
            name: 'Kilter Board#TEST@3',
            rssi: -40,
            serviceUUIDs: ['aurora-uuid'],
          });
        },
      );

      await adapter.requestAndConnect();

      // disconnect should swallow the cancelDeviceConnection error
      await expect(adapter.disconnect()).resolves.toBeUndefined();
    });
  });

  describe('write', () => {
    it('writes data chunks to the characteristic', async () => {
      const mockWriteFn = vi.fn().mockResolvedValue(undefined);
      const mockCharacteristic = {
        uuid: 'uart-write-uuid',
        writeWithoutResponse: mockWriteFn,
      };

      const mockDeviceWithServices = {
        id: 'write-device',
        characteristicsForService: vi.fn().mockResolvedValue([mockCharacteristic]),
        requestMTU: vi.fn().mockResolvedValue(undefined),
        discoverAllServicesAndCharacteristics: vi.fn().mockReturnThis(),
      };

      const mockConnectedDevice = {
        id: 'write-device',
        requestMTU: vi.fn().mockResolvedValue(undefined),
        discoverAllServicesAndCharacteristics: vi.fn().mockReturnValue(mockDeviceWithServices),
      };

      mockBleManager.connectToDevice.mockResolvedValue(mockConnectedDevice);
      mockBleManager.onDeviceDisconnected.mockReturnValue({ remove: vi.fn() });
      mockBleManager.startDeviceScan.mockImplementation(
        (_uuids: unknown, _opts: unknown, callback: (error: unknown, device: unknown) => void) => {
          callback(null, {
            id: 'write-device',
            localName: 'Kilter Board#TEST@3',
            name: 'Kilter Board#TEST@3',
            rssi: -40,
            serviceUUIDs: ['aurora-uuid'],
          });
        },
      );

      const devicePicker: DevicePickerFn = () => Promise.resolve('write-device');
      const adapter = new RNBleAdapter(devicePicker);
      await adapter.requestAndConnect();

      const testData = new Uint8Array([0x01, 0x02, 0x03]);
      vi.mocked(splitMessages).mockReturnValue([testData]);

      await adapter.write(testData);

      expect(splitMessages).toHaveBeenCalledWith(testData);
      expect(mockWriteFn).toHaveBeenCalledOnce();
      // The written value should be base64-encoded
      expect(mockWriteFn).toHaveBeenCalledWith(expect.stringMatching(/^[A-Za-z0-9+/=]+$/));
    });

    it('splits messages and writes multiple chunks', async () => {
      const mockWriteFn = vi.fn().mockResolvedValue(undefined);
      const mockCharacteristic = {
        uuid: 'uart-write-uuid',
        writeWithoutResponse: mockWriteFn,
      };

      const mockDeviceWithServices = {
        id: 'chunk-device',
        characteristicsForService: vi.fn().mockResolvedValue([mockCharacteristic]),
        requestMTU: vi.fn().mockResolvedValue(undefined),
        discoverAllServicesAndCharacteristics: vi.fn().mockReturnThis(),
      };

      const mockConnectedDevice = {
        id: 'chunk-device',
        requestMTU: vi.fn().mockResolvedValue(undefined),
        discoverAllServicesAndCharacteristics: vi.fn().mockReturnValue(mockDeviceWithServices),
      };

      mockBleManager.connectToDevice.mockResolvedValue(mockConnectedDevice);
      mockBleManager.onDeviceDisconnected.mockReturnValue({ remove: vi.fn() });
      mockBleManager.startDeviceScan.mockImplementation(
        (_uuids: unknown, _opts: unknown, callback: (error: unknown, device: unknown) => void) => {
          callback(null, {
            id: 'chunk-device',
            localName: 'Kilter Board#TEST@3',
            name: 'Kilter Board#TEST@3',
            rssi: -40,
            serviceUUIDs: ['aurora-uuid'],
          });
        },
      );

      const devicePicker: DevicePickerFn = () => Promise.resolve('chunk-device');
      const adapter = new RNBleAdapter(devicePicker);
      await adapter.requestAndConnect();

      const chunk1 = new Uint8Array([0x01, 0x02]);
      const chunk2 = new Uint8Array([0x03, 0x04]);
      const chunk3 = new Uint8Array([0x05, 0x06]);
      vi.mocked(splitMessages).mockReturnValue([chunk1, chunk2, chunk3]);

      await adapter.write(new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05, 0x06]));

      expect(mockWriteFn).toHaveBeenCalledTimes(3);
    });

    it('throws when not connected', async () => {
      const adapter = new RNBleAdapter(createMockDevicePicker());

      await expect(adapter.write(new Uint8Array([0x01]))).rejects.toThrow('Not connected');
    });

    it('respects AbortSignal', async () => {
      const mockWriteFn = vi.fn().mockResolvedValue(undefined);
      const mockCharacteristic = {
        uuid: 'uart-write-uuid',
        writeWithoutResponse: mockWriteFn,
      };

      const mockDeviceWithServices = {
        id: 'abort-device',
        characteristicsForService: vi.fn().mockResolvedValue([mockCharacteristic]),
        requestMTU: vi.fn().mockResolvedValue(undefined),
        discoverAllServicesAndCharacteristics: vi.fn().mockReturnThis(),
      };

      const mockConnectedDevice = {
        id: 'abort-device',
        requestMTU: vi.fn().mockResolvedValue(undefined),
        discoverAllServicesAndCharacteristics: vi.fn().mockReturnValue(mockDeviceWithServices),
      };

      mockBleManager.connectToDevice.mockResolvedValue(mockConnectedDevice);
      mockBleManager.onDeviceDisconnected.mockReturnValue({ remove: vi.fn() });
      mockBleManager.startDeviceScan.mockImplementation(
        (_uuids: unknown, _opts: unknown, callback: (error: unknown, device: unknown) => void) => {
          callback(null, {
            id: 'abort-device',
            localName: 'Kilter Board#TEST@3',
            name: 'Kilter Board#TEST@3',
            rssi: -40,
            serviceUUIDs: ['aurora-uuid'],
          });
        },
      );

      const devicePicker: DevicePickerFn = () => Promise.resolve('abort-device');
      const adapter = new RNBleAdapter(devicePicker);
      await adapter.requestAndConnect();

      const chunk1 = new Uint8Array([0x01]);
      const chunk2 = new Uint8Array([0x02]);
      vi.mocked(splitMessages).mockReturnValue([chunk1, chunk2]);

      const abortController = new AbortController();
      // Abort before writing
      abortController.abort();

      await expect(adapter.write(new Uint8Array([0x01, 0x02]), abortController.signal)).rejects.toThrow(
        'Write aborted',
      );

      // No chunks should have been written since signal was aborted before start
      expect(mockWriteFn).not.toHaveBeenCalled();
    });

    it('does not write the next chunk when aborted during the inter-chunk delay', async () => {
      vi.useFakeTimers();
      try {
        const mockWriteFn = vi.fn().mockResolvedValue(undefined);
        const mockCharacteristic = {
          uuid: 'uart-write-uuid',
          writeWithoutResponse: mockWriteFn,
        };

        const mockDeviceWithServices = {
          id: 'abort-delay-device',
          characteristicsForService: vi.fn().mockResolvedValue([mockCharacteristic]),
          requestMTU: vi.fn().mockResolvedValue(undefined),
          discoverAllServicesAndCharacteristics: vi.fn().mockReturnThis(),
        };

        const mockConnectedDevice = {
          id: 'abort-delay-device',
          requestMTU: vi.fn().mockResolvedValue(undefined),
          discoverAllServicesAndCharacteristics: vi.fn().mockReturnValue(mockDeviceWithServices),
        };

        mockBleManager.connectToDevice.mockResolvedValue(mockConnectedDevice);
        mockBleManager.onDeviceDisconnected.mockReturnValue({ remove: vi.fn() });
        mockBleManager.startDeviceScan.mockImplementation(
          (_uuids: unknown, _opts: unknown, callback: (error: unknown, device: unknown) => void) => {
            callback(null, {
              id: 'abort-delay-device',
              localName: 'Kilter Board#TEST@3',
              name: 'Kilter Board#TEST@3',
              rssi: -40,
              serviceUUIDs: ['aurora-uuid'],
            });
          },
        );

        const adapter = new RNBleAdapter(() => Promise.resolve('abort-delay-device'));
        await adapter.requestAndConnect();

        const chunk1 = new Uint8Array([0x01]);
        const chunk2 = new Uint8Array([0x02]);
        vi.mocked(splitMessages).mockReturnValue([chunk1, chunk2]);

        const abortController = new AbortController();
        const writePromise = adapter.write(new Uint8Array([0x01, 0x02]), abortController.signal);
        await Promise.resolve();
        await Promise.resolve();

        expect(mockWriteFn).toHaveBeenCalledTimes(1);
        const writeExpectation = expect(writePromise).rejects.toThrow('Write aborted');
        abortController.abort();
        await vi.runAllTimersAsync();

        await writeExpectation;
        expect(mockWriteFn).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('normalises a write failure to the disconnect signature when the link is gone', async () => {
      // react-native-ble-plx surfaces a mid-write drop as a CharacteristicWriteFailed
      // BleError that doesn't name the disconnect. The adapter probes the live
      // link; when the device is actually gone it normalises to the message the
      // write-failure path keys on so the lightbulb darkens.
      const writeFailure = new Error('Characteristic ABCD write failed for device 5C:F8');
      const mockWriteFn = vi.fn().mockRejectedValue(writeFailure);
      const isConnectedFn = vi.fn().mockResolvedValue(false);
      const mockCharacteristic = { uuid: 'uart-write-uuid', writeWithoutResponse: mockWriteFn };

      const mockDeviceWithServices = {
        id: 'drop-device',
        isConnected: isConnectedFn,
        characteristicsForService: vi.fn().mockResolvedValue([mockCharacteristic]),
        requestMTU: vi.fn().mockResolvedValue(undefined),
        discoverAllServicesAndCharacteristics: vi.fn().mockReturnThis(),
      };
      const mockConnectedDevice = {
        id: 'drop-device',
        requestMTU: vi.fn().mockResolvedValue(undefined),
        discoverAllServicesAndCharacteristics: vi.fn().mockReturnValue(mockDeviceWithServices),
      };

      mockBleManager.connectToDevice.mockResolvedValue(mockConnectedDevice);
      mockBleManager.onDeviceDisconnected.mockReturnValue({ remove: vi.fn() });
      mockBleManager.startDeviceScan.mockImplementation(
        (_uuids: unknown, _opts: unknown, callback: (error: unknown, device: unknown) => void) => {
          callback(null, {
            id: 'drop-device',
            localName: 'Kilter Board#TEST@3',
            name: 'Kilter Board#TEST@3',
            rssi: -40,
            serviceUUIDs: ['aurora-uuid'],
          });
        },
      );

      const adapter = new RNBleAdapter(() => Promise.resolve('drop-device'));
      await adapter.requestAndConnect();

      const data = new Uint8Array([0x01]);
      vi.mocked(splitMessages).mockReturnValue([data]);

      await expect(adapter.write(data)).rejects.toThrow('Device disconnected during write');
      expect(isConnectedFn).toHaveBeenCalledOnce();
    });

    it('rethrows the original error when the link is still alive after a write failure', async () => {
      // A genuine transient write failure on a live link must NOT be normalised
      // to a disconnect — otherwise it would falsely darken the lightbulb.
      const writeFailure = new Error('Characteristic ABCD write failed for device 5C:F8');
      const mockWriteFn = vi.fn().mockRejectedValue(writeFailure);
      const isConnectedFn = vi.fn().mockResolvedValue(true);
      const mockCharacteristic = { uuid: 'uart-write-uuid', writeWithoutResponse: mockWriteFn };

      const mockDeviceWithServices = {
        id: 'live-device',
        isConnected: isConnectedFn,
        characteristicsForService: vi.fn().mockResolvedValue([mockCharacteristic]),
        requestMTU: vi.fn().mockResolvedValue(undefined),
        discoverAllServicesAndCharacteristics: vi.fn().mockReturnThis(),
      };
      const mockConnectedDevice = {
        id: 'live-device',
        requestMTU: vi.fn().mockResolvedValue(undefined),
        discoverAllServicesAndCharacteristics: vi.fn().mockReturnValue(mockDeviceWithServices),
      };

      mockBleManager.connectToDevice.mockResolvedValue(mockConnectedDevice);
      mockBleManager.onDeviceDisconnected.mockReturnValue({ remove: vi.fn() });
      mockBleManager.startDeviceScan.mockImplementation(
        (_uuids: unknown, _opts: unknown, callback: (error: unknown, device: unknown) => void) => {
          callback(null, {
            id: 'live-device',
            localName: 'Kilter Board#TEST@3',
            name: 'Kilter Board#TEST@3',
            rssi: -40,
            serviceUUIDs: ['aurora-uuid'],
          });
        },
      );

      const adapter = new RNBleAdapter(() => Promise.resolve('live-device'));
      await adapter.requestAndConnect();

      const data = new Uint8Array([0x01]);
      vi.mocked(splitMessages).mockReturnValue([data]);

      await expect(adapter.write(data)).rejects.toThrow(writeFailure);
      expect(isConnectedFn).toHaveBeenCalledOnce();
    });
  });

  describe('requestAndConnect — scan filtering', () => {
    it('scans unfiltered and filters results in JS so MoonBoards surface', async () => {
      mockBleManager.onDeviceDisconnected.mockReturnValue({ remove: vi.fn() });
      mockBleManager.startDeviceScan.mockImplementation(
        (_uuids: unknown, _opts: unknown, callback: (error: unknown, device: unknown) => void) => {
          // A MoonBoard advertising no service UUIDs (the case a UUID-filtered
          // scan would never see), plus an unrelated speaker that must not
          // reach the picker.
          callback(null, { id: 'moon-device', localName: 'MoonBoard A1', name: 'MoonBoard A1', rssi: -42 });
          callback(null, { id: 'speaker', localName: 'JBL Flip 6', name: 'JBL Flip 6', rssi: -30 });
        },
      );

      const seenDevices: Array<{ deviceId: string }> = [];
      const devicePicker: DevicePickerFn = (subscribe) => {
        subscribe((devices) => {
          seenDevices.splice(0, seenDevices.length, ...devices);
        });
        return Promise.resolve('moon-device');
      };

      const mockCharacteristic = { uuid: 'uart-write-uuid', writeWithoutResponse: vi.fn() };
      const mockDeviceWithServices = {
        id: 'moon-device',
        characteristicsForService: vi.fn().mockResolvedValue([mockCharacteristic]),
        requestMTU: vi.fn().mockResolvedValue(undefined),
        discoverAllServicesAndCharacteristics: vi.fn().mockReturnThis(),
      };
      mockBleManager.connectToDevice.mockResolvedValue({
        id: 'moon-device',
        requestMTU: vi.fn().mockResolvedValue(undefined),
        discoverAllServicesAndCharacteristics: vi.fn().mockReturnValue(mockDeviceWithServices),
      });

      const adapter = new RNBleAdapter(devicePicker, 'moonboard');
      await adapter.requestAndConnect();

      // Unfiltered scan: UUID filter must be null (a service filter hides MoonBoards).
      expect(mockBleManager.startDeviceScan).toHaveBeenCalledWith(null, null, expect.any(Function));
      expect(seenDevices.map((device) => device.deviceId)).toEqual(['moon-device']);
    });

    it('uses the Aurora service filter and rejects non-board peripherals on Aurora scans', async () => {
      mockBleManager.onDeviceDisconnected.mockReturnValue({ remove: vi.fn() });
      mockBleManager.startDeviceScan.mockImplementation(
        (_uuids: unknown, _opts: unknown, callback: (error: unknown, device: unknown) => void) => {
          callback(null, { id: 'airpods', localName: "Marco's AirPods #1", name: "Marco's AirPods #1", rssi: -20 });
          callback(null, {
            id: 'kilter-device',
            localName: 'Kilter Board#751737@3',
            name: 'Kilter Board#751737@3',
            rssi: -45,
            serviceUUIDs: ['aurora-uuid'],
          });
        },
      );

      const seenDevices: Array<{ deviceId: string }> = [];
      const devicePicker: DevicePickerFn = (subscribe) => {
        subscribe((devices) => {
          seenDevices.splice(0, seenDevices.length, ...devices);
        });
        return Promise.resolve('kilter-device');
      };

      const mockCharacteristic = { uuid: 'uart-write-uuid', writeWithoutResponse: vi.fn() };
      const mockDeviceWithServices = {
        id: 'kilter-device',
        characteristicsForService: vi.fn().mockResolvedValue([mockCharacteristic]),
        requestMTU: vi.fn().mockResolvedValue(undefined),
        discoverAllServicesAndCharacteristics: vi.fn().mockReturnThis(),
      };
      mockBleManager.connectToDevice.mockResolvedValue({
        id: 'kilter-device',
        requestMTU: vi.fn().mockResolvedValue(undefined),
        discoverAllServicesAndCharacteristics: vi.fn().mockReturnValue(mockDeviceWithServices),
      });

      const adapter = new RNBleAdapter(devicePicker, 'aurora');
      await adapter.requestAndConnect();

      expect(mockBleManager.startDeviceScan).toHaveBeenCalledWith(['aurora-uuid'], null, expect.any(Function));
      expect(seenDevices.map((device) => device.deviceId)).toEqual(['kilter-device']);
    });

    it('deduplicates repeated board names even when the native device id changes', async () => {
      mockBleManager.onDeviceDisconnected.mockReturnValue({ remove: vi.fn() });
      mockBleManager.startDeviceScan.mockImplementation(
        (_uuids: unknown, _opts: unknown, callback: (error: unknown, device: unknown) => void) => {
          callback(null, {
            id: 'first-native-id',
            localName: 'Kilter Board#751737@3',
            name: 'Kilter Board#751737@3',
            rssi: -45,
            serviceUUIDs: ['aurora-uuid'],
          });
          callback(null, {
            id: 'second-native-id',
            localName: 'Kilter Board#751737@3',
            name: 'Kilter Board#751737@3',
            rssi: -40,
            serviceUUIDs: ['aurora-uuid'],
          });
        },
      );

      const seenDeviceIdsByUpdate: string[][] = [];
      const devicePicker: DevicePickerFn = (subscribe) => {
        subscribe((devices) => {
          seenDeviceIdsByUpdate.push(devices.map((device) => device.deviceId));
        });
        return Promise.resolve('second-native-id');
      };

      const mockCharacteristic = { uuid: 'uart-write-uuid', writeWithoutResponse: vi.fn() };
      const mockDeviceWithServices = {
        id: 'second-native-id',
        characteristicsForService: vi.fn().mockResolvedValue([mockCharacteristic]),
        requestMTU: vi.fn().mockResolvedValue(undefined),
        discoverAllServicesAndCharacteristics: vi.fn().mockReturnThis(),
      };
      mockBleManager.connectToDevice.mockResolvedValue({
        id: 'second-native-id',
        requestMTU: vi.fn().mockResolvedValue(undefined),
        discoverAllServicesAndCharacteristics: vi.fn().mockReturnValue(mockDeviceWithServices),
      });

      const adapter = new RNBleAdapter(devicePicker, 'aurora');
      await adapter.requestAndConnect();

      expect(seenDeviceIdsByUpdate).toEqual([[], ['first-native-id'], ['second-native-id']]);
      expect(mockBleManager.connectToDevice).toHaveBeenCalledWith('second-native-id');
    });

    it('replaces an unnamed row when a later scan response adds the board name', async () => {
      mockBleManager.onDeviceDisconnected.mockReturnValue({ remove: vi.fn() });
      mockBleManager.startDeviceScan.mockImplementation(
        (_uuids: unknown, _opts: unknown, callback: (error: unknown, device: unknown) => void) => {
          callback(null, {
            id: 'late-name-device',
            localName: undefined,
            name: undefined,
            rssi: -45,
            serviceUUIDs: ['aurora-uuid'],
          });
          callback(null, {
            id: 'late-name-device',
            localName: 'Kilter Board#751737@3',
            name: 'Kilter Board#751737@3',
            rssi: -40,
            serviceUUIDs: ['aurora-uuid'],
          });
        },
      );

      const seenDevicesByUpdate: Array<Array<{ deviceId: string; name?: string }>> = [];
      const devicePicker: DevicePickerFn = (subscribe) => {
        subscribe((devices) => {
          seenDevicesByUpdate.push(devices.map((device) => ({ deviceId: device.deviceId, name: device.name })));
        });
        return Promise.resolve('late-name-device');
      };

      const mockCharacteristic = { uuid: 'uart-write-uuid', writeWithoutResponse: vi.fn() };
      const mockDeviceWithServices = {
        id: 'late-name-device',
        characteristicsForService: vi.fn().mockResolvedValue([mockCharacteristic]),
        requestMTU: vi.fn().mockResolvedValue(undefined),
        discoverAllServicesAndCharacteristics: vi.fn().mockReturnThis(),
      };
      mockBleManager.connectToDevice.mockResolvedValue({
        id: 'late-name-device',
        requestMTU: vi.fn().mockResolvedValue(undefined),
        discoverAllServicesAndCharacteristics: vi.fn().mockReturnValue(mockDeviceWithServices),
      });

      const adapter = new RNBleAdapter(devicePicker, 'aurora');
      await adapter.requestAndConnect();

      expect(seenDevicesByUpdate).toEqual([
        [],
        [{ deviceId: 'late-name-device', name: undefined }],
        [{ deviceId: 'late-name-device', name: 'Kilter Board#751737@3' }],
      ]);
    });
  });

  describe('requestAndConnect — failure modes', () => {
    it('times out and rejects if connectToDevice hangs past CONNECTION_TIMEOUT_MS', async () => {
      vi.useFakeTimers();
      try {
        mockBleManager.cancelDeviceConnection.mockResolvedValue(undefined);
        mockBleManager.onDeviceDisconnected.mockReturnValue({ remove: vi.fn() });
        // connectToDevice hangs forever — simulates board powered off after scan
        mockBleManager.connectToDevice.mockImplementation(() => new Promise(() => {}));
        mockBleManager.startDeviceScan.mockImplementation(
          (_uuids: unknown, _opts: unknown, callback: (error: unknown, device: unknown) => void) => {
            callback(null, {
              id: 'hang-device',
              localName: 'Kilter Board#TEST@3',
              name: 'Kilter Board#TEST@3',
              rssi: -40,
              serviceUUIDs: ['aurora-uuid'],
            });
          },
        );

        const devicePicker: DevicePickerFn = () => Promise.resolve('hang-device');
        const adapter = new RNBleAdapter(devicePicker);
        const connectPromise = adapter.requestAndConnect();
        // Surface the rejection so vitest doesn't flag an unhandled promise
        // when we await timers below.
        const settled = connectPromise.catch((reason) => reason);

        await vi.advanceTimersByTimeAsync(12_500);
        const error = await settled;

        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toMatch(/timed out/i);
        expect(mockBleManager.cancelDeviceConnection).toHaveBeenCalledWith('hang-device');
      } finally {
        vi.useRealTimers();
      }
    });

    it('surfaces scan errors to the picker immediately instead of waiting for scan timeout', async () => {
      mockBleManager.onDeviceDisconnected.mockReturnValue({ remove: vi.fn() });

      // Capture the scan callback so the test can fire scanError after the picker is open.
      // Use an array to defeat TS's narrowing — it can't see the reassignment inside the
      // mock implementation closure and would otherwise narrow the variable to `null`.
      type ScanCallback = (error: unknown, device: unknown) => void;
      const captured: ScanCallback[] = [];
      mockBleManager.startDeviceScan.mockImplementation((_uuids: unknown, _opts: unknown, callback: ScanCallback) => {
        captured.push(callback);
      });

      // Picker stays open until externally rejected — mirrors how the real DevicePickerSheet behaves
      const devicePicker: DevicePickerFn = () => new Promise(() => {});
      const adapter = new RNBleAdapter(devicePicker);
      const connectPromise = adapter.requestAndConnect();
      const settled = connectPromise.catch((reason) => reason);

      // Wait a microtask for startDeviceScan to register the callback
      await Promise.resolve();
      expect(captured.length).toBe(1);

      // Fire scan error — Android permission-revoked-mid-scan is the canonical case
      captured[0]({ message: 'permission revoked' }, null);

      const error = await settled;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/scan failed/i);
      expect(mockBleManager.stopDeviceScan).toHaveBeenCalled();
    });

    it('falls back to the picker when a reconnect-by-serial board never advertises', async () => {
      vi.useFakeTimers();
      try {
        mockBleManager.onDeviceDisconnected.mockReturnValue({ remove: vi.fn() });
        mockBleManager.startDeviceScan.mockImplementation(() => {});

        let pickerOpened = false;
        // Picker stays open once shown.
        const devicePicker: DevicePickerFn = () => {
          pickerOpened = true;
          return new Promise<string>(() => {});
        };
        const adapter = new RNBleAdapter(devicePicker);
        const settled = adapter.requestAndConnect('NEEDLE-SERIAL').catch((reason) => reason);
        await Promise.resolve();

        // Silent auto-select before the grace window — no picker yet.
        await vi.advanceTimersByTimeAsync(SERIAL_RECONNECT_GRACE_MS - 1);
        expect(pickerOpened).toBe(false);

        // Grace window elapses with no match → picker opens instead of failing.
        await vi.advanceTimersByTimeAsync(1);
        expect(pickerOpened).toBe(true);

        // Nothing ever advertises → scan timeout rejects so the sheet doesn't spin.
        await vi.advanceTimersByTimeAsync(SCAN_TIMEOUT_MS);
        const error = await settled;
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toMatch(/no boards found/i);
      } finally {
        vi.useRealTimers();
      }
    });

    it('signals scan-stopped to the picker on timeout when devices were found but not picked', async () => {
      vi.useFakeTimers();
      try {
        mockBleManager.onDeviceDisconnected.mockReturnValue({ remove: vi.fn() });
        // Surface a device immediately so the timeout takes the "found but not
        // picked" branch rather than the empty-result reject.
        mockBleManager.startDeviceScan.mockImplementation(
          (_uuids: unknown, _opts: unknown, callback: (error: unknown, device: unknown) => void) => {
            callback(null, {
              id: 'seen-device',
              localName: 'Kilter Board#TEST@3',
              name: 'Kilter Board#TEST@3',
              rssi: -40,
              serviceUUIDs: ['aurora-uuid'],
            });
          },
        );

        const onScanStopped = vi.fn();
        // Picker stays open (user hasn't tapped a device yet) and captures the
        // scan-stopped notifier the adapter hands it.
        const devicePicker: DevicePickerFn = (subscribe) => {
          subscribe(() => {}, onScanStopped);
          return new Promise<string>(() => {});
        };
        const adapter = new RNBleAdapter(devicePicker);
        void adapter.requestAndConnect().catch(() => {});
        await Promise.resolve();

        expect(onScanStopped).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(SCAN_TIMEOUT_MS);
        expect(onScanStopped).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('onDisconnect', () => {
    it('returns an unsubscribe function', () => {
      const adapter = new RNBleAdapter(createMockDevicePicker());
      const callback = vi.fn();

      const unsubscribe = adapter.onDisconnect(callback);

      expect(typeof unsubscribe).toBe('function');
    });

    it('unsubscribe clears the callback', () => {
      const adapter = new RNBleAdapter(createMockDevicePicker());
      const callback = vi.fn();

      const unsubscribe = adapter.onDisconnect(callback);
      unsubscribe();

      // After unsubscribe, the callback reference should be cleared.
      // We can verify by setting another callback and checking it works.
      const secondCallback = vi.fn();
      const unsubscribe2 = adapter.onDisconnect(secondCallback);

      expect(typeof unsubscribe2).toBe('function');
    });
  });

  describe('requestAndConnect — original MoonBoard (RedBearLab) fallback', () => {
    it('falls back to the RedBearLab service for moonboard when the UART service exposes no write characteristic', async () => {
      const redbearCharacteristic = {
        uuid: 'redbearlab-write-uuid',
        isWritableWithoutResponse: false,
        writeWithoutResponse: vi.fn().mockResolvedValue(undefined),
        writeWithResponse: vi.fn().mockResolvedValue(undefined),
      };
      // UART service is present but carries no matching write characteristic.
      const characteristicsForService = vi.fn().mockImplementation((serviceUuid: string) => {
        if (serviceUuid === 'uart-uuid') return Promise.resolve([]);
        if (serviceUuid === 'redbearlab-uuid') return Promise.resolve([redbearCharacteristic]);
        return Promise.resolve([]);
      });

      const adapter = setupConnectableAdapter('moonboard', 'redbear-empty-device', characteristicsForService);
      await adapter.requestAndConnect();

      // UART queried first, RedBearLab queried as the fallback.
      expect(characteristicsForService).toHaveBeenCalledWith('uart-uuid');
      expect(characteristicsForService).toHaveBeenCalledWith('redbearlab-uuid');

      const data = new Uint8Array([0x01]);
      vi.mocked(splitMessages).mockReturnValue([data]);
      await adapter.write(data);

      // Subsequent writes target the RedBearLab characteristic.
      expect(redbearCharacteristic.writeWithResponse).toHaveBeenCalledOnce();
    });

    it('falls back to the RedBearLab service for moonboard when the UART service lookup throws', async () => {
      const redbearCharacteristic = {
        uuid: 'redbearlab-write-uuid',
        isWritableWithoutResponse: false,
        writeWithoutResponse: vi.fn().mockResolvedValue(undefined),
        writeWithResponse: vi.fn().mockResolvedValue(undefined),
      };
      // react-native-ble-plx throws when the UART service isn't present at all.
      const characteristicsForService = vi.fn().mockImplementation((serviceUuid: string) => {
        if (serviceUuid === 'uart-uuid') return Promise.reject(new Error('Service not found'));
        if (serviceUuid === 'redbearlab-uuid') return Promise.resolve([redbearCharacteristic]);
        return Promise.resolve([]);
      });

      const adapter = setupConnectableAdapter('moonboard', 'redbear-throw-device', characteristicsForService);
      await adapter.requestAndConnect();

      expect(characteristicsForService).toHaveBeenCalledWith('uart-uuid');
      expect(characteristicsForService).toHaveBeenCalledWith('redbearlab-uuid');

      const data = new Uint8Array([0x01]);
      vi.mocked(splitMessages).mockReturnValue([data]);
      await adapter.write(data);

      expect(redbearCharacteristic.writeWithResponse).toHaveBeenCalledOnce();
    });

    it('does not fall back to RedBearLab on aurora and throws when the UART write characteristic is absent', async () => {
      const redbearCharacteristic = {
        uuid: 'redbearlab-write-uuid',
        writeWithoutResponse: vi.fn().mockResolvedValue(undefined),
        writeWithResponse: vi.fn().mockResolvedValue(undefined),
      };
      // The RedBearLab service WOULD match if queried — proving aurora never asks.
      const characteristicsForService = vi.fn().mockImplementation((serviceUuid: string) => {
        if (serviceUuid === 'uart-uuid') return Promise.resolve([]);
        return Promise.resolve([redbearCharacteristic]);
      });

      const adapter = setupConnectableAdapter('aurora', 'aurora-no-fallback-device', characteristicsForService);

      await expect(adapter.requestAndConnect()).rejects.toThrow('UART write characteristic not found');
      expect(characteristicsForService).toHaveBeenCalledWith('uart-uuid');
      expect(characteristicsForService).not.toHaveBeenCalledWith('redbearlab-uuid');
      // The dead connection is torn down before the error surfaces.
      expect(mockBleManager.cancelDeviceConnection).toHaveBeenCalledWith('aurora-no-fallback-device');
    });
  });

  describe('write — write-type gating', () => {
    it('uses writeWithResponse for a moonboard characteristic that is not writable without response', async () => {
      const characteristic = {
        uuid: 'uart-write-uuid',
        isWritableWithoutResponse: false,
        writeWithoutResponse: vi.fn().mockResolvedValue(undefined),
        writeWithResponse: vi.fn().mockResolvedValue(undefined),
      };
      const characteristicsForService = vi.fn().mockResolvedValue([characteristic]);
      const adapter = setupConnectableAdapter('moonboard', 'moon-with-response', characteristicsForService);
      await adapter.requestAndConnect();

      const data = new Uint8Array([0x01]);
      vi.mocked(splitMessages).mockReturnValue([data]);
      await adapter.write(data);

      expect(characteristic.writeWithResponse).toHaveBeenCalledOnce();
      expect(characteristic.writeWithoutResponse).not.toHaveBeenCalled();
    });

    it('uses writeWithoutResponse for a moonboard characteristic that is writable without response', async () => {
      const characteristic = {
        uuid: 'uart-write-uuid',
        isWritableWithoutResponse: true,
        writeWithoutResponse: vi.fn().mockResolvedValue(undefined),
        writeWithResponse: vi.fn().mockResolvedValue(undefined),
      };
      const characteristicsForService = vi.fn().mockResolvedValue([characteristic]);
      const adapter = setupConnectableAdapter('moonboard', 'moon-without-response', characteristicsForService);
      await adapter.requestAndConnect();

      const data = new Uint8Array([0x01]);
      vi.mocked(splitMessages).mockReturnValue([data]);
      await adapter.write(data);

      expect(characteristic.writeWithoutResponse).toHaveBeenCalledOnce();
      expect(characteristic.writeWithResponse).not.toHaveBeenCalled();
    });

    it('always uses writeWithoutResponse for aurora even when the characteristic is not writable without response', async () => {
      const characteristic = {
        uuid: 'uart-write-uuid',
        isWritableWithoutResponse: false,
        writeWithoutResponse: vi.fn().mockResolvedValue(undefined),
        writeWithResponse: vi.fn().mockResolvedValue(undefined),
      };
      const characteristicsForService = vi.fn().mockResolvedValue([characteristic]);
      const adapter = setupConnectableAdapter('aurora', 'aurora-no-response-prop', characteristicsForService);
      await adapter.requestAndConnect();

      const data = new Uint8Array([0x01]);
      vi.mocked(splitMessages).mockReturnValue([data]);
      await adapter.write(data);

      // Family gate wins over the characteristic's reported property.
      expect(characteristic.writeWithoutResponse).toHaveBeenCalledOnce();
      expect(characteristic.writeWithResponse).not.toHaveBeenCalled();
    });
  });
});
