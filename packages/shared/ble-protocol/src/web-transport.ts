// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

// Browser-side Web Bluetooth transport shared by the Next.js web app
// (packages/web) and the Expo-web mobile adapter (packages/mobile). It drives
// the same Aurora / MoonBoard LED protocol through the browser's Web Bluetooth
// API: request-device options, characteristic probing, and the chunked-write
// series with the write-with-response fallbacks.
//
// Renderer-agnostic and platform-I/O-free: it touches only the Web Bluetooth
// surface, reached through `globalThis.navigator` so there is no dependency on
// lib.dom or `@types/web-bluetooth`. The minimal type surface below is declared
// locally (a structural subset of the W3C spec) so consumers on either side —
// web's global `@types/web-bluetooth` or mobile's ambient-free adapter — pass
// their own device objects in by structural typing. Keeping the package free of
// a web-bluetooth type dependency also keeps it out of the mobile OTA
// fingerprint.

import {
  MAX_BLUETOOTH_MESSAGE_SIZE,
  INTER_CHUNK_DELAY_MS,
  AURORA_ADVERTISED_SERVICE_UUID,
  UART_SERVICE_UUID,
  UART_WRITE_CHARACTERISTIC_UUID,
  REDBEARLAB_SERVICE_UUID,
  REDBEARLAB_WRITE_CHARACTERISTIC_UUID,
  splitMessages,
} from './transport';
import { MOONBOARD_DEVICE_NAME_PREFIXES } from '@boardsesh/board-constants/moonboard';

// --- Minimal Web Bluetooth type surface -------------------------------------
// Only the members these helpers touch — a structural subset of the W3C spec so
// both a full `@types/web-bluetooth` device (web) and an ambient-free device
// (mobile) satisfy it by shape. Write methods take `Uint8Array` (never lib.dom's
// `BufferSource`) so the package needs no DOM lib.

export interface WebBluetoothCharacteristicProperties {
  readonly writeWithoutResponse: boolean;
}

export interface WebBluetoothRemoteGATTCharacteristic {
  readonly properties?: WebBluetoothCharacteristicProperties;
  writeValueWithResponse(value: Uint8Array): Promise<void>;
  writeValueWithoutResponse(value: Uint8Array): Promise<void>;
}

export interface WebBluetoothRemoteGATTService {
  getCharacteristic(characteristicUuid: string): Promise<WebBluetoothRemoteGATTCharacteristic>;
}

export interface WebBluetoothRemoteGATTServer {
  readonly connected: boolean;
  connect(): Promise<WebBluetoothRemoteGATTServer>;
  disconnect(): void;
  getPrimaryService(serviceUuid: string): Promise<WebBluetoothRemoteGATTService>;
}

export interface WebBluetoothDevice {
  readonly id: string;
  readonly name?: string;
  readonly gatt?: WebBluetoothRemoteGATTServer;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface WebRequestDeviceOptions {
  filters?: Array<{ services?: string[]; namePrefix?: string; name?: string }>;
  optionalServices?: string[];
  acceptAllDevices?: boolean;
}

interface WebBluetooth {
  requestDevice(options: WebRequestDeviceOptions): Promise<WebBluetoothDevice>;
}

const delay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

// Android Chrome can reject the first GATT connection attempt with a transient
// NetworkError, then accept the same granted device handle moments later. Keep
// this deliberately small: one retry is enough for that race, without turning a
// genuinely unreachable board into a long-running retry loop.
const GATT_CONNECT_RETRY_DELAY_MS = 500;

function isRetryableGattConnectError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: unknown }).name === 'NetworkError'
  );
}

/**
 * Connect an already-granted device without ever reopening the chooser.
 *
 * Web Bluetooth does not expose an AbortSignal or a safe cancellation API for
 * a pending `connect()`, so this bounds only settled, retryable failures: one
 * 500 ms wait and one more call on the same GATT handle. Do not add a racing
 * timeout here; retrying while the original browser operation is still pending
 * can itself produce "GATT operation already in progress" failures.
 */
async function connectWebBluetoothGattServer(
  device: WebBluetoothDevice,
): Promise<WebBluetoothRemoteGATTServer | undefined> {
  const gatt = device.gatt;
  if (!gatt || gatt.connected) return gatt;

  try {
    return await gatt.connect();
  } catch (error) {
    if (!isRetryableGattConnectError(error)) throw error;
  }

  await delay(GATT_CONNECT_RETRY_DELAY_MS);
  return gatt.connect();
}

// --- Availability + device request ------------------------------------------

/**
 * The single `navigator.bluetooth` accessor. Reached through `globalThis` and a
 * narrow cast so this stays free of lib.dom / ambient globals; returns undefined
 * on any browser without Web Bluetooth (Firefox, Safari) or outside a browser.
 */
function getWebBluetooth(): WebBluetooth | undefined {
  const navigatorLike = (globalThis as { navigator?: { bluetooth?: WebBluetooth } }).navigator;
  return navigatorLike?.bluetooth;
}

/**
 * True only on a Chromium browser in a secure context, where
 * `navigator.bluetooth` is present. Every other browser leaves it undefined and
 * the caller shows its existing "Bluetooth unavailable" state.
 */
