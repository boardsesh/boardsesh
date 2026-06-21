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

import { requestBleRuntimePermissions } from '../use-ble-permissions';

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
