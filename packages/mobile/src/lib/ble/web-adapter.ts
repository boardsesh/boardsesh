// Web Bluetooth implementation of the mobile `BluetoothAdapter` interface,
// selected by Metro's platform resolver via adapter-factory.web.ts.
//
// This is the Expo-web twin of the native RN adapters (react-native-ble-plx on
// Android, the Swift BoardBleManager on iOS). It drives the same Aurora /
// MoonBoard LED protocol through the browser's Web Bluetooth API. The transport
// constants (service/characteristic UUIDs, chunk size, split logic) come from
// the shared, pure-bytes `@boardsesh/ble-protocol` package — reused, never
// reimplemented. The characteristic-probing and chunked-write helpers are
// ported from the Next.js web app's adapter (packages/web/app/lib/ble) into
// this mobile-local module rather than cross-imported, since packages/web is
// not on the mobile graph.
//
// Web Bluetooth DOM types are declared locally in web-bluetooth.d.ts (no
// @types/web-bluetooth dependency — see that file for the fingerprint rationale).

import {
  INTER_CHUNK_DELAY_MS,
  MAX_BLUETOOTH_MESSAGE_SIZE,
  AURORA_ADVERTISED_SERVICE_UUID,
  UART_SERVICE_UUID,
  UART_WRITE_CHARACTERISTIC_UUID,
  REDBEARLAB_SERVICE_UUID,
  REDBEARLAB_WRITE_CHARACTERISTIC_UUID,
  splitMessages,
} from '@boardsesh/ble-protocol/transport';
import { MOONBOARD_DEVICE_NAME_PREFIXES } from '@boardsesh/board-constants/moonboard';
import type { BleConnection, BluetoothAdapter, BoardScanFamily } from './types';

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// --- Request-device filters -------------------------------------------------
// Built from the shared protocol UUIDs so the browser chooser only surfaces
// boards we can actually drive. Aurora boards always advertise the Aurora
// service; MoonBoard spans two controller generations (Nordic UART + the
// original RedBearLab box) and some units advertise only a name prefix, so all
// three discovery paths are listed. `optionalServices` must name every service
// getPrimaryService reaches after connect — Web Bluetooth blocks access to any
// service not pre-declared here.

const AURORA_REQUEST_DEVICE_OPTIONS: RequestDeviceOptions = {
  filters: [{ services: [AURORA_ADVERTISED_SERVICE_UUID] }],
  optionalServices: [UART_SERVICE_UUID],
};

const MOONBOARD_REQUEST_DEVICE_OPTIONS: RequestDeviceOptions = {
  filters: [
    { services: [UART_SERVICE_UUID] },
    { services: [REDBEARLAB_SERVICE_UUID] },
    ...MOONBOARD_DEVICE_NAME_PREFIXES.map((namePrefix) => ({ namePrefix })),
  ],
  optionalServices: [UART_SERVICE_UUID, REDBEARLAB_SERVICE_UUID],
};

export function requestDeviceOptionsForFamily(scanFamily: BoardScanFamily): RequestDeviceOptions {
  return scanFamily === 'moonboard' ? MOONBOARD_REQUEST_DEVICE_OPTIONS : AURORA_REQUEST_DEVICE_OPTIONS;
}

// Single source of truth for "can this browser talk to a board over BLE". True
// only on a Chromium browser in a secure context, where navigator.bluetooth is
// present; every other browser (Firefox, Safari) leaves it undefined and the
// shared BLE UI shows its existing "Bluetooth unavailable" state.
export function isWebBluetoothAvailable(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.bluetooth;
}

// --- Characteristic probing -------------------------------------------------

async function getUartCharacteristic(device: BluetoothDevice): Promise<BluetoothRemoteGATTCharacteristic | undefined> {
  const server = await device.gatt?.connect();
  const service = await server?.getPrimaryService(UART_SERVICE_UUID);
  return service?.getCharacteristic(UART_WRITE_CHARACTERISTIC_UUID);
}

async function tryGetWriteCharacteristic(
  server: BluetoothRemoteGATTServer,
  serviceUuid: string,
  characteristicUuid: string,
): Promise<BluetoothRemoteGATTCharacteristic | undefined> {
  try {
    const service = await server.getPrimaryService(serviceUuid);
    return await service.getCharacteristic(characteristicUuid);
  } catch {
    // getPrimaryService / getCharacteristic reject when the service or
    // characteristic isn't present — let the caller fall back to the next path.
    return undefined;
  }
}

// Resolve the MoonBoard write characteristic, trying the newer Nordic-UART
// controller first and falling back to the original RedBearLab LED box.
async function getMoonboardWriteCharacteristic(
  device: BluetoothDevice,
): Promise<BluetoothRemoteGATTCharacteristic | undefined> {
  const server = await device.gatt?.connect();
  if (!server) return undefined;
  const uart = await tryGetWriteCharacteristic(server, UART_SERVICE_UUID, UART_WRITE_CHARACTERISTIC_UUID);
  if (uart) return uart;
  return tryGetWriteCharacteristic(server, REDBEARLAB_SERVICE_UUID, REDBEARLAB_WRITE_CHARACTERISTIC_UUID);
}

