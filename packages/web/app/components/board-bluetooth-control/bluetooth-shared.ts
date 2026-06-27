// Re-export pure transport constants/helpers from the shared BLE protocol package.
export {
  MAX_BLUETOOTH_MESSAGE_SIZE,
  MESSAGE_BODY_MAX_LENGTH,
  AURORA_ADVERTISED_SERVICE_UUID,
  UART_SERVICE_UUID,
  UART_WRITE_CHARACTERISTIC_UUID,
  REDBEARLAB_SERVICE_UUID,
  REDBEARLAB_WRITE_CHARACTERISTIC_UUID,
  splitMessages,
} from '@boardsesh/ble-protocol/transport';

import {
  UART_SERVICE_UUID,
  UART_WRITE_CHARACTERISTIC_UUID,
  REDBEARLAB_SERVICE_UUID,
  REDBEARLAB_WRITE_CHARACTERISTIC_UUID,
  INTER_CHUNK_DELAY_MS,
} from '@boardsesh/ble-protocol/transport';

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// --- Web-specific BLE helpers (use Web Bluetooth DOM types) ---

export const writeCharacteristicSeries = async (
  characteristic: BluetoothRemoteGATTCharacteristic,
  messages: Uint8Array[],
  signal?: AbortSignal,
) => {
  // The Nordic-UART RX characteristic supports write-without-response; the
  // original MoonBoard (RedBearLab) write characteristic advertises only
  // `.write`, and Web Bluetooth throws NotSupportedError if you call
  // writeValueWithoutResponse on a characteristic that lacks the property. So
  // pick the write method from the advertised property — mirrors the native
  // `preferredWriteType` gating. Default to without-response when properties
  // are unavailable to preserve the proven Aurora path.
  const supportsWithoutResponse = characteristic.properties?.writeWithoutResponse ?? true;
  for (let i = 0; i < messages.length; i++) {
    if (signal?.aborted) {
      throw new DOMException('Write aborted', 'AbortError');
    }
    if (i > 0) {
      await delay(INTER_CHUNK_DELAY_MS);
    }
    const chunk = new Uint8Array(messages[i]);
    if (supportsWithoutResponse) {
      await characteristic.writeValueWithoutResponse(chunk);
    } else {
      await characteristic.writeValueWithResponse(chunk);
    }
  }
};

export const requestBluetoothDevice = async (options: RequestDeviceOptions) =>
  navigator.bluetooth.requestDevice(options);

const tryGetWriteCharacteristic = async (
  server: BluetoothRemoteGATTServer,
  serviceUuid: string,
  characteristicUuid: string,
): Promise<BluetoothRemoteGATTCharacteristic | undefined> => {
  try {
    const service = await server.getPrimaryService(serviceUuid);
    return await service.getCharacteristic(characteristicUuid);
  } catch {
    // getPrimaryService / getCharacteristic reject when the service or
    // characteristic isn't present — let the caller fall back to the next path.
    return undefined;
  }
};

export const getUartCharacteristic = async (device: BluetoothDevice) => {
  const server = await device.gatt?.connect();
  const service = await server?.getPrimaryService(UART_SERVICE_UUID);
  return await service?.getCharacteristic(UART_WRITE_CHARACTERISTIC_UUID);
};

/**
 * Resolve the MoonBoard write characteristic, trying the newer Nordic-UART
 * controller first and falling back to the original RedBearLab LED box. Returns
 * undefined when neither generation exposes its write characteristic.
 */
export const getMoonboardWriteCharacteristic = async (device: BluetoothDevice) => {
  const server = await device.gatt?.connect();
  if (!server) return undefined;
  const uart = await tryGetWriteCharacteristic(server, UART_SERVICE_UUID, UART_WRITE_CHARACTERISTIC_UUID);
  if (uart) return uart;
  return tryGetWriteCharacteristic(server, REDBEARLAB_SERVICE_UUID, REDBEARLAB_WRITE_CHARACTERISTIC_UUID);
};