export function isWebBluetoothAvailable(): boolean {
  return getWebBluetooth() !== undefined;
}

/** Open the browser device chooser for the given request options. */
export function requestWebBluetoothDevice(options: WebRequestDeviceOptions): Promise<WebBluetoothDevice> {
  const bluetooth = getWebBluetooth();
  if (!bluetooth) {
    return Promise.reject(new Error('Web Bluetooth is not available in this browser'));
  }
  return bluetooth.requestDevice(options);
}

// --- Request-device options -------------------------------------------------
// Built from the shared protocol UUIDs so the browser chooser only surfaces
// boards we can actually drive. Aurora boards always advertise the Aurora
// service; MoonBoard spans two controller generations (Nordic UART + the
// original RedBearLab box) and some units advertise only a name prefix, so all
// three discovery paths are listed. `optionalServices` must name every service
// getPrimaryService reaches after connect — Web Bluetooth blocks access to any
// service not pre-declared here.

export const AURORA_REQUEST_DEVICE_OPTIONS: WebRequestDeviceOptions = {
  filters: [{ services: [AURORA_ADVERTISED_SERVICE_UUID] }],
  optionalServices: [UART_SERVICE_UUID],
};

export const MOONBOARD_REQUEST_DEVICE_OPTIONS: WebRequestDeviceOptions = {
  filters: [
    { services: [UART_SERVICE_UUID] },
    { services: [REDBEARLAB_SERVICE_UUID] },
    ...MOONBOARD_DEVICE_NAME_PREFIXES.map((namePrefix) => ({ namePrefix })),
  ],
  optionalServices: [UART_SERVICE_UUID, REDBEARLAB_SERVICE_UUID],
};

export function requestDeviceOptionsForFamily(scanFamily: 'aurora' | 'moonboard'): WebRequestDeviceOptions {
  return scanFamily === 'moonboard' ? MOONBOARD_REQUEST_DEVICE_OPTIONS : AURORA_REQUEST_DEVICE_OPTIONS;
}

// --- Characteristic probing -------------------------------------------------

export async function getUartCharacteristic(
  device: WebBluetoothDevice,
): Promise<WebBluetoothRemoteGATTCharacteristic | undefined> {
  const server = await connectWebBluetoothGattServer(device);
  const service = await server?.getPrimaryService(UART_SERVICE_UUID);
  return service?.getCharacteristic(UART_WRITE_CHARACTERISTIC_UUID);
}

async function tryGetWriteCharacteristic(
  server: WebBluetoothRemoteGATTServer,
  serviceUuid: string,
  characteristicUuid: string,
): Promise<WebBluetoothRemoteGATTCharacteristic | undefined> {
  try {
    const service = await server.getPrimaryService(serviceUuid);
    return await service.getCharacteristic(characteristicUuid);
  } catch {
    // getPrimaryService / getCharacteristic reject when the service or
    // characteristic isn't present — let the caller fall back to the next path.
    return undefined;
  }
}

/**
 * Resolve the MoonBoard write characteristic, trying the newer Nordic-UART
 * controller first and falling back to the original RedBearLab LED box. Returns
 * undefined when neither generation exposes its write characteristic.
 */
export async function getMoonboardWriteCharacteristic(
  device: WebBluetoothDevice,
): Promise<WebBluetoothRemoteGATTCharacteristic | undefined> {
  const server = await connectWebBluetoothGattServer(device);
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

export async function writeCharacteristicSeries(
  characteristic: WebBluetoothRemoteGATTCharacteristic,
  messages: Uint8Array[],
  signal?: AbortSignal,
  options?: {
    forceWithResponse?: boolean;
    allowWithResponseFallback?: boolean;
    allowUnsupportedWithResponseRetry?: boolean;
  },
): Promise<void> {
  // Default to the proven write-without-response path. MoonBoard may choose
  // write-with-response up front for the original RedBearLab box (its LED
  // characteristic advertises `.write` only). Aurora keeps the decision
  // behaviour-driven: it tries without-response first and only retries
  // with-response when Web Bluetooth rejects the operation with
  // NotSupportedError on a write-only characteristic.
  //
  // `forceWithResponse` overrides all of that: a board whose firmware only
  // acknowledges written chunks (Woods, protocol spec §8) drops
  // write-without-response silently, and the characteristic still ADVERTISES
  // writeWithoutResponse — so neither the property probe nor the
  // NotSupportedError retry would ever catch it. The caller states the
  // requirement instead of hoping the browser reports it.
  const useWithResponse =
    (options?.forceWithResponse ?? false) ||
    ((options?.allowWithResponseFallback ?? false) && characteristic.properties?.writeWithoutResponse === false);

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
    if (
      !useWithResponse &&
      (options?.allowUnsupportedWithResponseRetry ?? false) &&
      isWithoutResponseUnsupportedError(error)
    ) {
      // Re-chunk defensively: callers that pre-split at MAX_BLUETOOTH_MESSAGE_SIZE
      // get identical chunks, while a caller passing a single unsplit message
      // still gets a spec-legal chunked with-response retry.
      const retryMessages = splitMessages(concatenateMessages(messages), MAX_BLUETOOTH_MESSAGE_SIZE);
      await writeChunks(retryMessages, true);
      return;
    }
    throw error;
  }
}
