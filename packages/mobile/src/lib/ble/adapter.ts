import { type Device, type Characteristic } from 'react-native-ble-plx';
import {
  AURORA_ADVERTISED_SERVICE_UUID,
  UART_SERVICE_UUID,
  UART_WRITE_CHARACTERISTIC_UUID,
  splitMessages,
  INTER_CHUNK_DELAY_MS,
  parseSerialNumber,
} from '@boardsesh/ble-protocol';
import { bleManager } from './ble-manager';
import { waitForBlePoweredOn } from './availability';
import { isLikelyBoardDevice } from './board-device-filter';
import { upsertDiscoveredDevice } from './scan-device-cache';
import { recordBleEvent } from './ble-diagnostics-log';
import type { BluetoothAdapter, BleConnection, BoardScanFamily, DevicePickerFn, DiscoveredDevice } from './types';
import { SCAN_TIMEOUT_MS, SERIAL_RECONNECT_GRACE_MS } from '@boardsesh/ble-protocol/scan-constants';

const CONNECTION_TIMEOUT_MS = 12_000;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class RNBleAdapter implements BluetoothAdapter {
  private connectedDevice: Device | null = null;
  private writeCharacteristic: Characteristic | null = null;
  private disconnectCallback: (() => void) | null = null;
  private disconnectSubscription: { remove: () => void } | null = null;

  constructor(
    private readonly devicePicker: DevicePickerFn,
    private readonly scanFamily: BoardScanFamily = 'aurora',
  ) {}

  async isAvailable(): Promise<boolean> {
    return waitForBlePoweredOn();
  }

  // The scan/select flow (silent serial auto-select → grace-window picker
  // fallback → scan timeout) mirrors NativeIosBleAdapter.requestAndConnect and
  // the web adapters. Kept in lockstep by hand; if you change one, change the others.
  async requestAndConnect(targetSerial?: string): Promise<BleConnection> {
    const devices = new Map<string, DiscoveredDevice>();
    let updateListener: ((devices: DiscoveredDevice[]) => void) | null = null;
    let scanStoppedListener: (() => void) | null = null;
    const pushDevices = () => updateListener?.([...devices.values()]);

    // One selection promise, resolved by either the silent serial auto-select
    // or — if that serial never shows up — the picker the grace window opens.
    let resolveSelection!: (deviceId: string) => void;
    let rejectSelection!: (error: Error) => void;
    const selectionPromise = new Promise<string>((resolve, reject) => {
      resolveSelection = resolve;
      rejectSelection = reject;
    });

    // True only while we're still silently matching the target serial — flips
    // false the moment we auto-select or hand off to the picker.
    let autoSelecting = Boolean(targetSerial);
    let pickerOpened = false;
    const openPicker = () => {
      if (pickerOpened) return;
      pickerOpened = true;
      autoSelecting = false;
      this.devicePicker((onUpdate, onScanStopped) => {
        updateListener = onUpdate;
        scanStoppedListener = onScanStopped ?? null;
        pushDevices();
      }).then(resolveSelection, rejectSelection);
    };

    // No target serial → straight to the picker.
    if (!targetSerial) {
      openPicker();
    }

    // The scan start and the timers live inside the try so that a
    // startDeviceScan failure still runs the finally — otherwise the scan could
    // be left running and the timers (if any) uncleared.
    let pickerFallbackId: ReturnType<typeof setTimeout> | undefined;
    let scanTimeoutId: ReturnType<typeof setTimeout> | undefined;
    let selectedDeviceId: string;
    try {
      // Aurora scans can stay service-filtered. MoonBoard scans stay unfiltered
      // so name-prefix controllers without advertised UART still surface.
      const scanServiceUuids = this.scanFamily === 'aurora' ? [AURORA_ADVERTISED_SERVICE_UUID] : null;
      void bleManager.startDeviceScan(scanServiceUuids, null, (scanError, scannedDevice) => {
        if (scanError) {
          void bleManager.stopDeviceScan();
          // Surface the failure immediately so the user sees feedback instead
          // of waiting out the 30s scan window (the picker, if open, closes too).
          rejectSelection(new Error(`BLE scan failed: ${scanError.message}`));
          return;
        }

        if (!scannedDevice) return;

        const deviceName = scannedDevice.localName ?? scannedDevice.name ?? undefined;
        // Overflow UUIDs cover iOS peripherals whose advertisement is too full
        // to carry the service list in the main packet.
        const advertisedServiceUuids = [
          ...(scannedDevice.serviceUUIDs ?? []),
          ...(scannedDevice.overflowServiceUUIDs ?? []),
        ];
        if (
          !isLikelyBoardDevice({ name: deviceName, serviceUuids: advertisedServiceUuids, scanFamily: this.scanFamily })
        ) {
          return;
        }

        const device: DiscoveredDevice = {
          deviceId: scannedDevice.id,
          name: deviceName,
          rssi: scannedDevice.rssi ?? -100,
        };
        if (upsertDiscoveredDevice(devices, device)) {
          pushDevices();
          // Record only newly-surfaced devices (upsert returns true on a fresh
          // entry) so the bug-report buffer holds one line per board, not one
          // per advertisement packet.
          recordBleEvent({ type: 'device_found', deviceId: device.deviceId, name: device.name, rssi: device.rssi });
        }

        // Auto-select the stored board only until the picker takes over.
        if (autoSelecting && targetSerial) {
          const serial = parseSerialNumber(device.name);
          if (serial === targetSerial) {
            autoSelecting = false;
            resolveSelection(device.deviceId);
          }
        }
      });

      // Grace window: if the stored serial hasn't matched shortly, open the
      // picker (scan keeps running so it live-updates) instead of waiting out
      // the full scan window and failing. Matches the web reconnect-by-serial
      // fallback.
      pickerFallbackId = targetSerial
        ? setTimeout(() => {
            if (autoSelecting) openPicker();
          }, SERIAL_RECONNECT_GRACE_MS)
        : undefined;

      scanTimeoutId = setTimeout(() => {
        void bleManager.stopDeviceScan();
        // Belt-and-suspenders: make sure the picker is open even if the grace
        // window never fired.
        if (autoSelecting) openPicker();
        // The picker is showing but nothing ever advertised — surface the empty
        // result so the sheet doesn't spin forever.
        if (pickerOpened && devices.size === 0) {
          rejectSelection(new Error('No boards found within scan window'));
        } else {
          // Devices were found but none picked yet — tell the picker the scan
          // stopped so it drops the spinner instead of implying a live scan.
          scanStoppedListener?.();
        }
      }, SCAN_TIMEOUT_MS);

      selectedDeviceId = await selectionPromise;
    } finally {
      if (pickerFallbackId) clearTimeout(pickerFallbackId);
      if (scanTimeoutId) clearTimeout(scanTimeoutId);
      void bleManager.stopDeviceScan();
    }

    let selectedDeviceName: string | undefined;
    for (const device of devices.values()) {
      if (device.deviceId === selectedDeviceId) {
        selectedDeviceName = device.name;
        break;
      }
    }

    let connectionTimeoutId: ReturnType<typeof setTimeout> | null = null;
    const connected = await Promise.race([
      bleManager.connectToDevice(selectedDeviceId),
      new Promise<never>((_resolve, reject) => {
        connectionTimeoutId = setTimeout(() => {
          bleManager.cancelDeviceConnection(selectedDeviceId).catch(() => {});
          reject(new Error('Connection timed out — board may be powered off'));
        }, CONNECTION_TIMEOUT_MS);
      }),
    ]).finally(() => {
      if (connectionTimeoutId != null) clearTimeout(connectionTimeoutId);
    });

    // Negotiate MTU before service discovery (Android requires this order
    // for best results; iOS handles MTU automatically but the call is safe).
    try {
      await connected.requestMTU(512);
    } catch {
      // Fall back to default MTU (23 bytes, 20 usable) — splitMessages handles chunking.
    }

    const deviceWithServices = await connected.discoverAllServicesAndCharacteristics();

    const characteristics = await deviceWithServices.characteristicsForService(UART_SERVICE_UUID);
    const uartWrite = characteristics.find(
      (characteristic) => characteristic.uuid.toLowerCase() === UART_WRITE_CHARACTERISTIC_UUID.toLowerCase(),
    );

    if (!uartWrite) {
      await bleManager.cancelDeviceConnection(selectedDeviceId);
      throw new Error('UART write characteristic not found');
    }

    this.connectedDevice = deviceWithServices;
    this.writeCharacteristic = uartWrite;

    this.disconnectSubscription = bleManager.onDeviceDisconnected(selectedDeviceId, (_error, _device) => {
      this.connectedDevice = null;
      this.writeCharacteristic = null;
      this.disconnectSubscription?.remove();
      this.disconnectSubscription = null;
      this.disconnectCallback?.();
    });

    return {
      deviceId: selectedDeviceId,
      deviceName: selectedDeviceName,
    };
  }

  async disconnect(): Promise<void> {
    if (this.disconnectSubscription) {
      this.disconnectSubscription.remove();
      this.disconnectSubscription = null;
    }

    if (this.connectedDevice) {
      const deviceId = this.connectedDevice.id;
      this.connectedDevice = null;
      this.writeCharacteristic = null;
      try {
        await bleManager.cancelDeviceConnection(deviceId);
      } catch {
        // Device may already be disconnected
      }
    }
  }

  async write(data: Uint8Array, signal?: AbortSignal): Promise<void> {
    if (!this.writeCharacteristic) {
      throw new Error('Not connected');
    }

    const chunks = splitMessages(data);

    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
      if (signal?.aborted) {
        throw new DOMException('Write aborted', 'AbortError');
      }

      if (chunkIndex > 0) {
        await delay(INTER_CHUNK_DELAY_MS);
        if (signal?.aborted) {
          throw new DOMException('Write aborted', 'AbortError');
        }
      }

      // Re-check the characteristic before each chunk — a mid-write
      // disconnect sets it to null via the onDeviceDisconnected handler.
      const characteristic = this.writeCharacteristic;
      if (!characteristic) {
        throw new Error('Device disconnected during write');
      }

      const chunk = chunks[chunkIndex];
      const base64Chunk = uint8ArrayToBase64(chunk);

      try {
        await characteristic.writeWithoutResponse(base64Chunk);
      } catch (error) {
        // react-native-ble-plx surfaces a mid-write drop as a BleError whose
        // message (e.g. CharacteristicWriteFailed — "Characteristic … write
        // failed for device …") doesn't name the disconnect, so
        // isDisconnectionError can't classify it from the message. Probe the
        // live link: if the device is actually gone, normalise to the
        // disconnect signature the write-failure path keys on so the lightbulb
        // darkens; otherwise rethrow the original error untouched (a genuine
        // transient write failure on a live link must not look like a drop).
        const stillConnected = await this.connectedDevice?.isConnected().catch(() => false);
        if (!stillConnected) {
          throw new Error('Device disconnected during write');
        }
        throw error;
      }
    }
  }

  onDisconnect(callback: () => void): () => void {
    this.disconnectCallback = callback;
    return () => {
      this.disconnectCallback = null;
    };
  }
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let byteIndex = 0; byteIndex < bytes.length; byteIndex++) {
    binary += String.fromCharCode(bytes[byteIndex]);
  }
  return btoa(binary);
}
