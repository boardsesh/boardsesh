import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { DevicePickerFn } from '../types';

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
  splitMessages: vi.fn((passedData: Uint8Array) => [passedData]),
  INTER_CHUNK_DELAY_MS: 0,
  parseSerialNumber: vi.fn(),
}));

// ── Import after mocks ─────────────────────────────────────────────────

import { RNBleAdapter } from '../adapter';
import { splitMessages } from '@boardsesh/ble-protocol';
import { State } from 'react-native-ble-plx';

// ── Helpers ─────────────────────────────────────────────────────────────

function createMockDevicePicker(): DevicePickerFn {
  return vi.fn();
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('RNBleAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBleManager.onStateChange.mockReturnValue({ remove: vi.fn() });
  });

  afterEach(() => {
    vi.useRealTimers();
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

    it('waits briefly when state is Unknown and resolves true if bluetooth powers on', async () => {
      vi.useFakeTimers();
      const stateListenerRef: { current: ((state: State) => void) | null } = { current: null };
      const remove = vi.fn();
      mockBleManager.onStateChange.mockImplementation((listener: (state: State) => void) => {
        stateListenerRef.current = listener;
        return { remove };
      });
      mockBleManager.state.mockResolvedValue(State.Unknown);
      const adapter = new RNBleAdapter(createMockDevicePicker());

      const availablePromise = adapter.isAvailable();
      await Promise.resolve();
      stateListenerRef.current?.(State.PoweredOn);
      const available = await availablePromise;

      expect(available).toBe(true);
      expect(remove).toHaveBeenCalledOnce();
    });

    it('returns false when bluetooth state is Unknown and never settles', async () => {
      vi.useFakeTimers();
      mockBleManager.state.mockResolvedValue(State.Unknown);
      const adapter = new RNBleAdapter(createMockDevicePicker());

      const availablePromise = adapter.isAvailable();
      await Promise.resolve();
      vi.advanceTimersByTime(2_500);
      const available = await availablePromise;

      expect(available).toBe(false);
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

      const adapter = new RNBleAdapter(createMockDevicePicker());

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
          callback(null, { id: 'device-1', localName: 'Board', name: 'Board', rssi: -40 });
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
          callback(null, { id: 'write-device', localName: 'Board', name: 'Board', rssi: -40 });
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
          callback(null, { id: 'chunk-device', localName: 'Board', name: 'Board', rssi: -40 });
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
          callback(null, { id: 'abort-device', localName: 'Board', name: 'Board', rssi: -40 });
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
});
