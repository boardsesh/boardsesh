import type { State } from 'react-native-ble-plx';

type BlePermissionsResult = {
  bleState: State;
  isAvailable: boolean;
  requestPermissions: () => Promise<boolean>;
};

const unavailableResult: BlePermissionsResult = {
  bleState: 'PoweredOff' as unknown as State,
  isAvailable: false,
  requestPermissions: () => Promise.resolve(false),
};

export function requestBleRuntimePermissions(_options?: { requestNotificationPermission?: boolean }): Promise<boolean> {
  return Promise.resolve(false);
}

export function useBlePermissions(): BlePermissionsResult {
  return unavailableResult;
}
