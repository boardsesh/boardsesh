import type { BoardName } from '@/app/lib/types';
import { AURORA_REQUEST_DEVICE_OPTIONS } from '@/app/components/board-bluetooth-control/bluetooth-aurora';
import { MOONBOARD_REQUEST_DEVICE_OPTIONS } from '@/app/components/board-bluetooth-control/bluetooth-moonboard';
import {
  getMoonboardWriteCharacteristic,
  getUartCharacteristic,
  requestBluetoothDevice,
  splitMessages,
  writeCharacteristicSeries,
} from '@/app/components/board-bluetooth-control/bluetooth-shared';
import type { BleConnection, BluetoothAdapter } from './types';

export class WebBluetoothAdapter implements BluetoothAdapter {
  constructor(private readonly boardName: BoardName = 'kilter') {}

  // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents -- Web Bluetooth types resolve correctly at build time
  private device: BluetoothDevice | null = null;
  // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents -- Web Bluetooth types resolve correctly at build time
  private characteristic: BluetoothRemoteGATTCharacteristic | null = null;
  private disconnectHandler: (() => void) | null = null;

  async isAvailable(): Promise<boolean> {
    return typeof navigator !== 'undefined' && !!navigator.bluetooth;
  }

  async requestAndConnect(_targetSerial?: string): Promise<BleConnection> {
    // Clean up any existing device listeners
    this.cleanupListeners();

    const requestOptions =
      this.boardName === 'moonboard' ? MOONBOARD_REQUEST_DEVICE_OPTIONS : AURORA_REQUEST_DEVICE_OPTIONS;

    const device = await requestBluetoothDevice(requestOptions);
    // MoonBoard spans two controller generations (Nordic UART + original
    // RedBearLab), so probe both; Aurora boards are always Nordic UART.
    const characteristic =
      this.boardName === 'moonboard'
        ? await getMoonboardWriteCharacteristic(device)
        : await getUartCharacteristic(device);

    if (!characteristic) {
      throw new Error('Failed to get UART characteristic');
    }

    device.addEventListener('gattserverdisconnected', this.handleDisconnect);

    this.device = device;
    this.characteristic = characteristic;

    return {
      deviceId: device.id,
      deviceName: device.name ?? undefined,
    };
  }

  async disconnect(): Promise<void> {
    if (this.device?.gatt?.connected) {
      this.device.gatt.disconnect();
    }
    this.cleanupListeners();
    this.device = null;
    this.characteristic = null;
  }

  async write(data: Uint8Array, signal?: AbortSignal): Promise<void> {
    if (!this.characteristic) {
      throw new Error('Not connected');
    }
    const messages = splitMessages(data);
    await writeCharacteristicSeries(this.characteristic, messages, signal);
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
