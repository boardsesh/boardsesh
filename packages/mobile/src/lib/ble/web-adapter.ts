// Web Bluetooth implementation of the mobile `BluetoothAdapter` interface,
// selected by Metro's platform resolver via adapter-factory.web.ts.
//
// This is the Expo-web twin of the native RN adapters (react-native-ble-plx on
// Android, the Swift BoardBleManager on iOS). It drives the same Aurora /
// MoonBoard LED protocol through the browser's Web Bluetooth API. The transport
// itself — request-device options, characteristic probing, chunked writes, and
// the Web Bluetooth type surface — lives in the shared, renderer-agnostic
// `@boardsesh/ble-protocol/web-transport` module, imported here and by the
// Next.js web adapter so a behavioural fix lands once, not twice.

import { splitMessages } from '@boardsesh/ble-protocol/transport';
import {
  isWebBluetoothAvailable,
  requestWebBluetoothDevice,
  requestDeviceOptionsForFamily,
  getUartCharacteristic,
  getMoonboardWriteCharacteristic,
  writeCharacteristicSeries,
  type WebBluetoothDevice,
  type WebBluetoothRemoteGATTCharacteristic,
} from '@boardsesh/ble-protocol/web-transport';
import type { BleConnection, BluetoothAdapter, BoardScanFamily } from './types';

export { isWebBluetoothAvailable, requestDeviceOptionsForFamily };

export class WebBluetoothAdapter implements BluetoothAdapter {
  private device: WebBluetoothDevice | null = null;
  private characteristic: WebBluetoothRemoteGATTCharacteristic | null = null;
  private disconnectHandler: (() => void) | null = null;
  // Tail of the serialized write chain. Web Bluetooth rejects a writeValue*
  // that starts while another GATT operation is still in flight ("GATT
  // operation already in progress"); the native SDKs serialize internally, so
  // we mirror that by queuing every write behind the previous one.
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly scanFamily: BoardScanFamily) {}

  isAvailable(): Promise<boolean> {
    return Promise.resolve(isWebBluetoothAvailable());
  }

  async requestAndConnect(_targetSerial?: string): Promise<BleConnection> {
    if (!isWebBluetoothAvailable()) {
      throw new Error('Web Bluetooth is not available in this browser');
    }

    // Drop any listeners bound to a previously-selected device before picking a
    // new one, so a re-request never leaks the old disconnect subscription.
    this.cleanupListeners();

    const device = await requestWebBluetoothDevice(requestDeviceOptionsForFamily(this.scanFamily));

    // Probing the write characteristic opens the GATT connection. If probing
    // rejects (e.g. the UART service is absent on an Aurora variant) or comes
    // back empty (a MoonBoard exposing neither controller), that connection is
    // left open — drop it before surfacing the failure so we never leak a live
    // GATT link the caller can't reach.
    let characteristic: WebBluetoothRemoteGATTCharacteristic | undefined;
    try {
      characteristic =
        this.scanFamily === 'moonboard'
          ? await getMoonboardWriteCharacteristic(device)
          : await getUartCharacteristic(device);
    } catch (error) {
      device.gatt?.disconnect();
      throw error;
    }

    if (!characteristic) {
      device.gatt?.disconnect();
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

  write(data: Uint8Array, signal?: AbortSignal): Promise<void> {
    if (!this.characteristic) {
      return Promise.reject(new Error('Not connected'));
    }
    // Chain this write onto the tail of the queue so it can't overlap an
    // in-flight GATT operation. A failed or aborted write must not poison the
    // chain, so the tail swallows the result — the next write still runs.
    const run = this.writeQueue.then(() => this.performWrite(data, signal));
    this.writeQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async performWrite(data: Uint8Array, signal?: AbortSignal): Promise<void> {
    const characteristic = this.characteristic;
    if (!characteristic) {
      throw new Error('Not connected');
    }
    const messages = splitMessages(data);
    // MoonBoard may choose write-with-response up front for the RedBearLab box;
    // Aurora starts without-response and only retries with-response when Web
    // Bluetooth rejects the write as unsupported by this characteristic.
    await writeCharacteristicSeries(characteristic, messages, signal, {
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
