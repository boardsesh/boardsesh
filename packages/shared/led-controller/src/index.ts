import type { LedControllerDriver } from './types';
import { wledDriver } from './wled';

export * from './types';
export { isLocalControllerHost, normalizeControllerUrl, normalizeLocalControllerUrl } from './url';
export { createLedPreviewSession, type LedPreviewSession } from './preview';
export { createWledDriver, wledDriver, type WledDriverOptions } from './wled';

const drivers = { wled: wledDriver } satisfies Record<string, LedControllerDriver>;
export type LedControllerType = keyof typeof drivers;
/** Every controller type the app can drive. The server stores nothing else. */
export const LED_CONTROLLER_TYPES = Object.keys(drivers) as [LedControllerType, ...LedControllerType[]];

/** Add further systems here without coupling the editor to their wire format. */
export function getLedControllerDriver(type: LedControllerType): LedControllerDriver {
  return drivers[type];
}
