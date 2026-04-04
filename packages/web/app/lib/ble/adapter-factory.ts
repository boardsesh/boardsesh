import { isCapacitor, isCapacitorWebView, waitForCapacitor, CAPACITOR_BRIDGE_TIMEOUT_MS } from './capacitor-utils';
import type { BluetoothAdapter } from './types';

export async function createBluetoothAdapter(): Promise<BluetoothAdapter> {
  // If we detect a WebView but the Capacitor bridge isn't ready yet, wait briefly
  if (!isCapacitor() && isCapacitorWebView()) {
    await waitForCapacitor(CAPACITOR_BRIDGE_TIMEOUT_MS);
  }

  if (isCapacitor()) {
    const { CapacitorBleAdapter } = await import('./capacitor-adapter');
    return new CapacitorBleAdapter();
  }
  const { WebBluetoothAdapter } = await import('./web-adapter');
  return new WebBluetoothAdapter();
}
