import type { NativeBleConnectedDevice, NativeBleConnectedEvent } from '../../../modules/live-activity/src/index';
import type { NativeIosBleAdapter } from './native-ios-adapter';
import type { BleAdapterOptions, BluetoothAdapter, BoardScanFamily, DevicePickerFn } from './types';
import { WebBluetoothAdapter } from './web-adapter';

// The browser exposes its own device chooser through
// navigator.bluetooth.requestDevice, so the RN device-picker callback (used by
// the native adapters to drive an in-app scan UI) is unused on web.
//
// `options` is NOT ignored: `preferWriteWithResponse` is a firmware fact, not a
// platform one. A board that only acknowledges written chunks (Woods, protocol
// spec §8) still advertises write-without-response, so leaving Web Bluetooth to
// pick the write type from the characteristic's properties would send every
// chunk unacknowledged and leave the wall dark with no error to show for it.
export function createBluetoothAdapter(
  _devicePicker: DevicePickerFn,
  scanFamily: BoardScanFamily,
  options?: BleAdapterOptions,
): BluetoothAdapter {
  return new WebBluetoothAdapter(scanFamily, options);
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
