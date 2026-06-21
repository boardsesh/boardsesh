import { AURORA_ADVERTISED_SERVICE_UUID, UART_SERVICE_UUID, parseSerialNumber } from '@boardsesh/ble-protocol';
import { parseBoardTypeFromDeviceName } from '@boardsesh/ble-protocol/aurora';
import { isMoonboardDeviceName } from '@boardsesh/ble-protocol/moonboard';
import type { BoardScanFamily } from './types';

const AURORA_SERVICE_UUID = AURORA_ADVERTISED_SERVICE_UUID.toLowerCase();
const UART_SERVICE_UUID_LOWER = UART_SERVICE_UUID.toLowerCase();
const STRICT_AURORA_SERIAL_SUFFIX = /#[A-Za-z0-9-]+@\d+$/;

/**
 * Decides whether a scan result looks like a climbing board. The adapters scan
 * according to the current board family: Aurora routes should not surface
 * generic UART peripherals, while MoonBoard routes still need name-based
 * matching because those controllers do not reliably advertise UART.
 *
 * Known limitation: on old iOS binaries the native scan already filters by the
 * Aurora service UUID before delivering results to JS, so those scan results
 * arrive with `serviceUuids === undefined`. When that happens this function
 * returns `true` unconditionally — device name is not checked — because the
 * native side has already vouched for the peripheral. This does not widen
 * Android or new-binary filtering; `RNBleAdapter` always passes an array
 * (possibly empty), never `undefined`.
 */
export function isLikelyBoardDevice({
  name,
  serviceUuids,
  scanFamily,
}: {
  name?: string;
  serviceUuids?: string[] | null;
  scanFamily: BoardScanFamily;
}): boolean {
  if (scanFamily === 'aurora') {
    // `undefined` serviceUuids only occur on old iOS binaries whose native scan
    // already filtered by the Aurora service UUID — the native side vouched for
    // the device, so trust it. RNBleAdapter always passes an array (possibly
    // empty), so this never loosens Android / new-binary filtering. `null` is
    // NOT vouched and falls through to the name checks below.
    if (serviceUuids === undefined) return true;
    if (serviceUuids?.some((serviceUuid) => serviceUuid.toLowerCase() === AURORA_SERVICE_UUID)) {
      return true;
    }
    if (!name) return false;
    if (parseBoardTypeFromDeviceName(name) !== undefined) return true;
    return STRICT_AURORA_SERIAL_SUFFIX.test(name.trim()) && parseSerialNumber(name) !== undefined;
  }

  if (serviceUuids?.some((serviceUuid) => serviceUuid.toLowerCase() === UART_SERVICE_UUID_LOWER)) {
    return true;
  }

  if (!name) return false;
  return isMoonboardDeviceName(name);
}
