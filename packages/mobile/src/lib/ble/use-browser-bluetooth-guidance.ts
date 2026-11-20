import type { BleFailureCategory } from '@boardsesh/ble-protocol/connection-error';

export type BrowserBluetoothFailure = {
  category: Exclude<BleFailureCategory, 'user_cancelled'>;
  afterBoardSwitch?: boolean;
};

export type BrowserBluetoothGuidance = (boardName: string, failure?: BrowserBluetoothFailure) => Promise<void>;

/** Native has its own radio and permission guidance. */
export function useBrowserBluetoothGuidance(): BrowserBluetoothGuidance | null {
  return null;
}
