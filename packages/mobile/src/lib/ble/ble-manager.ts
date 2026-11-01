import { BleManager } from 'react-native-ble-plx';

let createdBleManager: BleManager | null = null;

/**
 * The app's one ble-plx manager, created on the first call instead of at
 * import. Its native side creates a CBCentralManager straight away, and on iOS
 * that shows the system Bluetooth alert if the climber has never answered it.
 * Created at import, it asked at launch, before sign-in, with nothing on screen
 * to explain why. So call it only from a scan or connect the climber started,
 * after `requestBluetoothAuthorization()` (bluetooth-authorization.ts) has
 * asked; `waitForBlePoweredOn` does that for every scan path.
 *
 * Android has no launch-time question to avoid: it asks for its runtime
 * permissions at scan/connect (use-ble-permissions.ts), and its `state()` reads
 * the adapter directly, so creating the manager later changes nothing there.
 */
export function getBleManager(): BleManager {
  if (!createdBleManager) {
    createdBleManager = new BleManager({
      restoreStateIdentifier: 'boardsesh-ble-restore',
      restoreStateFunction: (_restoredState) => {
        // iOS calls this when CoreBluetooth restores a previously connected
        // peripheral. Board connections on iOS run through the native BoardBle
        // module, and the app-level reconnect logic in BluetoothProvider
        // re-establishes anything else via AppState foreground detection, so
        // no action is needed here beyond allowing the BleManager to
        // initialize with restoration support.
      },
    });
  }
  return createdBleManager;
}
