import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  reactNativePermissionHarness,
  resetReactNativePermissionHarness,
} from './react-native-permissions-test-harness';

const mockBleManager = vi.hoisted(() => ({
  state: vi.fn(),
  onStateChange: vi.fn(),
}));

vi.mock('react-native', async () => {
  const { reactNativePermissionHarness: harness } = await import('./react-native-permissions-test-harness');
  return {
    Platform: harness.platform,
    PermissionsAndroid: harness.permissionsAndroid,
  };
});

vi.mock('react-native-ble-plx', () => ({
  State: {
    PoweredOn: 'PoweredOn',
    PoweredOff: 'PoweredOff',
    Unknown: 'Unknown',
  },
}));

vi.mock('../ble-manager', () => ({
  bleManager: mockBleManager,
}));

import {
  ANDROID_NO_DIALOG_ANSWER_MAX_MS,
  requestBleRuntimePermissions,
  requestBleRuntimePermissionStatus,
  requestOptionalNotificationPermission,
} from '../use-ble-permissions';

describe('requestBleRuntimePermissions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetReactNativePermissionHarness();
    mockBleManager.state.mockResolvedValue('PoweredOn');
  });

  it('requests Android 12+ scan and connect permissions', async () => {
    const permissionsGranted = await requestBleRuntimePermissions();

    expect(permissionsGranted).toBe(true);
    expect(reactNativePermissionHarness.permissionsAndroid.requestMultiple).toHaveBeenCalledWith([
      'BLUETOOTH_SCAN',
      'BLUETOOTH_CONNECT',
    ]);
    expect(mockBleManager.state).not.toHaveBeenCalled();
  });

  it('requests fine location on Android 11 and below', async () => {
    reactNativePermissionHarness.platform.Version = 30;
    reactNativePermissionHarness.permissionsAndroid.requestMultiple.mockResolvedValue({
      ACCESS_FINE_LOCATION: 'granted',
    });

    const permissionsGranted = await requestBleRuntimePermissions();

    expect(permissionsGranted).toBe(true);
    expect(reactNativePermissionHarness.permissionsAndroid.requestMultiple).toHaveBeenCalledWith([
      'ACCESS_FINE_LOCATION',
    ]);
  });

  it('returns false when a required Android permission is denied', async () => {
    reactNativePermissionHarness.permissionsAndroid.requestMultiple.mockResolvedValue({
      BLUETOOTH_SCAN: 'granted',
      BLUETOOTH_CONNECT: 'denied',
    });

    const permissionsGranted = await requestBleRuntimePermissions();

    expect(permissionsGranted).toBe(false);
  });

  it('requests Android notification permission without making it part of the BLE gate', async () => {
    reactNativePermissionHarness.platform.Version = 33;
    reactNativePermissionHarness.permissionsAndroid.request.mockResolvedValue('denied');

    const permissionsGranted = await requestBleRuntimePermissions({ requestNotificationPermission: true });

    expect(permissionsGranted).toBe(true);
    expect(reactNativePermissionHarness.permissionsAndroid.request).toHaveBeenCalledWith('POST_NOTIFICATIONS');
  });

  it('does not check hardware state for iOS runtime permissions', async () => {
    reactNativePermissionHarness.platform.OS = 'ios';
    mockBleManager.state.mockResolvedValue('PoweredOff');

    const permissionsGranted = await requestBleRuntimePermissions();

    expect(permissionsGranted).toBe(true);
    expect(mockBleManager.state).not.toHaveBeenCalled();
    expect(reactNativePermissionHarness.permissionsAndroid.requestMultiple).not.toHaveBeenCalled();
  });
});

