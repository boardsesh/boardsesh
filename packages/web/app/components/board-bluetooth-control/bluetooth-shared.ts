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
  options?: { allowWithResponseFallback?: boolean },
) => {
  // Aurora (Kilter/Tension) MUST always use write-without-response: it is the
  // proven path, and routing it to write-with-response stalls boards whose ATT
  // ack never arrives (the iOS-26 regression that #3228 fixed). Only the
  // MoonBoard family may fall back to write-with-response, and only for the
  // original RedBearLab box whose characteristic advertises `.write` only (Web
  // Bluetooth throws NotSupportedError if you call writeValueWithoutResponse on
  // it). This mirrors the RN adapter's scanFamily gate and the native
  // preferredWriteType. Default (no fallback allowed) preserves the proven
  // Aurora path exactly.
  const useWithResponse =
    (options?.allowWithResponseFallback ?? false) && characteristic.properties?.writeWithoutResponse === false;
  for (let i = 0; i < messages.length; i++) {
    if (signal?.aborted) {
      throw new DOMException('Write aborted', 'AbortError');
    }
    if (i > 0) {
      await delay(INTER_CHUNK_DELAY_MS);
    }
    const chunk = new Uint8Array(messages[i]);
    if (useWithResponse) {
      await characteristic.writeValueWithResponse(chunk);
    } else {
      await characteristic.writeValueWithoutResponse(chunk);
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
