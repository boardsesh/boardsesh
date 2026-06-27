import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { AURORA_REQUEST_DEVICE_OPTIONS } from '@/app/components/board-bluetooth-control/bluetooth-aurora';
import { MOONBOARD_REQUEST_DEVICE_OPTIONS } from '@/app/components/board-bluetooth-control/bluetooth-moonboard';
import type {
  requestBluetoothDevice as _requestBluetoothDevice,
  getUartCharacteristic as _getUartCharacteristic,
  getMoonboardWriteCharacteristic as _getMoonboardWriteCharacteristic,
  writeCharacteristicSeries as _writeCharacteristicSeries,
} from '@/app/components/board-bluetooth-control/bluetooth-shared';
import { WebBluetoothAdapter } from '../web-adapter';

// Mock the shared Bluetooth transport helpers
const mockRequestDevice = vi.fn();
const mockGetCharacteristic = vi.fn();
const mockGetMoonboardCharacteristic = vi.fn();
const mockSplitMessages = vi.fn((data: Uint8Array) => [data]);
const mockWriteCharacteristicSeries = vi.fn();

vi.mock('@/app/components/board-bluetooth-control/bluetooth-shared', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    requestBluetoothDevice: (...args: Parameters<typeof _requestBluetoothDevice>) => mockRequestDevice(...args),
    getUartCharacteristic: (...args: Parameters<typeof _getUartCharacteristic>) => mockGetCharacteristic(...args),
    getMoonboardWriteCharacteristic: (...args: Parameters<typeof _getMoonboardWriteCharacteristic>) =>
      mockGetMoonboardCharacteristic(...args),
    splitMessages: (data: Uint8Array) => mockSplitMessages(data),
    writeCharacteristicSeries: (...args: Parameters<typeof _writeCharacteristicSeries>) =>
      mockWriteCharacteristicSeries(...args),
  };
});

function createMockDevice(overrides?: Partial<BluetoothDevice>) {
  return {
    id: 'web-dev-1',
    name: 'Test Board',
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    gatt: {
      connected: true,
      disconnect: vi.fn(),
    },
    ...overrides,
  } as unknown as BluetoothDevice;
}

function createMockCharacteristic() {
  return {
    writeValue: vi.fn().mockResolvedValue(undefined),
  } as unknown as BluetoothRemoteGATTCharacteristic;
}

