import type { LedControllerDriver } from './types';
import { wledDriver } from './wled';

export * from './types';
export {
  isLocalControllerHost,
  normalizeControllerUrl,
  normalizeLocalControllerUrl,
  normalizeLedControllerTarget,
  normalizeWledBleTarget,
} from './url';
export { createLedPreviewSession, type LedPreviewSession } from './preview';
export { createWledDriver, wledDriver, type WledDriverOptions } from './wled';
export { createWledBleDriver } from './wled-ble';

const drivers = { wled: wledDriver } satisfies Record<string, LedControllerDriver>;
export type LedControllerType = keyof typeof drivers | 'wled-ble';
/** Every controller type the app can drive. The server stores nothing else. */
export const LED_CONTROLLER_TYPES = ['wled', 'wled-ble'] as const;

/** Add further systems here without coupling the editor to their wire format. */
export function getLedControllerDriver(type: LedControllerType): LedControllerDriver {
  if (type === 'wled-ble') throw new Error('WLED BLE requires a native connector');
  return drivers[type];
}
