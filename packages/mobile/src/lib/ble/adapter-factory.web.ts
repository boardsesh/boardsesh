import type { NativeBleConnectedDevice, NativeBleConnectedEvent } from '../../../modules/live-activity/src/index';
import type { NativeIosBleAdapter } from './native-ios-adapter';
import type { BluetoothAdapter, BoardScanFamily, DevicePickerFn } from './types';

const unavailable = () => Promise.reject(new Error('Bluetooth is not available on web yet'));

export function createBluetoothAdapter(_devicePicker: DevicePickerFn, _scanFamily: BoardScanFamily): BluetoothAdapter {
  return {
    isAvailable: () => Promise.resolve(false),
    requestAndConnect: unavailable,
    disconnect: () => Promise.resolve(),
    write: unavailable,
    onDisconnect: () => () => {},
  };
}

export function isNativeIosBleAdapter(_adapter: BluetoothAdapter): _adapter is NativeIosBleAdapter {
  return false;
}

export function subscribeNativeBleConnected(
  _listener: (payload: NativeBleConnectedEvent) => void,
): { remove: () => void } | null {
  return null;
}

export function getNativeBleConnectedDevice(): Promise<NativeBleConnectedDevice | null> {
  return Promise.resolve(null);
}