describe('WebBluetoothAdapter', () => {
  let adapter: WebBluetoothAdapter;
  let originalBluetooth: unknown;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new WebBluetoothAdapter();
    originalBluetooth = (navigator as unknown as Record<string, unknown>).bluetooth;
  });

  afterEach(() => {
    Object.defineProperty(navigator, 'bluetooth', {
      value: originalBluetooth,
      writable: true,
      configurable: true,
    });
  });

  describe('isAvailable', () => {
    it('returns true when navigator.bluetooth exists', async () => {
      Object.defineProperty(navigator, 'bluetooth', {
        value: { requestDevice: vi.fn() },
        writable: true,
        configurable: true,
      });

      expect(await adapter.isAvailable()).toBe(true);
    });

    it('returns false when navigator.bluetooth is undefined', async () => {
      Object.defineProperty(navigator, 'bluetooth', {
        value: undefined,
        writable: true,
        configurable: true,
      });

      expect(await adapter.isAvailable()).toBe(false);
    });
  });

  describe('requestAndConnect', () => {
    it('connects and returns device info', async () => {
      const mockDevice = createMockDevice();
      const mockCharacteristic = createMockCharacteristic();
      mockRequestDevice.mockResolvedValue(mockDevice);
      mockGetCharacteristic.mockResolvedValue(mockCharacteristic);

      const connection = await adapter.requestAndConnect();

      expect(connection.deviceId).toBe('web-dev-1');
      expect(connection.deviceName).toBe('Test Board');
      expect(mockRequestDevice).toHaveBeenCalledWith(AURORA_REQUEST_DEVICE_OPTIONS);
      expect(mockGetCharacteristic).toHaveBeenCalledWith(mockDevice);
    });

    it('uses Moonboard request options and the Moonboard write-characteristic probe', async () => {
      const moonboardAdapter = new WebBluetoothAdapter('moonboard');
      const mockDevice = createMockDevice();
      mockRequestDevice.mockResolvedValue(mockDevice);
      mockGetMoonboardCharacteristic.mockResolvedValue(createMockCharacteristic());

      await moonboardAdapter.requestAndConnect();

      expect(mockRequestDevice).toHaveBeenCalledWith(MOONBOARD_REQUEST_DEVICE_OPTIONS);
      // MoonBoard spans two controller generations, so it probes both via the
      // dedicated helper rather than the UART-only getUartCharacteristic.
      expect(mockGetMoonboardCharacteristic).toHaveBeenCalledWith(mockDevice);
      expect(mockGetCharacteristic).not.toHaveBeenCalled();
    });

    it('registers gattserverdisconnected listener', async () => {
      const mockDevice = createMockDevice();
      mockRequestDevice.mockResolvedValue(mockDevice);
      mockGetCharacteristic.mockResolvedValue(createMockCharacteristic());

      await adapter.requestAndConnect();

      expect(mockDevice.addEventListener).toHaveBeenCalledWith('gattserverdisconnected', expect.any(Function));
    });

    it('throws when getCharacteristic returns undefined', async () => {
      mockRequestDevice.mockResolvedValue(createMockDevice());
      mockGetCharacteristic.mockResolvedValue(undefined);

      await expect(adapter.requestAndConnect()).rejects.toThrow('Failed to get UART characteristic');
    });

    it('cleans up previous device listeners on reconnect', async () => {
      const firstDevice = createMockDevice({ id: 'first' } as Partial<BluetoothDevice>);
      const secondDevice = createMockDevice({ id: 'second' } as Partial<BluetoothDevice>);
      mockGetCharacteristic.mockResolvedValue(createMockCharacteristic());

      mockRequestDevice.mockResolvedValueOnce(firstDevice);
      await adapter.requestAndConnect();

      mockRequestDevice.mockResolvedValueOnce(secondDevice);
      await adapter.requestAndConnect();

      expect(firstDevice.removeEventListener).toHaveBeenCalledWith('gattserverdisconnected', expect.any(Function));
    });

    it('handles undefined device name', async () => {
      const mockDevice = createMockDevice({ name: undefined } as Partial<BluetoothDevice>);
      mockRequestDevice.mockResolvedValue(mockDevice);
      mockGetCharacteristic.mockResolvedValue(createMockCharacteristic());

      const connection = await adapter.requestAndConnect();

      expect(connection.deviceName).toBeUndefined();
    });
  });

  describe('disconnect', () => {
    it('calls gatt.disconnect on connected device', async () => {
      const mockDevice = createMockDevice();
      mockRequestDevice.mockResolvedValue(mockDevice);
      mockGetCharacteristic.mockResolvedValue(createMockCharacteristic());

      await adapter.requestAndConnect();
      await adapter.disconnect();

      expect(mockDevice.gatt!.disconnect).toHaveBeenCalled();
    });

    it('removes event listener on disconnect', async () => {
      const mockDevice = createMockDevice();
      mockRequestDevice.mockResolvedValue(mockDevice);
      mockGetCharacteristic.mockResolvedValue(createMockCharacteristic());

      await adapter.requestAndConnect();
      await adapter.disconnect();

      expect(mockDevice.removeEventListener).toHaveBeenCalledWith('gattserverdisconnected', expect.any(Function));
    });

    it('does nothing when not connected', async () => {
      // Should not throw
      await adapter.disconnect();
    });
  });

  describe('write', () => {
    it('throws when not connected', async () => {
      await expect(adapter.write(new Uint8Array([1, 2, 3]))).rejects.toThrow('Not connected');
    });

    it('splits messages and writes via characteristic', async () => {
      mockRequestDevice.mockResolvedValue(createMockDevice());
      const mockCharacteristic = createMockCharacteristic();
      mockGetCharacteristic.mockResolvedValue(mockCharacteristic);

      await adapter.requestAndConnect();

      const data = new Uint8Array([1, 2, 3, 4, 5]);
      const chunk1 = new Uint8Array([1, 2, 3]);
      const chunk2 = new Uint8Array([4, 5]);
      mockSplitMessages.mockReturnValueOnce([chunk1, chunk2]);

      await adapter.write(data);

      expect(mockSplitMessages).toHaveBeenCalledWith(data);
      // Aurora (default board) never allows the write-with-response fallback.
      expect(mockWriteCharacteristicSeries).toHaveBeenCalledWith(mockCharacteristic, [chunk1, chunk2], undefined, {
        allowWithResponseFallback: false,
      });
    });

    it('allows the write-with-response fallback only for Moonboard', async () => {
      const moonboardAdapter = new WebBluetoothAdapter('moonboard');
      mockRequestDevice.mockResolvedValue(createMockDevice());
      const mockCharacteristic = createMockCharacteristic();
      mockGetMoonboardCharacteristic.mockResolvedValue(mockCharacteristic);
      await moonboardAdapter.requestAndConnect();

      const data = new Uint8Array([1, 2, 3]);
      mockSplitMessages.mockReturnValueOnce([data]);
      await moonboardAdapter.write(data);

      expect(mockWriteCharacteristicSeries).toHaveBeenCalledWith(mockCharacteristic, [data], undefined, {
        allowWithResponseFallback: true,
      });
    });
  });

  describe('onDisconnect', () => {
    it('invokes callback when device disconnects', async () => {
      const mockDevice = createMockDevice();
      mockRequestDevice.mockResolvedValue(mockDevice);
      mockGetCharacteristic.mockResolvedValue(createMockCharacteristic());

      const callback = vi.fn();
      adapter.onDisconnect(callback);

      await adapter.requestAndConnect();

      // Simulate GATT disconnection by calling the registered listener
      const addListenerCall = (mockDevice.addEventListener as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(addListenerCall[0]).toBe('gattserverdisconnected');
      const disconnectHandler = addListenerCall[1];
      disconnectHandler();

      expect(callback).toHaveBeenCalledOnce();
    });

    it('returns an unsubscribe function', async () => {
      const mockDevice = createMockDevice();
      mockRequestDevice.mockResolvedValue(mockDevice);
      mockGetCharacteristic.mockResolvedValue(createMockCharacteristic());

      const callback = vi.fn();
      const unsub = adapter.onDisconnect(callback);

      await adapter.requestAndConnect();

      unsub();

      // Simulate disconnection after unsubscribe
      const addListenerCall = (mockDevice.addEventListener as ReturnType<typeof vi.fn>).mock.calls[0];
      const disconnectHandler = addListenerCall[1];
      disconnectHandler();

      expect(callback).not.toHaveBeenCalled();
    });
  });
});
