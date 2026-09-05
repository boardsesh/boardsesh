// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REDBEARLAB_SERVICE_UUID, UART_SERVICE_UUID } from '../transport';
import {
  getMoonboardWriteCharacteristic,
  getUartCharacteristic,
  type WebBluetoothDevice,
  type WebBluetoothRemoteGATTCharacteristic,
  type WebBluetoothRemoteGATTServer,
} from '../web-transport';

// Deliberately independent of the private source constant: 500 ms is the issue
// contract, so these tests must fail if production timing drifts from it.
const EXPECTED_GATT_CONNECT_RETRY_DELAY_MS = 500;

type ProbeCharacteristic = (device: WebBluetoothDevice) => Promise<WebBluetoothRemoteGATTCharacteristic | undefined>;

function namedError(name: string): Error {
  return Object.assign(new Error(`${name} from browser`), { name });
}

function makeCharacteristic(): WebBluetoothRemoteGATTCharacteristic {
  return {
    writeValueWithResponse: vi.fn().mockResolvedValue(undefined),
    writeValueWithoutResponse: vi.fn().mockResolvedValue(undefined),
  };
}

function makeDevice(
  characteristicsByService: Record<string, WebBluetoothRemoteGATTCharacteristic>,
  options: { connected?: boolean } = {},
) {
  const server = {
    connected: options.connected ?? false,
    connect: vi.fn(),
    disconnect: vi.fn(),
    getPrimaryService: vi.fn(async (serviceUuid: string) => {
      const characteristic = characteristicsByService[serviceUuid];
      if (!characteristic) throw new Error(`No service ${serviceUuid}`);
      return {
        getCharacteristic: vi.fn(async () => characteristic),
      };
    }),
  } as WebBluetoothRemoteGATTServer & {
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    getPrimaryService: ReturnType<typeof vi.fn>;
  };
  server.connect.mockResolvedValue(server);

  const device = {
    id: 'already-granted-device',
    gatt: server,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as WebBluetoothDevice;

  return { device, server };
}

async function expectNetworkErrorRetry(
  probeCharacteristic: ProbeCharacteristic,
  characteristicsByService: Record<string, WebBluetoothRemoteGATTCharacteristic>,
): Promise<void> {
  const expectedCharacteristic = Object.values(characteristicsByService)[0];
  const { device, server } = makeDevice(characteristicsByService);
  server.connect.mockRejectedValueOnce(namedError('NetworkError')).mockResolvedValueOnce(server);

  const probePromise = probeCharacteristic(device);
  await Promise.resolve();

  expect(server.connect).toHaveBeenCalledTimes(1);
  expect(server.disconnect).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(1);

  await vi.advanceTimersByTimeAsync(EXPECTED_GATT_CONNECT_RETRY_DELAY_MS - 1);
  expect(server.connect).toHaveBeenCalledTimes(1);
  expect(server.disconnect).not.toHaveBeenCalled();

  await vi.advanceTimersByTimeAsync(1);
  await expect(probePromise).resolves.toBe(expectedCharacteristic);
  expect(server.connect).toHaveBeenCalledTimes(2);
  expect(server.disconnect).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Web Bluetooth GATT connection retry (#4144)', () => {
  it('retries an Aurora UART connect NetworkError once after the exact backoff', async () => {
    await expectNetworkErrorRetry(getUartCharacteristic, { [UART_SERVICE_UUID]: makeCharacteristic() });
  });

  it('retries a MoonBoard connect NetworkError before probing its UART path', async () => {
    await expectNetworkErrorRetry(getMoonboardWriteCharacteristic, { [UART_SERVICE_UUID]: makeCharacteristic() });
  });

  it('keeps MoonBoard RedBearLab fallback behavior after a recovered connection', async () => {
    await expectNetworkErrorRetry(getMoonboardWriteCharacteristic, { [REDBEARLAB_SERVICE_UUID]: makeCharacteristic() });
  });

  it.each(['NotFoundError', 'SecurityError', 'NotSupportedError', 'InvalidStateError', 'AbortError', 'Error'])(
    'does not retry a %s GATT connect rejection',
    async (errorName) => {
      const { device, server } = makeDevice({ [UART_SERVICE_UUID]: makeCharacteristic() });
      const error = namedError(errorName);
      server.connect.mockRejectedValueOnce(error);

      await expect(getUartCharacteristic(device)).rejects.toBe(error);

      expect(server.connect).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('does not retry a real TypeError GATT connect rejection', async () => {
    const { device, server } = makeDevice({ [UART_SERVICE_UUID]: makeCharacteristic() });
    const error = new TypeError('Bluetooth permission was denied');
    server.connect.mockRejectedValueOnce(error);

    await expect(getUartCharacteristic(device)).rejects.toBe(error);

    expect(server.connect).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not retry a downstream Aurora service rejection', async () => {
    const { device, server } = makeDevice({ [UART_SERVICE_UUID]: makeCharacteristic() });
    const serviceError = new Error('UART service failed after connect');
    server.getPrimaryService.mockRejectedValueOnce(serviceError);

    await expect(getUartCharacteristic(device)).rejects.toBe(serviceError);

    expect(server.connect).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not retry a downstream Aurora characteristic rejection', async () => {
    const { device, server } = makeDevice({ [UART_SERVICE_UUID]: makeCharacteristic() });
    const characteristicError = new Error('UART characteristic failed after connect');
    server.getPrimaryService.mockResolvedValueOnce({
      getCharacteristic: vi.fn().mockRejectedValueOnce(characteristicError),
    });

    await expect(getUartCharacteristic(device)).rejects.toBe(characteristicError);

    expect(server.connect).toHaveBeenCalledTimes(1);
    expect(server.getPrimaryService).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not retry MoonBoard service probing failures', async () => {
    const { device, server } = makeDevice({});

    await expect(getMoonboardWriteCharacteristic(device)).resolves.toBeUndefined();

    expect(server.connect).toHaveBeenCalledTimes(1);
    expect(server.getPrimaryService).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses an already-connected GATT server without reconnecting', async () => {
    const characteristic = makeCharacteristic();
    const { device, server } = makeDevice({ [UART_SERVICE_UUID]: characteristic }, { connected: true });

    await expect(getUartCharacteristic(device)).resolves.toBe(characteristic);

    expect(server.connect).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves the no-GATT undefined result without scheduling a retry', async () => {
    const device = { id: 'no-gatt', addEventListener: vi.fn(), removeEventListener: vi.fn() } as WebBluetoothDevice;

    await expect(getUartCharacteristic(device)).resolves.toBeUndefined();
    await expect(getMoonboardWriteCharacteristic(device)).resolves.toBeUndefined();

    expect(vi.getTimerCount()).toBe(0);
  });

  it('rethrows the second NetworkError and leaves no retry timer behind', async () => {
    const { device, server } = makeDevice({ [UART_SERVICE_UUID]: makeCharacteristic() });
    const firstError = namedError('NetworkError');
    const secondError = namedError('NetworkError');
    server.connect.mockRejectedValueOnce(firstError).mockRejectedValueOnce(secondError);

    const probePromise = getUartCharacteristic(device);
    const settledProbe = probePromise.catch((error: unknown) => error);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(EXPECTED_GATT_CONNECT_RETRY_DELAY_MS);

    await expect(settledProbe).resolves.toBe(secondError);
    expect(server.connect).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
