import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import {
  AURORA_OPTIONAL_SERVICE_UUIDS,
  AURORA_SCAN_SERVICE_UUIDS,
} from '@/app/components/board-bluetooth-control/bluetooth-aurora';
import {
  MOONBOARD_OPTIONAL_SERVICE_UUIDS,
  MOONBOARD_SCAN_SERVICE_UUIDS,
} from '@/app/components/board-bluetooth-control/bluetooth-moonboard';

// Mock window.Capacitor before importing the adapter
const mockListenerRemove = vi.fn().mockResolvedValue(undefined);
let disconnectListenerCallback: ((data: { deviceId: string }) => void) | null = null;

// Capture the scan callback so tests can simulate device discovery
let scanCallback: ((result: { device: { deviceId: string; name?: string }; localName?: string; rssi: number }) => void) | null = null;

const mockBlePlugin = {
  initialize: vi.fn().mockResolvedValue(undefined),
  isEnabled: vi.fn().mockResolvedValue({ value: true }),
  requestDevice: vi.fn().mockResolvedValue({ deviceId: 'dev-1', name: 'Kilter Board' }),
  requestLEScan: vi.fn().mockImplementation((_options: unknown, callback: typeof scanCallback) => {
    scanCallback = callback;
    return Promise.resolve();
  }),
  stopLEScan: vi.fn().mockResolvedValue(undefined),
  connect: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn().mockResolvedValue(undefined),
  write: vi.fn().mockResolvedValue(undefined),
  requestMtu: vi.fn().mockResolvedValue({ value: 185 }),
  addListener: vi.fn().mockImplementation((_event: string, cb: (data: { deviceId: string }) => void) => {
    disconnectListenerCallback = cb;
    return Promise.resolve({ remove: mockListenerRemove });
  }),
};

// Store original window.Capacitor so we can clean up
const originalCapacitor = window.Capacitor;

Object.defineProperty(window, 'Capacitor', {
  value: {
    isNativePlatform: () => true,
    getPlatform: () => 'ios',
    Plugins: {
      BluetoothLe: mockBlePlugin,
    },
  },
  writable: true,
  configurable: true,
});

afterAll(() => {
  if (originalCapacitor === undefined) {
    delete (window as Window & { Capacitor?: unknown }).Capacitor;
  } else {
    window.Capacitor = originalCapacitor;
  }
});

import { CapacitorBleAdapter, _resetInitCache } from '../capacitor-adapter';

