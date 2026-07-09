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
  MAX_BLUETOOTH_MESSAGE_SIZE,
  UART_SERVICE_UUID,
  UART_WRITE_CHARACTERISTIC_UUID,
  REDBEARLAB_SERVICE_UUID,
  REDBEARLAB_WRITE_CHARACTERISTIC_UUID,
  INTER_CHUNK_DELAY_MS,
  splitMessages,
} from '@boardsesh/ble-protocol/transport';

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// --- Web-specific BLE helpers (use Web Bluetooth DOM types) ---

const isWithoutResponseUnsupportedError = (error: unknown) => {
  if (typeof error !== 'object' || error === null || !('name' in error)) {
    return false;
  }
  const namedError = error as { name?: unknown };
  return namedError.name === 'NotSupportedError';
};

const concatenateMessages = (messages: Uint8Array[]) => {
  const totalLength = messages.reduce((sum, message) => sum + message.byteLength, 0);
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const message of messages) {
    combined.set(message, offset);
    offset += message.byteLength;
  }
  return combined;
};

export const writeCharacteristicSeries = async (
  characteristic: BluetoothRemoteGATTCharacteristic,
  messages: Uint8Array[],
  signal?: AbortSignal,
  options?: { allowWithResponseFallback?: boolean; allowUnsupportedWithResponseRetry?: boolean },
) => {
  // Default to the proven write-without-response path. MoonBoard may choose
  // write-with-response up front for the original RedBearLab box. Aurora keeps
  // the live decision behavior-driven: it tries without-response first and only
  // retries with-response when Web Bluetooth explicitly rejects the operation
  // with NotSupportedError on a write-only characteristic.
  const useWithResponse =
    (options?.allowWithResponseFallback ?? false) && characteristic.properties?.writeWithoutResponse === false;
  const writeChunks = async (chunks: Uint8Array[], writeWithResponse: boolean) => {
    for (let messageIndex = 0; messageIndex < chunks.length; messageIndex++) {
      if (signal?.aborted) {
        throw new DOMException('Write aborted', 'AbortError');
      }
      if (messageIndex > 0) {
        await delay(INTER_CHUNK_DELAY_MS);
        if (signal?.aborted) {
          throw new DOMException('Write aborted', 'AbortError');
        }
      }
      const chunk = new Uint8Array(chunks[messageIndex]);
      if (writeWithResponse) {
        await characteristic.writeValueWithResponse(chunk);
      } else {
        await characteristic.writeValueWithoutResponse(chunk);
      }
    }
  };

  try {
    await writeChunks(messages, useWithResponse);
  } catch (error) {
    if (
      !useWithResponse &&
      (options?.allowUnsupportedWithResponseRetry ?? false) &&
      isWithoutResponseUnsupportedError(error)
    ) {
      const retryMessages = splitMessages(concatenateMessages(messages), MAX_BLUETOOTH_MESSAGE_SIZE);
      await writeChunks(retryMessages, true);
      return;
    }
    throw error;
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
