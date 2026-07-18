// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AURORA_ADVERTISED_SERVICE_UUID,
  UART_SERVICE_UUID,
  REDBEARLAB_SERVICE_UUID,
  MAX_BLUETOOTH_MESSAGE_SIZE,
} from '@boardsesh/ble-protocol/transport';
import { WebBluetoothAdapter, requestDeviceOptionsForFamily, isWebBluetoothAvailable } from '../web-adapter';
import type { BoardScanFamily } from '../types';

type FakeCharacteristic = {
  properties: { write: boolean; writeWithoutResponse: boolean; read: boolean; notify: boolean };
  writeValueWithoutResponse: ReturnType<typeof vi.fn>;
  writeValueWithResponse: ReturnType<typeof vi.fn>;
};

function makeCharacteristic(writeWithoutResponse = true): FakeCharacteristic {
  return {
    properties: { write: true, writeWithoutResponse, read: false, notify: false },
    writeValueWithoutResponse: vi.fn().mockResolvedValue(undefined),
    writeValueWithResponse: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * Build a fake Web Bluetooth stack. `servicesByUuid` maps a service UUID to the
 * characteristic that service's getCharacteristic returns; any UUID absent from
 * the map makes getPrimaryService reject (mirroring a board that doesn't expose
 * that controller generation).
 */
function makeDevice(servicesByUuid: Record<string, FakeCharacteristic>) {
  const device = new EventTarget() as EventTarget & {
    id: string;
    name?: string;
    gatt: { connected: boolean; connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> };
  };
  const server = {
    connected: true,
    connect: vi.fn(),
    disconnect: vi.fn(() => {
      server.connected = false;
    }),
    getPrimaryService: vi.fn((uuid: string) => {
      const characteristic = servicesByUuid[uuid];
      if (!characteristic) return Promise.reject(new Error(`no service ${uuid}`));
      return Promise.resolve({
        getCharacteristic: vi.fn(() => Promise.resolve(characteristic)),
      });
    }),
  };
  server.connect.mockResolvedValue(server);
  device.id = 'device-abc';
  device.name = 'Kilter Board';
  device.gatt = server as unknown as (typeof device)['gatt'];
  return { device, server };
}

function stubBluetooth(requestDevice: ReturnType<typeof vi.fn>) {
  Object.defineProperty(navigator, 'bluetooth', {
    configurable: true,
    value: { requestDevice },
  });
}

function clearBluetooth() {
  Object.defineProperty(navigator, 'bluetooth', { configurable: true, value: undefined });
}

afterEach(() => {
  clearBluetooth();
  vi.restoreAllMocks();
});

describe('isWebBluetoothAvailable / isAvailable', () => {
  it('is true when navigator.bluetooth is present', async () => {
    stubBluetooth(vi.fn());
    expect(isWebBluetoothAvailable()).toBe(true);
    await expect(new WebBluetoothAdapter('aurora').isAvailable()).resolves.toBe(true);
  });

  it('is false when navigator.bluetooth is absent (non-Chromium browsers)', async () => {
    clearBluetooth();
    expect(isWebBluetoothAvailable()).toBe(false);
    await expect(new WebBluetoothAdapter('aurora').isAvailable()).resolves.toBe(false);
  });
});

describe('requestDeviceOptionsForFamily', () => {
  it('filters Aurora on the advertised service and reaches UART after connect', () => {
    const options = requestDeviceOptionsForFamily('aurora');
    expect(options.filters).toEqual([{ services: [AURORA_ADVERTISED_SERVICE_UUID] }]);
    expect(options.optionalServices).toContain(UART_SERVICE_UUID);
  });

  it('filters MoonBoard across both controller services plus the name prefixes', () => {
    const options = requestDeviceOptionsForFamily('moonboard');
    expect(options.filters).toEqual(
      expect.arrayContaining([
        { services: [UART_SERVICE_UUID] },
        { services: [REDBEARLAB_SERVICE_UUID] },
        { namePrefix: 'MoonBoard' },
        { namePrefix: 'Moonboard' },
      ]),
    );
    expect(options.optionalServices).toEqual([UART_SERVICE_UUID, REDBEARLAB_SERVICE_UUID]);
  });
});

describe('requestAndConnect', () => {
  it('requests with the Aurora filter shape and returns the connection identity', async () => {
    const { device } = makeDevice({ [UART_SERVICE_UUID]: makeCharacteristic() });
    const requestDevice = vi.fn().mockResolvedValue(device);
    stubBluetooth(requestDevice);

    const connection = await new WebBluetoothAdapter('aurora').requestAndConnect();

    expect(requestDevice).toHaveBeenCalledWith(requestDeviceOptionsForFamily('aurora'));
    expect(connection).toEqual({ deviceId: 'device-abc', deviceName: 'Kilter Board' });
  });

  it('resolves the MoonBoard write characteristic via the RedBearLab fallback', async () => {
    // Only the RedBearLab service is present — UART probing rejects first.
    const redbearChar = makeCharacteristic(false);
    const { device } = makeDevice({ [REDBEARLAB_SERVICE_UUID]: redbearChar });
    const requestDevice = vi.fn().mockResolvedValue(device);
    stubBluetooth(requestDevice);

    const connection = await new WebBluetoothAdapter('moonboard').requestAndConnect();
    expect(requestDevice).toHaveBeenCalledWith(requestDeviceOptionsForFamily('moonboard'));
    expect(connection.deviceId).toBe('device-abc');
  });

  it('rejects with the explicit message when MoonBoard exposes neither controller', async () => {
    // The MoonBoard probe swallows each missing-service rejection and returns
    // undefined, so the adapter surfaces its own "write characteristic" error.
    const { device } = makeDevice({});
    stubBluetooth(vi.fn().mockResolvedValue(device));
    await expect(new WebBluetoothAdapter('moonboard').requestAndConnect()).rejects.toThrow(/write characteristic/i);
  });

  it('propagates the raw GATT rejection when Aurora cannot reach its UART service', async () => {
    // Aurora boards always advertise UART, so a missing service is a genuine
    // fault — the underlying getPrimaryService rejection propagates unwrapped.
    const { device } = makeDevice({});
    stubBluetooth(vi.fn().mockResolvedValue(device));
    await expect(new WebBluetoothAdapter('aurora').requestAndConnect()).rejects.toThrow(/no service/i);
  });

  it('disconnects the GATT server when the Aurora probe rejects (no leaked connection)', async () => {
    // getPrimaryService rejects for a missing UART service; the GATT connection
    // opened by the probe must be dropped rather than left dangling.
    const { device, server } = makeDevice({});
    stubBluetooth(vi.fn().mockResolvedValue(device));
    await expect(new WebBluetoothAdapter('aurora').requestAndConnect()).rejects.toThrow(/no service/i);
    expect(server.disconnect).toHaveBeenCalledTimes(1);
  });

  it('disconnects the GATT server when MoonBoard exposes neither controller', async () => {
    // The MoonBoard probe swallows the missing-service rejections and returns
    // undefined; the still-open GATT connection must be released before the
    // adapter surfaces its "write characteristic" error.
    const { device, server } = makeDevice({});
    stubBluetooth(vi.fn().mockResolvedValue(device));
    await expect(new WebBluetoothAdapter('moonboard').requestAndConnect()).rejects.toThrow(/write characteristic/i);
    expect(server.disconnect).toHaveBeenCalledTimes(1);
  });

  it('rejects when Web Bluetooth is unavailable', async () => {
    clearBluetooth();
    await expect(new WebBluetoothAdapter('aurora').requestAndConnect()).rejects.toThrow(/not available/i);
  });
});

describe('write', () => {
  it('splits the payload and issues one writeValueWithoutResponse per chunk', async () => {
    const characteristic = makeCharacteristic();
    const { device } = makeDevice({ [UART_SERVICE_UUID]: characteristic });
    stubBluetooth(vi.fn().mockResolvedValue(device));

    const adapter = new WebBluetoothAdapter('aurora');
    await adapter.requestAndConnect();

    // 50 bytes at a 20-byte chunk ceiling → 3 chunks (20, 20, 10).
    const payload = new Uint8Array(50).fill(7);
    await adapter.write(payload);

    const expectedChunks = Math.ceil(payload.length / MAX_BLUETOOTH_MESSAGE_SIZE);
    expect(expectedChunks).toBe(3);
    expect(characteristic.writeValueWithoutResponse).toHaveBeenCalledTimes(3);
    expect(characteristic.writeValueWithResponse).not.toHaveBeenCalled();
    const firstChunk = characteristic.writeValueWithoutResponse.mock.calls[0][0] as Uint8Array;
    expect(firstChunk).toHaveLength(MAX_BLUETOOTH_MESSAGE_SIZE);
  });

  it('throws when write is called before connecting', async () => {
    await expect(new WebBluetoothAdapter('aurora').write(new Uint8Array([1]))).rejects.toThrow(/not connected/i);
  });

  it('aborts a queued write when the signal is already aborted', async () => {
    const characteristic = makeCharacteristic();
    const { device } = makeDevice({ [UART_SERVICE_UUID]: characteristic });
    stubBluetooth(vi.fn().mockResolvedValue(device));
    const adapter = new WebBluetoothAdapter('aurora');
    await adapter.requestAndConnect();

    await expect(adapter.write(new Uint8Array([1, 2, 3]), AbortSignal.abort())).rejects.toThrow(/aborted/i);
    expect(characteristic.writeValueWithoutResponse).not.toHaveBeenCalled();
  });

  it('serializes concurrent writes so GATT operations never overlap', async () => {
    // Web Bluetooth rejects a writeValue* that starts while another is in flight.
    // Track live-write concurrency: each write holds for a macrotask so an
    // unserialized second write would overlap and push the peak above 1.
    const characteristic = makeCharacteristic();
    let inFlight = 0;
    let peakConcurrency = 0;
    characteristic.writeValueWithoutResponse.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          inFlight += 1;
          peakConcurrency = Math.max(peakConcurrency, inFlight);
          setTimeout(() => {
            inFlight -= 1;
            resolve();
          }, 1);
        }),
    );
    const { device } = makeDevice({ [UART_SERVICE_UUID]: characteristic });
    stubBluetooth(vi.fn().mockResolvedValue(device));
    const adapter = new WebBluetoothAdapter('aurora');
    await adapter.requestAndConnect();

    // Two overlapping writes, 3 chunks each — fired without awaiting the first.
    await Promise.all([adapter.write(new Uint8Array(50).fill(1)), adapter.write(new Uint8Array(50).fill(2))]);

    expect(peakConcurrency).toBe(1);
    expect(characteristic.writeValueWithoutResponse).toHaveBeenCalledTimes(6);
  });

  it('keeps the write queue alive after a failed write', async () => {
    const characteristic = makeCharacteristic();
    characteristic.writeValueWithoutResponse.mockRejectedValueOnce(new Error('transient GATT error'));
    const { device } = makeDevice({ [UART_SERVICE_UUID]: characteristic });
    stubBluetooth(vi.fn().mockResolvedValue(device));
    const adapter = new WebBluetoothAdapter('aurora');
    await adapter.requestAndConnect();

    const first = adapter.write(new Uint8Array([1]));
    const second = adapter.write(new Uint8Array([2]));
    await expect(first).rejects.toThrow(/transient GATT error/i);
    // A failed write must not poison the chain — the next write still runs.
    await expect(second).resolves.toBeUndefined();
  });

  it('retries Aurora writes with-response when the browser rejects without-response as unsupported', async () => {
    const characteristic = makeCharacteristic();
    characteristic.writeValueWithoutResponse.mockRejectedValueOnce(
      Object.assign(new Error('unsupported'), { name: 'NotSupportedError' }),
    );
    const { device } = makeDevice({ [UART_SERVICE_UUID]: characteristic });
    stubBluetooth(vi.fn().mockResolvedValue(device));
    const adapter = new WebBluetoothAdapter('aurora');
    await adapter.requestAndConnect();

    await adapter.write(new Uint8Array(30).fill(3));
    expect(characteristic.writeValueWithResponse).toHaveBeenCalled();
  });
});

