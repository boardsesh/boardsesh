import { registerBleLedTransport } from '@boardsesh/led-controller';

/**
 * The Spraywall Bluetooth transport, loaded the first time a Bluetooth wall is
 * scanned for or lit. Importing this file costs nothing: react-native-ble-plx
 * only enters the module graph through the dynamic import, as the route sender
 * already keeps its spray modules out of the board stack's boot graph.
 */
export function loadSprayLedBleTransport() {
  return import('./spray-led-ble-transport');
}

registerBleLedTransport(() => loadSprayLedBleTransport().then((module) => module.sprayLedBleTransport));