// #5654: a connect needs to know WHY permission is missing. Once Android stops
// showing its dialog, asking again from the app is a dead tap, so the connect
// points the climber at Settings instead.
describe('requestBleRuntimePermissionStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetReactNativePermissionHarness();
  });

  it('is granted when every required Android permission is granted', async () => {
    await expect(requestBleRuntimePermissionStatus()).resolves.toBe('granted');
  });

  it('is denied when the climber said no in the dialog, which will show again next time', async () => {
    reactNativePermissionHarness.permissionsAndroid.requestMultiple.mockResolvedValue({
      BLUETOOTH_SCAN: 'denied',
      BLUETOOTH_CONNECT: 'granted',
    });

    await expect(requestBleRuntimePermissionStatus()).resolves.toBe('denied');
  });

  it('is blocked when Android answers never_ask_again for a missing permission', async () => {
    reactNativePermissionHarness.permissionsAndroid.requestMultiple.mockResolvedValue({
      BLUETOOTH_SCAN: 'never_ask_again',
      BLUETOOTH_CONNECT: 'granted',
    });

    await expect(requestBleRuntimePermissionStatus()).resolves.toBe('blocked');
    await expect(requestBleRuntimePermissions()).resolves.toBe(false);
  });

  it('is blocked when one permission is denied and another can no longer be asked for', async () => {
    reactNativePermissionHarness.permissionsAndroid.requestMultiple.mockResolvedValue({
      BLUETOOTH_SCAN: 'denied',
      BLUETOOTH_CONNECT: 'never_ask_again',
    });

    await expect(requestBleRuntimePermissionStatus()).resolves.toBe('blocked');
  });

  it('reads never_ask_again on the Android 11 location permission as blocked too', async () => {
    reactNativePermissionHarness.platform.Version = 30;
    reactNativePermissionHarness.permissionsAndroid.requestMultiple.mockResolvedValue({
      ACCESS_FINE_LOCATION: 'never_ask_again',
    });

    await expect(requestBleRuntimePermissionStatus()).resolves.toBe('blocked');
  });

  // RN reports never_ask_again whenever Android's rationale flag is false, which
  // on Android 11+ includes closing the FIRST dialog with back or a tap outside.
  // That dialog comes back next time, so it must not read as blocked.
  it('is denied, not blocked, when never_ask_again comes back after a dialog was on screen', async () => {
    vi.useFakeTimers();
    try {
      reactNativePermissionHarness.permissionsAndroid.requestMultiple.mockImplementation(
        () =>
          new Promise((resolve) => {
            // The climber looks at the dialog for a moment, then presses back.
            setTimeout(
              () => resolve({ BLUETOOTH_SCAN: 'never_ask_again', BLUETOOTH_CONNECT: 'never_ask_again' }),
              1_200,
            );
          }),
      );

      const statusPromise = requestBleRuntimePermissionStatus();
      await vi.advanceTimersByTimeAsync(1_200);

      await expect(statusPromise).resolves.toBe('denied');
    } finally {
      vi.useRealTimers();
    }
  });

  it('is blocked when never_ask_again comes back inside the no-dialog window', async () => {
    vi.useFakeTimers();
    try {
      reactNativePermissionHarness.permissionsAndroid.requestMultiple.mockImplementation(
        () =>
          new Promise((resolve) => {
            // One activity round trip on a slow phone, no dialog drawn.
            setTimeout(
              () => resolve({ BLUETOOTH_SCAN: 'never_ask_again', BLUETOOTH_CONNECT: 'never_ask_again' }),
              ANDROID_NO_DIALOG_ANSWER_MAX_MS - 1,
            );
          }),
      );

      const statusPromise = requestBleRuntimePermissionStatus();
      await vi.advanceTimersByTimeAsync(ANDROID_NO_DIALOG_ANSWER_MAX_MS - 1);

      await expect(statusPromise).resolves.toBe('blocked');
    } finally {
      vi.useRealTimers();
    }
  });

  it('is denied, not blocked, when the request itself throws', async () => {
    reactNativePermissionHarness.permissionsAndroid.requestMultiple.mockRejectedValue(new Error('activity gone'));

    await expect(requestBleRuntimePermissionStatus()).resolves.toBe('denied');
  });

  it('is granted on iOS, whose denial shows up as the Unauthorized radio state instead', async () => {
    reactNativePermissionHarness.platform.OS = 'ios';

    await expect(requestBleRuntimePermissionStatus()).resolves.toBe('granted');
    expect(reactNativePermissionHarness.permissionsAndroid.requestMultiple).not.toHaveBeenCalled();
  });

  it('leaves the notifications prompt out unless asked for', async () => {
    reactNativePermissionHarness.platform.Version = 33;

    await requestBleRuntimePermissionStatus();

    expect(reactNativePermissionHarness.permissionsAndroid.request).not.toHaveBeenCalled();
  });
});

describe('requestOptionalNotificationPermission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetReactNativePermissionHarness();
  });

  it('asks for POST_NOTIFICATIONS on Android 13+', async () => {
    reactNativePermissionHarness.platform.Version = 33;

    await requestOptionalNotificationPermission();

    expect(reactNativePermissionHarness.permissionsAndroid.request).toHaveBeenCalledWith('POST_NOTIFICATIONS');
  });

  it('does nothing below Android 13 or on iOS', async () => {
    reactNativePermissionHarness.platform.Version = 32;
    await requestOptionalNotificationPermission();
    reactNativePermissionHarness.platform.OS = 'ios';
    reactNativePermissionHarness.platform.Version = 33;
    await requestOptionalNotificationPermission();

    expect(reactNativePermissionHarness.permissionsAndroid.request).not.toHaveBeenCalled();
  });

  it('swallows a failed request: notifications are optional for the board link', async () => {
    reactNativePermissionHarness.platform.Version = 33;
    reactNativePermissionHarness.permissionsAndroid.request.mockRejectedValue(new Error('no activity'));

    await expect(requestOptionalNotificationPermission()).resolves.toBeUndefined();
  });
});
