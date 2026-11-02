import type { LedControllerDriver } from './types';
import { wledDriver } from './wled';

export * from './types';
export { normalizeControllerUrl } from './url';
export { createWledDriver, wledDriver, type WledDriverOptions } from './wled';

const drivers = { wled: wledDriver } satisfies Record<string, LedControllerDriver>;
export type LedControllerType = keyof typeof drivers;

/** Add further systems here without coupling the editor to their wire format. */
export function getLedControllerDriver(type: LedControllerType): LedControllerDriver {
  return drivers[type];
}
