import { parseBoardTypeFromDeviceName, type AuroraBoardName } from './aurora';
import { isMoonboardDeviceName } from './moonboard';
import { isWoodsDeviceName } from './woods';

/** Name identity is independent of the packet encoder a board uses. */
export function parseAnyBoardTypeFromDeviceName(
  deviceName?: string,
): AuroraBoardName | 'moonboard' | 'woods' | undefined {
  if (!deviceName) return undefined;
  if (isMoonboardDeviceName(deviceName)) return 'moonboard';
  if (isWoodsDeviceName(deviceName)) return 'woods';
  return parseBoardTypeFromDeviceName(deviceName);
}

/**
 * What a Boardsesh Spraywall LED controller (embedded/projects/board-controller,
 * env gledopto-c015-spraywall) advertises: this prefix, a space and the last
 * two bytes of its Bluetooth MAC in hex, e.g. `Boardsesh Spraywall 1A2B`. It
 * speaks Aurora API v3 over Nordic UART, but advertises neither the Aurora
 * service nor UART and has no `#serial@api` suffix, so the board pickers
 * (`isLikelyBoardDevice`) never list it as a Kilter, Tension or MoonBoard.
 */
export const SPRAY_LED_CONTROLLER_NAME_PREFIX = 'Boardsesh Spraywall';
const SPRAY_LED_CONTROLLER_NAME = /^Boardsesh Spraywall [0-9A-F]{4}$/;

/** Exactly the name the firmware advertises; anything else is not a Spraywall controller. */
export function isSprayLedControllerName(deviceName?: string | null): boolean {
  return !!deviceName && SPRAY_LED_CONTROLLER_NAME.test(deviceName);
}
