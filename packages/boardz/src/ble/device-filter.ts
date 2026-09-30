import type { BoardName } from '@boardsesh/shared-schema';
import {
  AURORA_ADVERTISED_SERVICE_UUID,
  REDBEARLAB_SERVICE_UUID,
  UART_SERVICE_UUID,
  parseSerialNumber,
} from '@boardsesh/ble-protocol';
import { parseBoardTypeFromDeviceName } from '@boardsesh/ble-protocol/aurora';
import { isMoonboardDeviceName } from '@boardsesh/ble-protocol/moonboard';
import { isWoodsDeviceName } from '@boardsesh/ble-protocol/woods';

/**
 * How Boardz talks to a board's controller. Aurora boards (Kilter, Tension,
 * Decoy, Touchstone, Grasshopper, So iLL) have their own service and binary
 * packets. MoonBoard and Woods controllers both take ASCII frames over Nordic
 * UART, but Woods wants every write acknowledged, so it's a family of its own.
 */
export type BoardFamily = 'aurora' | 'moonboard' | 'woods';

export function boardFamily(boardName: BoardName): BoardFamily {
  if (boardName === 'moonboard') return 'moonboard';
  if (boardName === 'woods') return 'woods';
  return 'aurora';
}

const AURORA_SERVICE = AURORA_ADVERTISED_SERVICE_UUID.toLowerCase();
// Newer MoonBoard controllers advertise Nordic UART; the original LED box
// advertises the RedBearLab service.
const MOONBOARD_SERVICES = [UART_SERVICE_UUID.toLowerCase(), REDBEARLAB_SERVICE_UUID.toLowerCase()];
// Woods boxes are Nordic UART only.
const WOODS_SERVICE = UART_SERVICE_UUID.toLowerCase();
const AURORA_SERIAL_SUFFIX = /#[A-Za-z0-9-]+@\d+$/;

/**
 * Whether a scan result looks like a board of this family. Same rules as
 * Boardsesh's `isLikelyBoardDevice`: a known service UUID, or a device name that
 * names the board, since some controllers only put their name in the advert.
 */
export function isLikelyBoardDevice({
  name,
  serviceUuids,
  family,
}: {
  name: string | null;
  serviceUuids: readonly string[];
  family: BoardFamily;
}): boolean {
  const advertised = serviceUuids.map((uuid) => uuid.toLowerCase());
  if (family === 'aurora') {
    if (advertised.includes(AURORA_SERVICE)) return true;
    if (!name) return false;
    if (parseBoardTypeFromDeviceName(name) !== undefined) return true;
    return AURORA_SERIAL_SUFFIX.test(name.trim()) && parseSerialNumber(name) !== undefined;
  }
  if (family === 'woods') {
    if (advertised.includes(WOODS_SERVICE)) return true;
    return name !== null && isWoodsDeviceName(name);
  }
  if (advertised.some((uuid) => MOONBOARD_SERVICES.includes(uuid))) return true;
  return name !== null && isMoonboardDeviceName(name);
}
