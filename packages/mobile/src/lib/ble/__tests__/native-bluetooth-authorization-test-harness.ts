import { vi } from 'vitest';
import type { NativeBluetoothAuthorization } from '../../../../modules/live-activity/src/index';

type NativeAuthorizationSurface = {
  getBluetoothAuthorization?: () => string;
  requestBluetoothAuthorization?: () => Promise<string>;
};

/**
 * Stand-in for the iOS BoardBle module's Bluetooth authorization surface, for
 * suites that mock `modules/live-activity/src/index` with
 * `get boardBleNative() { return harness.nativeModule; }`. `nativeModule: null`
 * is Android, web, or an iOS binary without the module: the old behaviour.
 */
export const nativeBluetoothAuthorizationHarness = {
  nativeModule: null as NativeAuthorizationSurface | null,
  /** What `getBluetoothAuthorization` reads right now. */
  authorization: 'notDetermined' as NativeBluetoothAuthorization,
  /** How many times the system alert would have been shown. */
  requestCount: 0,
};

/**
 * Model an iOS binary that asks at the first scan: `getBluetoothAuthorization`
 * reads `initial`, and `requestBluetoothAuthorization` turns an unanswered
 * question into `answer` (the climber's tap on the system alert).
 */
export function installIosBluetoothAuthorization(
  initial: NativeBluetoothAuthorization,
  answer: NativeBluetoothAuthorization = 'allowedAlways',
): void {
  const harness = nativeBluetoothAuthorizationHarness;
  harness.authorization = initial;
  harness.requestCount = 0;
  harness.nativeModule = {
    getBluetoothAuthorization: vi.fn(() => harness.authorization),
    requestBluetoothAuthorization: vi.fn(async () => {
      harness.requestCount += 1;
      if (harness.authorization === 'notDetermined') harness.authorization = answer;
      return harness.authorization;
    }),
  };
}

export function resetNativeBluetoothAuthorizationHarness(): void {
  nativeBluetoothAuthorizationHarness.nativeModule = null;
  nativeBluetoothAuthorizationHarness.authorization = 'notDetermined';
  nativeBluetoothAuthorizationHarness.requestCount = 0;
}
