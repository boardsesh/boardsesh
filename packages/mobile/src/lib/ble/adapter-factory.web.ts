import type { NativeBleConnectedDevice, NativeBleConnectedEvent } from '../../../modules/live-activity/src/index';
import type { NativeIosBleAdapter } from './native-ios-adapter';
import type { BleAdapterOptions, BluetoothAdapter, BoardScanFamily, DevicePickerFn } from './types';
import { WebBluetoothAdapter } from './web-adapter';

// The browser exposes its own device chooser through
// navigator.bluetooth.requestDevice, so the RN device-picker callback (used by
// the native adapters to drive an in-app scan UI) is unused on web.
//
// `options` is accepted for signature parity and ignored: Web Bluetooth picks
// the write type itself from the characteristic's properties, and the only
// board that asks for acknowledged writes (Woods) has no web encoder anyway.
export function createBluetoothAdapter(
  _devicePicker: DevicePickerFn,
  scanFamily: BoardScanFamily,
  _options?: BleAdapterOptions,
): BluetoothAdapter {
  return new WebBluetoothAdapter(scanFamily);
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