// --- Chunked write series ---------------------------------------------------

const isWithoutResponseUnsupportedError = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null || !('name' in error)) return false;
  return (error as { name?: unknown }).name === 'NotSupportedError';
};

const concatenateMessages = (messages: Uint8Array[]): Uint8Array => {
  const totalLength = messages.reduce((sum, message) => sum + message.byteLength, 0);
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const message of messages) {
    combined.set(message, offset);
    offset += message.byteLength;
  }
  return combined;
};

async function writeCharacteristicSeries(
  characteristic: BluetoothRemoteGATTCharacteristic,
  messages: Uint8Array[],
  signal: AbortSignal | undefined,
  options: { allowWithResponseFallback: boolean; allowUnsupportedWithResponseRetry: boolean },
): Promise<void> {
  // Default to the proven write-without-response path. MoonBoard may choose
  // write-with-response up front for the original RedBearLab box (its LED
  // characteristic advertises `.write` only). Aurora keeps the decision
  // behaviour-driven: it tries without-response first and only retries
  // with-response when Web Bluetooth rejects the operation with
  // NotSupportedError on a write-only characteristic.
  const useWithResponse =
    options.allowWithResponseFallback && characteristic.properties?.writeWithoutResponse === false;

  const writeChunks = async (chunks: Uint8Array[], writeWithResponse: boolean) => {
    for (let messageIndex = 0; messageIndex < chunks.length; messageIndex++) {
      if (signal?.aborted) throw new DOMException('Write aborted', 'AbortError');
      if (messageIndex > 0) {
        await delay(INTER_CHUNK_DELAY_MS);
        if (signal?.aborted) throw new DOMException('Write aborted', 'AbortError');
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
    if (!useWithResponse && options.allowUnsupportedWithResponseRetry && isWithoutResponseUnsupportedError(error)) {
      const retryMessages = splitMessages(concatenateMessages(messages), MAX_BLUETOOTH_MESSAGE_SIZE);
      await writeChunks(retryMessages, true);
      return;
    }
    throw error;
  }
}

// --- Adapter ----------------------------------------------------------------

export class WebBluetoothAdapter implements BluetoothAdapter {
  private device: BluetoothDevice | null = null;
  private characteristic: BluetoothRemoteGATTCharacteristic | null = null;
  private disconnectHandler: (() => void) | null = null;

  constructor(private readonly scanFamily: BoardScanFamily) {}

  isAvailable(): Promise<boolean> {
    return Promise.resolve(isWebBluetoothAvailable());
  }

  async requestAndConnect(_targetSerial?: string): Promise<BleConnection> {
    if (!isWebBluetoothAvailable() || !navigator.bluetooth) {
      throw new Error('Web Bluetooth is not available in this browser');
    }

    // Drop any listeners bound to a previously-selected device before picking a
    // new one, so a re-request never leaks the old disconnect subscription.
    this.cleanupListeners();

    const device = await navigator.bluetooth.requestDevice(requestDeviceOptionsForFamily(this.scanFamily));
    const characteristic =
      this.scanFamily === 'moonboard'
        ? await getMoonboardWriteCharacteristic(device)
        : await getUartCharacteristic(device);

    if (!characteristic) {
      throw new Error('Failed to resolve the board write characteristic');
    }

    device.addEventListener('gattserverdisconnected', this.handleDisconnect);
    this.device = device;
    this.characteristic = characteristic;

    return {
      deviceId: device.id,
      deviceName: device.name ?? undefined,
    };
  }

  disconnect(): Promise<void> {
    if (this.device?.gatt?.connected) {
      this.device.gatt.disconnect();
    }
    this.cleanupListeners();
    this.device = null;
    this.characteristic = null;
    return Promise.resolve();
  }

  async write(data: Uint8Array, signal?: AbortSignal): Promise<void> {
    if (!this.characteristic) {
      throw new Error('Not connected');
    }
    const messages = splitMessages(data);
    // MoonBoard may choose write-with-response up front for the RedBearLab box;
    // Aurora starts without-response and only retries with-response when Web
    // Bluetooth rejects the write as unsupported by this characteristic.
    await writeCharacteristicSeries(this.characteristic, messages, signal, {
      allowWithResponseFallback: this.scanFamily === 'moonboard',
      allowUnsupportedWithResponseRetry: this.scanFamily !== 'moonboard',
    });
  }

  onDisconnect(callback: () => void): () => void {
    this.disconnectHandler = callback;
    return () => {
      this.disconnectHandler = null;
    };
  }

  private handleDisconnect = (): void => {
    this.characteristic = null;
    this.disconnectHandler?.();
  };

  private cleanupListeners(): void {
    if (this.device) {
      this.device.removeEventListener('gattserverdisconnected', this.handleDisconnect);
    }
  }
}
