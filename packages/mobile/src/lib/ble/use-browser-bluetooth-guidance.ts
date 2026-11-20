export type BrowserBluetoothGuidance = (boardName: string) => Promise<void>;

/** Native has its own radio and permission guidance. */
export function useBrowserBluetoothGuidance(): BrowserBluetoothGuidance | null {
  return null;
}
