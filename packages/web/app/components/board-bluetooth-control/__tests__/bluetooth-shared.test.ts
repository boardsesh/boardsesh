import { describe, it, expect, vi } from 'vite-plus/test';
import {
  getMoonboardWriteCharacteristic,
  writeCharacteristicSeries,
  UART_SERVICE_UUID,
  UART_WRITE_CHARACTERISTIC_UUID,
  REDBEARLAB_SERVICE_UUID,
  REDBEARLAB_WRITE_CHARACTERISTIC_UUID,
} from '../bluetooth-shared';

// Map of serviceUuid -> { characteristicUuid -> characteristic object }.
type ServiceMap = Record<string, Record<string, object>>;

function makeServer(serviceMap: ServiceMap) {
  return {
    getPrimaryService: vi.fn(async (uuid: string) => {
      const characteristics = serviceMap[uuid];
      if (!characteristics) throw new Error(`GATT service ${uuid} not found`);
      return {
        getCharacteristic: vi.fn(async (characteristicUuid: string) => {
          const characteristic = characteristics[characteristicUuid];
          if (!characteristic) throw new Error(`Characteristic ${characteristicUuid} not found`);
          return characteristic;
        }),
      };
    }),
  };
}

function makeDevice(serviceMap: ServiceMap | 'no-gatt') {
  if (serviceMap === 'no-gatt') {
    return { gatt: undefined } as unknown as BluetoothDevice;
  }
  const server = makeServer(serviceMap);
  return { gatt: { connect: vi.fn(async () => server) } } as unknown as BluetoothDevice;
}

const uartChar = { id: 'uart-write' };
const redBearLabChar = { id: 'redbearlab-write' };

describe('getMoonboardWriteCharacteristic (UART → RedBearLab fallback)', () => {
  it('returns the Nordic UART write characteristic when present', async () => {
    const device = makeDevice({ [UART_SERVICE_UUID]: { [UART_WRITE_CHARACTERISTIC_UUID]: uartChar } });
    expect(await getMoonboardWriteCharacteristic(device)).toBe(uartChar);
  });

  it('falls back to the RedBearLab write characteristic when UART is absent', async () => {
    const device = makeDevice({
      [REDBEARLAB_SERVICE_UUID]: { [REDBEARLAB_WRITE_CHARACTERISTIC_UUID]: redBearLabChar },
    });
    expect(await getMoonboardWriteCharacteristic(device)).toBe(redBearLabChar);
  });

  it('prefers UART when both controller generations are present', async () => {
    const device = makeDevice({
      [UART_SERVICE_UUID]: { [UART_WRITE_CHARACTERISTIC_UUID]: uartChar },
      [REDBEARLAB_SERVICE_UUID]: { [REDBEARLAB_WRITE_CHARACTERISTIC_UUID]: redBearLabChar },
    });
    expect(await getMoonboardWriteCharacteristic(device)).toBe(uartChar);
  });

  it('falls back to RedBearLab when the UART service exists but lacks its write characteristic', async () => {
    const device = makeDevice({
      [UART_SERVICE_UUID]: {},
      [REDBEARLAB_SERVICE_UUID]: { [REDBEARLAB_WRITE_CHARACTERISTIC_UUID]: redBearLabChar },
    });
    expect(await getMoonboardWriteCharacteristic(device)).toBe(redBearLabChar);
  });

  it('returns undefined when neither controller generation is present', async () => {
    const device = makeDevice({});
    expect(await getMoonboardWriteCharacteristic(device)).toBeUndefined();
  });

  it('returns undefined when the device has no GATT server', async () => {
    expect(await getMoonboardWriteCharacteristic(makeDevice('no-gatt'))).toBeUndefined();
  });
});

function makeWritableCharacteristic(writeWithoutResponse?: boolean) {
  return {
    properties: writeWithoutResponse === undefined ? undefined : { writeWithoutResponse },
    writeValueWithoutResponse: vi.fn().mockResolvedValue(undefined),
    writeValueWithResponse: vi.fn().mockResolvedValue(undefined),
  } as unknown as BluetoothRemoteGATTCharacteristic & {
    writeValueWithoutResponse: ReturnType<typeof vi.fn>;
    writeValueWithResponse: ReturnType<typeof vi.fn>;
  };
}

describe('writeCharacteristicSeries (write-type gating)', () => {
  it('uses write-without-response when the characteristic advertises it (Nordic UART path)', async () => {
    const characteristic = makeWritableCharacteristic(true);
    await writeCharacteristicSeries(characteristic, [new Uint8Array([1, 2, 3])]);
    expect(characteristic.writeValueWithoutResponse).toHaveBeenCalledTimes(1);
    expect(characteristic.writeValueWithResponse).not.toHaveBeenCalled();
  });

  it('uses write-with-response when the characteristic lacks the no-response property (RedBearLab path)', async () => {
    const characteristic = makeWritableCharacteristic(false);
    await writeCharacteristicSeries(characteristic, [new Uint8Array([1, 2, 3])]);
    expect(characteristic.writeValueWithResponse).toHaveBeenCalledTimes(1);
    expect(characteristic.writeValueWithoutResponse).not.toHaveBeenCalled();
  });

  it('defaults to write-without-response when properties are unavailable', async () => {
    const characteristic = makeWritableCharacteristic(undefined);
    await writeCharacteristicSeries(characteristic, [new Uint8Array([1])]);
    expect(characteristic.writeValueWithoutResponse).toHaveBeenCalledTimes(1);
  });

  it('writes every chunk in sequence', async () => {
    const characteristic = makeWritableCharacteristic(true);
    await writeCharacteristicSeries(characteristic, [new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3])]);
    expect(characteristic.writeValueWithoutResponse).toHaveBeenCalledTimes(3);
  });

  it('throws AbortError when the signal is already aborted', async () => {
    const characteristic = makeWritableCharacteristic(true);
    const controller = new AbortController();
    controller.abort();
    await expect(writeCharacteristicSeries(characteristic, [new Uint8Array([1])], controller.signal)).rejects.toThrow(
      'Write aborted',
    );
    expect(characteristic.writeValueWithoutResponse).not.toHaveBeenCalled();
  });
});
