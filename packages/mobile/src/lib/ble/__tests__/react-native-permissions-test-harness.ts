import { vi } from 'vitest';

export const reactNativePermissionHarness = {
  platform: {
    OS: 'android' as 'android' | 'ios',
    Version: 31 as number | string,
  },
  permissionsAndroid: {
    PERMISSIONS: {
      ACCESS_FINE_LOCATION: 'ACCESS_FINE_LOCATION',
      BLUETOOTH_SCAN: 'BLUETOOTH_SCAN',
      BLUETOOTH_CONNECT: 'BLUETOOTH_CONNECT',
      POST_NOTIFICATIONS: 'POST_NOTIFICATIONS',
    },
    RESULTS: {
      GRANTED: 'granted',
      DENIED: 'denied',
    },
    requestMultiple: vi.fn(),
    request: vi.fn(),
  },
};

export function resetReactNativePermissionHarness(): void {
  reactNativePermissionHarness.platform.OS = 'android';
  reactNativePermissionHarness.platform.Version = 31;
  reactNativePermissionHarness.permissionsAndroid.requestMultiple.mockResolvedValue({
    BLUETOOTH_SCAN: 'granted',
    BLUETOOTH_CONNECT: 'granted',
  });
  reactNativePermissionHarness.permissionsAndroid.request.mockResolvedValue('granted');
}