describe('onDisconnect', () => {
  it('fires the callback on a gattserverdisconnected event and unsubscribes cleanly', async () => {
    const characteristic = makeCharacteristic();
    const { device } = makeDevice({ [UART_SERVICE_UUID]: characteristic });
    stubBluetooth(vi.fn().mockResolvedValue(device));
    const adapter = new WebBluetoothAdapter('aurora');
    await adapter.requestAndConnect();

    const onDisconnect = vi.fn();
    const unsubscribe = adapter.onDisconnect(onDisconnect);

    device.dispatchEvent(new Event('gattserverdisconnected'));
    expect(onDisconnect).toHaveBeenCalledTimes(1);

    // After write becomes impossible (characteristic dropped on disconnect), a
    // write rejects rather than silently no-oping.
    await expect(adapter.write(new Uint8Array([1]))).rejects.toThrow(/not connected/i);

    unsubscribe();
    device.dispatchEvent(new Event('gattserverdisconnected'));
    // Still 1 — the unsubscribe cleared the handler.
    expect(onDisconnect).toHaveBeenCalledTimes(1);
  });
});

describe('disconnect', () => {
  it('drops the GATT connection and removes the disconnect listener', async () => {
    const characteristic = makeCharacteristic();
    const { device, server } = makeDevice({ [UART_SERVICE_UUID]: characteristic });
    stubBluetooth(vi.fn().mockResolvedValue(device));
    const adapter = new WebBluetoothAdapter('aurora' as BoardScanFamily);
    await adapter.requestAndConnect();

    await adapter.disconnect();
    expect(server.disconnect).toHaveBeenCalledTimes(1);
  });
});