describe('CapacitorBleAdapter', () => {
  let adapter: CapacitorBleAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    disconnectListenerCallback = null;
    scanCallback = null;
    _resetInitCache();
    adapter = new CapacitorBleAdapter();
  });

  describe('isAvailable', () => {
    it('returns true when BLE is enabled', async () => {
      expect(await adapter.isAvailable()).toBe(true);
      expect(mockBlePlugin.initialize).toHaveBeenCalled();
      expect(mockBlePlugin.isEnabled).toHaveBeenCalled();
    });

    it('returns false when BLE is disabled', async () => {
      mockBlePlugin.isEnabled.mockResolvedValueOnce({ value: false });
      expect(await adapter.isAvailable()).toBe(false);
    });

    it('returns false when initialize throws', async () => {
      mockBlePlugin.initialize.mockRejectedValueOnce(new Error('No BLE'));
      expect(await adapter.isAvailable()).toBe(false);
    });
  });

  describe('requestAndConnect', () => {
    it('connects and returns device info', async () => {
      const connection = await adapter.requestAndConnect();

      expect(connection.deviceId).toBe('dev-1');
      expect(connection.deviceName).toBe('Kilter Board');
      expect(mockBlePlugin.requestDevice).toHaveBeenCalledWith({
        services: [...AURORA_SCAN_SERVICE_UUIDS],
        optionalServices: [...AURORA_OPTIONAL_SERVICE_UUIDS],
      });
      expect(mockBlePlugin.connect).toHaveBeenCalledWith({
        deviceId: 'dev-1',
      });
    });

    it('requests Moonboard devices via Nordic UART when board is Moonboard', async () => {
      const moonboardAdapter = new CapacitorBleAdapter('moonboard');

      await moonboardAdapter.requestAndConnect();

      expect(mockBlePlugin.requestDevice).toHaveBeenCalledWith({
        services: [...MOONBOARD_SCAN_SERVICE_UUIDS],
        optionalServices: [...MOONBOARD_OPTIONAL_SERVICE_UUIDS],
      });
    });

    it('negotiates MTU after connecting', async () => {
      await adapter.requestAndConnect();

      expect(mockBlePlugin.requestMtu).toHaveBeenCalledWith({
        deviceId: 'dev-1',
        mtu: 512,
      });
    });

    it('registers disconnect listener after connecting', async () => {
      await adapter.requestAndConnect();

      expect(mockBlePlugin.addListener).toHaveBeenCalledWith(
        'disconnected',
        expect.any(Function),
      );
    });

    it('falls back to default MTU when negotiation fails', async () => {
      mockBlePlugin.requestMtu.mockRejectedValueOnce(new Error('Not supported'));
      await adapter.requestAndConnect();

      // Should still connect successfully — write with default 20-byte chunks
      const data = new Uint8Array(40);
      await adapter.write(data);

      // 40 bytes / 20 byte chunks = 2 writes
      expect(mockBlePlugin.write).toHaveBeenCalledTimes(2);
    });
  });

  describe('disconnect', () => {
    it('disconnects from connected device', async () => {
      await adapter.requestAndConnect();
      await adapter.disconnect();

      expect(mockBlePlugin.disconnect).toHaveBeenCalledWith({ deviceId: 'dev-1' });
    });

    it('removes disconnect listener before disconnecting', async () => {
      await adapter.requestAndConnect();
      await adapter.disconnect();

      expect(mockListenerRemove).toHaveBeenCalled();
      // Listener removal should happen before the plugin disconnect call
      const removeOrder = mockListenerRemove.mock.invocationCallOrder[0];
      const disconnectOrder = mockBlePlugin.disconnect.mock.invocationCallOrder[0];
      expect(removeOrder).toBeLessThan(disconnectOrder);
    });

    it('does nothing when not connected', async () => {
      await adapter.disconnect();
      expect(mockBlePlugin.disconnect).not.toHaveBeenCalled();
    });

    it('ignores errors from plugin disconnect', async () => {
      await adapter.requestAndConnect();
      mockBlePlugin.disconnect.mockRejectedValueOnce(new Error('Already disconnected'));

      // Should not throw
      await adapter.disconnect();
    });
  });

  describe('write', () => {
    it('throws when not connected', async () => {
      await expect(adapter.write(new Uint8Array([1, 2, 3]))).rejects.toThrow('Not connected');
    });

    it('writes small data in a single chunk as hex string', async () => {
      mockBlePlugin.requestMtu.mockResolvedValueOnce({ value: 185 });
      await adapter.requestAndConnect();

      const data = new Uint8Array([1, 2, 3, 4, 5]);
      await adapter.write(data);

      expect(mockBlePlugin.write).toHaveBeenCalledTimes(1);
      expect(mockBlePlugin.write).toHaveBeenCalledWith({
        deviceId: 'dev-1',
        service: '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
        characteristic: '6e400002-b5a3-f393-e0a9-e50e24dcca9e',
        value: '0102030405',
      });
    });

    it('chunks data based on negotiated MTU', async () => {
      // MTU 185 → chunk size 182 (185 - 3 ATT header)
      mockBlePlugin.requestMtu.mockResolvedValueOnce({ value: 185 });
      await adapter.requestAndConnect();

      // 400 bytes / 182 byte chunks = 3 writes (182 + 182 + 36)
      const data = new Uint8Array(400);
      await adapter.write(data);

      expect(mockBlePlugin.write).toHaveBeenCalledTimes(3);
    });

    it('chunks at default 20 bytes when MTU negotiation fails', async () => {
      mockBlePlugin.requestMtu.mockRejectedValueOnce(new Error('Not supported'));
      await adapter.requestAndConnect();

      // 50 bytes / 20 byte chunks = 3 writes (20 + 20 + 10)
      const data = new Uint8Array(50);
      await adapter.write(data);

      expect(mockBlePlugin.write).toHaveBeenCalledTimes(3);
    });

    it('encodes bytes as continuous hex string', async () => {
      await adapter.requestAndConnect();

      const data = new Uint8Array([0x01, 0x02, 0xff]);
      await adapter.write(data);

      const writtenValue = mockBlePlugin.write.mock.calls[0][0].value;
      expect(writtenValue).toBe('0102ff');
    });

    it('aborts remaining chunks when signal is aborted', async () => {
      mockBlePlugin.requestMtu.mockRejectedValueOnce(new Error('Not supported'));
      await adapter.requestAndConnect();

      const controller = new AbortController();
      // Abort after the first write completes
      mockBlePlugin.write.mockImplementationOnce(async () => {
        controller.abort();
      });

      // 50 bytes / 20 byte chunks = 3 writes normally, but should stop after 1
      const data = new Uint8Array(50);
      await expect(adapter.write(data, controller.signal)).rejects.toThrow('Write aborted');

      // Only the first chunk should have been written
      expect(mockBlePlugin.write).toHaveBeenCalledTimes(1);
    });

    it('throws AbortError immediately when signal is already aborted', async () => {
      await adapter.requestAndConnect();

      const controller = new AbortController();
      controller.abort();

      const data = new Uint8Array([1, 2, 3]);
      await expect(adapter.write(data, controller.signal)).rejects.toThrow('Write aborted');

      expect(mockBlePlugin.write).not.toHaveBeenCalled();
    });
  });

  describe('onDisconnect', () => {
    it('stores callback and returns unsubscribe function', () => {
      const callback = vi.fn();
      const unsub = adapter.onDisconnect(callback);

      expect(typeof unsub).toBe('function');

      // After unsubscribe, callback should be cleared
      unsub();
    });

    it('fires callback on unexpected disconnect from native layer', async () => {
      const callback = vi.fn();
      adapter.onDisconnect(callback);
      await adapter.requestAndConnect();

      // Simulate the native CoreBluetooth disconnect event
      disconnectListenerCallback?.({ deviceId: 'dev-1' });

      expect(callback).toHaveBeenCalledTimes(1);
    });

    it('ignores disconnect events for other devices', async () => {
      const callback = vi.fn();
      adapter.onDisconnect(callback);
      await adapter.requestAndConnect();

      disconnectListenerCallback?.({ deviceId: 'other-device' });

      expect(callback).not.toHaveBeenCalled();
    });

    it('clears listener handle on unexpected disconnect to prevent orphaned handles', async () => {
      const callback = vi.fn();
      adapter.onDisconnect(callback);
      await adapter.requestAndConnect();

      // Simulate unexpected disconnect
      disconnectListenerCallback?.({ deviceId: 'dev-1' });

      // After unexpected disconnect, write should throw (deviceId cleared)
      await expect(adapter.write(new Uint8Array([1]))).rejects.toThrow('Not connected');

      // Reconnect — should register a fresh listener without orphaning the old one
      mockListenerRemove.mockClear();
      mockBlePlugin.addListener.mockClear();
      await adapter.requestAndConnect();

      expect(mockBlePlugin.addListener).toHaveBeenCalledTimes(1);
      // The old handle was nulled out, so disconnect() won't try to remove it twice
    });

    it('does not fire callback on intentional disconnect', async () => {
      const callback = vi.fn();
      adapter.onDisconnect(callback);
      await adapter.requestAndConnect();

      // Intentional disconnect removes the listener first
      await adapter.disconnect();

      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe('requestAndConnect with devicePicker', () => {
    it('uses manual scan and custom picker when devicePicker is provided', async () => {
      const pickerAdapter = new CapacitorBleAdapter('kilter', (subscribe) => {
        // Subscribe to device updates
        subscribe(() => {});
        // Simulate immediate user selection
        return Promise.resolve('scan-dev-1');
      });

      // Simulate device discovery after requestLEScan starts
      mockBlePlugin.requestLEScan.mockImplementation((_opts: unknown, cb: typeof scanCallback) => {
        cb?.({ device: { deviceId: 'scan-dev-1', name: 'My Kilter' }, rssi: -60 });
        return Promise.resolve();
      });

      const connection = await pickerAdapter.requestAndConnect();

      expect(connection.deviceId).toBe('scan-dev-1');
      expect(connection.deviceName).toBe('My Kilter');
      expect(mockBlePlugin.requestLEScan).toHaveBeenCalledWith(
        { services: [...AURORA_SCAN_SERVICE_UUIDS] },
        expect.any(Function),
      );
      expect(mockBlePlugin.stopLEScan).toHaveBeenCalled();
      expect(mockBlePlugin.requestDevice).not.toHaveBeenCalled();
      expect(mockBlePlugin.connect).toHaveBeenCalledWith({ deviceId: 'scan-dev-1' });
    });

    it('deduplicates devices by deviceId', async () => {
      let receivedDevices: Array<{ deviceId: string; name?: string; rssi: number }> = [];

      const pickerAdapter = new CapacitorBleAdapter('kilter', (subscribe) => {
        subscribe((devices) => {
          receivedDevices = devices;
        });
        // Wait a tick for devices to arrive, then select
        return new Promise<string>((resolve) => {
          setTimeout(() => resolve('dev-A'), 10);
        });
      });

      // Emit the same device twice with updated RSSI
      mockBlePlugin.requestLEScan.mockImplementation((_opts: unknown, cb: typeof scanCallback) => {
        cb?.({ device: { deviceId: 'dev-A', name: 'Board A' }, rssi: -80 });
        cb?.({ device: { deviceId: 'dev-A', name: 'Board A' }, rssi: -55 });
        return Promise.resolve();
      });

      await pickerAdapter.requestAndConnect();

      // Should have exactly 1 device (deduplicated), with updated RSSI
      expect(receivedDevices).toHaveLength(1);
      expect(receivedDevices[0].rssi).toBe(-55);
    });

    it('stops scanning even when picker rejects', async () => {
      const pickerAdapter = new CapacitorBleAdapter('kilter', () => {
        return Promise.reject(new Error('User cancelled'));
      });

      await expect(pickerAdapter.requestAndConnect()).rejects.toThrow('User cancelled');

      expect(mockBlePlugin.stopLEScan).toHaveBeenCalled();
    });

    it('falls back to requestDevice when no devicePicker is provided', async () => {
      const fallbackAdapter = new CapacitorBleAdapter('kilter');
      await fallbackAdapter.requestAndConnect();

      expect(mockBlePlugin.requestDevice).toHaveBeenCalled();
      expect(mockBlePlugin.requestLEScan).not.toHaveBeenCalled();
    });

    it('uses localName from scan result when device.name is missing', async () => {
      const pickerAdapter = new CapacitorBleAdapter('kilter', (subscribe) => {
        subscribe(() => {});
        return Promise.resolve('dev-local');
      });

      mockBlePlugin.requestLEScan.mockImplementation((_opts: unknown, cb: typeof scanCallback) => {
        cb?.({ device: { deviceId: 'dev-local' }, localName: 'Local Name', rssi: -70 });
        return Promise.resolve();
      });

      const connection = await pickerAdapter.requestAndConnect();
      expect(connection.deviceName).toBe('Local Name');
    });
  });
});
