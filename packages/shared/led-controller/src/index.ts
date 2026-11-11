import type { LedControllerDriver } from './types';
import { wledDriver } from './wled';
import { bleLedDriver } from './ble';

export * from './types';
export { isLocalControllerHost, normalizeControllerUrl, normalizeLocalControllerUrl } from './url';
export { createLedPreviewSession, type LedPreviewSession } from './preview';
export { discoverLedControllers, wledScanHosts, type DiscoverOptions, type DiscoveredLedController } from './discovery';
export { createWledDriver, wledDriver, type WledDriverOptions } from './wled';
export {
  bleControllerName,
  bleControllerTarget,
  createBleLedDriver,
  DEFAULT_BLE_LIGHT_ALL_LEDS,
  normalizeBleControllerTarget,
  registerBleLedTransport,
  bleLedDriver,
  type BleLedLink,
  type BleLedTransport,
  type BleLedDriverOptions,
} from './ble';

const drivers = { wled: wledDriver, ble: bleLedDriver } satisfies Record<string, LedControllerDriver>;
export type LedControllerType = keyof typeof drivers;
/** Every controller type the app can drive. The server stores nothing else. */
export const LED_CONTROLLER_TYPES = Object.keys(drivers) as [LedControllerType, ...LedControllerType[]];

/** Add further systems here without coupling the editor to their wire format. */
export function getLedControllerDriver(type: LedControllerType): LedControllerDriver {
  return drivers[type];
}
