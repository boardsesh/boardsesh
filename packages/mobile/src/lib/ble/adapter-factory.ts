import { Platform } from 'react-native';
import {
  boardBleNative,
  type NativeBleConnectedDevice,
  type NativeBleConnectedEvent,
} from '../../../modules/live-activity/src/index';
import { RNBleAdapter } from './adapter';
import { NativeIosBleAdapter, nativeBleSupportsConnectionAdoption } from './native-ios-adapter';
import type { BluetoothAdapter, BoardScanFamily, DevicePickerFn } from './types';

// Returns the BluetoothAdapter implementation appropriate for the current
// platform. iOS uses the native Swift BoardBleManager (so widget Live
// Activity intents can drive the wall synchronously); Android continues to
// use react-native-ble-plx via RNBleAdapter.
//
// Falls back to RNBleAdapter on iOS only if the native module wasn't linked
// into the running binary — covers Expo Go and any preview build older than
// the one that bundled the live-activity module. Production preview builds
// always take the native path.
export function createBluetoothAdapter(devicePicker: DevicePickerFn, scanFamily: BoardScanFamily): BluetoothAdapter {
  if (Platform.OS === 'ios' && boardBleNative) {
    return new NativeIosBleAdapter(devicePicker, scanFamily);
  }
  return new RNBleAdapter(devicePicker, scanFamily);
}

// `true` iff the runtime adapter is the native iOS one — used by the
// provider to decide whether to push board configuration into native shared
// state for the widget intent path.
export function isNativeIosBleAdapter(adapter: BluetoothAdapter): adapter is NativeIosBleAdapter {
  return adapter instanceof NativeIosBleAdapter;
}

// ── Native connection adoption seam ────────────────────────────────────────
// useBoardBluetooth accesses the native module exclusively through these
// helpers (rather than importing modules/live-activity directly) so the hook
// stays testable — expo-modules-core touches React Native globals at import
// time, and tests mock this factory module wholesale.

/**
 * Subscribe to the native `connected` event (a connection became write-ready,
 * whether JS initiated it or not). Returns null when the platform/binary
 * doesn't support adoption — callers treat that as "feature absent".
 */
export function subscribeNativeBleConnected(
  listener: (payload: NativeBleConnectedEvent) => void,
): { remove: () => void } | null {
  if (!boardBleNative || !nativeBleSupportsConnectionAdoption()) return null;
  return boardBleNative.addListener('connected', listener);
}

/**
 * The natively-connected, write-ready board, or null. Null on Android, on
 * older iOS binaries, and on any native error.
 */
export async function getNativeBleConnectedDevice(): Promise<NativeBleConnectedDevice | null> {
  const native = boardBleNative;
  if (!native || typeof native.getConnectedDevice !== 'function') return null;
  try {
    return (await native.getConnectedDevice()) ?? null;
  } catch {
    return null;
  }
}
