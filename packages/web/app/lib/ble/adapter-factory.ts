import { hasCapacitorPlugin } from './capacitor-utils';
import type { BluetoothAdapter } from './types';

export async function createBluetoothAdapter(): Promise<BluetoothAdapter> {
  if (hasCapacitorPlugin('BluetoothLe')) {
    const { CapacitorBleAdapter } = await import('./capacitor-adapter');
    return new CapacitorBleAdapter();
  }
  const { WebBluetoothAdapter } = await import('./web-adapter');
  return new WebBluetoothAdapter();
}
