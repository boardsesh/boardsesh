import { Platform } from 'react-native';
import {
  boardBleNative,
  type NativeBleConnectedDevice,
  type NativeBleConnectedEvent,
} from '../../../modules/live-activity/src/index';
import { RNBleAdapter } from './adapter';
import {
  NativeIosBleAdapter,
  nativeBleSupportsBoard,
  nativeBleSupportsConnectionAdoption,
  nativeBleSupportsPreparedConnections,
} from './native-ios-adapter';
import { loadScreenshotFakeAdapter } from './screenshot-fake-adapter-loader';
import type { BleAdapterOptions, BluetoothAdapter, BoardScanFamily, DevicePickerFn } from './types';

// Returns the BluetoothAdapter implementation appropriate for the current
// platform. iOS uses the native Swift BoardBleManager (so widget Live
// Activity intents can drive the wall synchronously); Android continues to
// use react-native-ble-plx via RNBleAdapter.
//
// Falls back to RNBleAdapter on iOS only if the native module wasn't linked
// into the running binary — covers Expo Go and any preview build older than
// the one that bundled the live-activity module. Production preview builds
// always take the native path.
//
// A board that demands acknowledged writes (options.preferWriteWithResponse —
// Woods, per its protocol spec §8) takes the native path only when the running
// binary proves it can drive that board (`nativeBleSupportsBoard`, the #3314
// constant): the old Swift layer both fixes the write type to
// without-response and would encode a Woods climb as Aurora, so on older
// binaries such a board stays on RNBleAdapter, which keeps the Swift encoder
// from ever seeing its configuration.
//
// A screenshot build with EXPO_PUBLIC_SCREENSHOT_FAKE_BLE=1 gets a fake adapter
// that connects to a pretend board, because the simulator has no Bluetooth (see
// screenshot-fake-adapter.ts). The raw env comparison is inlined on purpose so
// the branch folds away in every other build (see ../screenshot-mode.ts); the
// loader requires the fake adapter behind the same gate, so Metro drops that
// module from those builds too (see screenshot-fake-adapter-loader.ts).
export function createBluetoothAdapter(
  devicePicker: DevicePickerFn,
  scanFamily: BoardScanFamily,
  options?: BleAdapterOptions,
): BluetoothAdapter {
  if (process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1' && process.env.EXPO_PUBLIC_SCREENSHOT_FAKE_BLE === '1') {
    const FakeAdapter = loadScreenshotFakeAdapter();
    if (FakeAdapter) return new FakeAdapter(scanFamily, options);
  }
  const nativeCanServe = !options?.preferWriteWithResponse || nativeBleSupportsBoard(options.boardName);
  if (Platform.OS === 'ios' && boardBleNative && nativeCanServe) {
    return new NativeIosBleAdapter(devicePicker, scanFamily, options);
  }
  // Android retries one transient first GATT connect failure (isRetryableAndroidConnectError)
  // before surfacing it — see RNBleAdapter.connectSelectedDevice. iOS never sets this.
  return new RNBleAdapter(devicePicker, scanFamily, {
    ...options,
    enableAndroidConnectRetry: Platform.OS === 'android',
  });
}

export { nativeBleSupportsBoard, nativeBleSupportsPreparedConnections };

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
  // The fake-Bluetooth screenshot build has no native connection to adopt.
  if (process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1' && process.env.EXPO_PUBLIC_SCREENSHOT_FAKE_BLE === '1')
    return null;
  if (!boardBleNative || !nativeBleSupportsConnectionAdoption()) return null;
  return boardBleNative.addListener('connected', listener);
}

/**
 * The natively-connected, write-ready board, or null. Null on Android, on
 * older iOS binaries, and on any native error.
 */
export async function getNativeBleConnectedDevice(): Promise<NativeBleConnectedDevice | null> {
  if (process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1' && process.env.EXPO_PUBLIC_SCREENSHOT_FAKE_BLE === '1')
    return null;
  const native = boardBleNative;
  if (!native || typeof native.getConnectedDevice !== 'function') return null;
  try {
    return (await native.getConnectedDevice()) ?? null;
  } catch {
    return null;
  }
}

/**
 * Forget the board native still pairs for the Live Activity bulb, while JS
 * holds no link to it: a hang-up's 10 minutes ran out, or the account signed
 * out. Native's plain `disconnect` forgets the pairing and settles any
 * reconnect native started on its own (the bulb, while JS slept).
 *
 * Only a binary with `disconnectKeepingBoard` (#7214) ever keeps a board after
 * letting go of it; on an older one every disconnect already forgot it, so
 * there is nothing to do. No-op on Android, where nothing native reconnects.
 * Native errors are swallowed: the caller already forgot the board in JS.
 *
 * Resolves true once native has forgotten the pairing, so the caller can
 * redraw the Live Activity card: it reads the pairing only when it redraws,
 * and would otherwise go on offering a "Tap to reconnect" that can only fail.
 */
export async function forgetNativeKeptBoard(): Promise<boolean> {
  if (process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1' && process.env.EXPO_PUBLIC_SCREENSHOT_FAKE_BLE === '1') {
    return false;
  }
  const native = boardBleNative;
  if (Platform.OS !== 'ios' || !native || typeof native.disconnectKeepingBoard !== 'function') return false;
  try {
    await native.disconnect();
    return true;
  } catch {
    // Nothing to recover: JS already counts the board as forgotten.
    return false;
  }
}
