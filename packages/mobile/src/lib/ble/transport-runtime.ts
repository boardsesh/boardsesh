import type { BleAdapterOptions, BluetoothAdapter, BoardScanFamily, DevicePickerFn } from './types';
import type { BleRuntimePermissionStatus } from './use-ble-permissions';

/** Alternative transport services are installed by the application root before BLE mounts. */
export type BluetoothTransportRuntime = {
  createAdapter: (picker: DevicePickerFn, family: BoardScanFamily, options?: BleAdapterOptions) => BluetoothAdapter;
  waitForPoweredOn: (timeoutMs: number) => Promise<boolean>;
  requestPermissions: () => Promise<BleRuntimePermissionStatus>;
  /** An external transport owns its connections; native CoreBluetooth cannot adopt them. */
  discovery: 'external';
  /** Widget actions return to JavaScript when the transport cannot run in native App Intents. */
  widgetCommandDelivery: 'javascript';
};
let installed: BluetoothTransportRuntime | undefined;
let consumed = false;

export function installBluetoothTransport(runtime: BluetoothTransportRuntime): void {
  if (installed === runtime) return;
  if (consumed || installed) throw new Error('Bluetooth transport must be installed once, before application startup');
  installed = runtime;
}

export function bluetoothTransport(): BluetoothTransportRuntime | undefined {
  consumed = true;
  return installed;
}
