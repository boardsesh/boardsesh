import type { NativeBleConnectedDevice, NativeBleConnectedEvent } from '../../../modules/live-activity/src/index';
import type { NativeIosBleAdapter } from './native-ios-adapter';
import type { BluetoothAdapter, BoardScanFamily, DevicePickerFn } from './types';
import { WebBluetoothAdapter } from './web-adapter';

// The browser exposes its own device chooser through
// navigator.bluetooth.requestDevice, so the RN device-picker callback (used by
// the native adapters to drive an in-app scan UI) is unused on web.
export function createBluetoothAdapter(_devicePicker: DevicePickerFn, scanFamily: BoardScanFamily): BluetoothAdapter {
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
