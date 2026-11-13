import { getLedControllerDriver, type LedControllerDriver, type LedControllerType } from '@boardsesh/led-controller';

/** Native radio code loads only after a deliberate Bluetooth lighting operation. */
export async function loadSprayLedDriver(type: LedControllerType): Promise<LedControllerDriver> {
  if (type === 'wled-ble') return (await import('./wled-ble-native')).nativeWledBleDriver;
  return getLedControllerDriver(type);
}
