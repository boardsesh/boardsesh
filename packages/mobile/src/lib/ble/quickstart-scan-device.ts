// What the Bluetooth quickstart keeps from one advertisement, and the order it
// lists boards in.
//
// The quickstart used to keep only devices whose name carried an Aurora serial
// (`Kilter Board#751737@3`). That dropped ordinary serial-less MoonBoards and
// every Kilter-built box (a bare `Kilter Board`), so a climber standing at one
// waited 15 seconds for "No boards in range". 45% of the connect picker's
// sightings had no serial. These are kept now, keyed by the BLE device id, so
// the sheet can say what it found and offer the next step.

import type { BoardName } from '@boardsesh/shared-schema';
import { AURORA_ADVERTISED_SERVICE_UUID } from '@boardsesh/ble-protocol';
import { isKilterBuiltBox, parseBoardTypeFromDeviceName, parseSerialNumber } from '@boardsesh/ble-protocol/aurora';
import { isMoonboardDeviceName } from '@boardsesh/ble-protocol/moonboard';
import { MOONBOARD_BOARD_NAME, toBoardName } from '@boardsesh/board-config';
import { isLikelyBoardDevice } from './board-device-filter';
import { isUsableRssi } from './rssi-strength';

type QuickstartScanDeviceBase = {
  /**
   * One entry per key. A serial box is keyed by its serial, which is how the
   * lookup has always deduplicated them. A serial-less board is keyed by its BLE
   * device id, the only thing that tells two of them apart.
   */
  key: string;
  deviceId: string;
  /** The advertised name. Kept because the board type and serial live in it. */
  name: string;
  /**
   * Signal strength of the first advertisement heard, in dBm, or null when the
   * platform gave none. Used to order rows, closest first, and nothing else:
   * walls, bodies and the controller's own antenna move it by 10 dB or more.
   */
  rssi: number | null;
};

/**
 * A controller whose name carries its serial, including MoonBoard fixtures.
 */
export type QuickstartSerialDevice = QuickstartScanDeviceBase & {
  kind: 'serial';
  serial: string;
  /** The board type the name announces, or null when it names none we know. */
  boardType: BoardName | null;
};

/**
 * A board that advertises no serial: an ordinary MoonBoard controller or
 * a Kilter-built Aurora box that advertises only its type, `Kilter Board`
 * (`isKilterBuiltBox`). Its type is all we know.
 */
export type QuickstartSeriallessDevice = QuickstartScanDeviceBase & {
  kind: 'moonboard' | 'bare_name';
  serial: null;
  boardType: BoardName;
};

export type QuickstartScanDevice = QuickstartSerialDevice | QuickstartSeriallessDevice;

const AURORA_SERVICE_UUID = AURORA_ADVERTISED_SERVICE_UUID.toLowerCase();
// `Kilter Board@2`: the spec allows an API level with no serial.
const API_LEVEL_SUFFIX = /@\d+$/;

/**
 * The board type of an Aurora box that advertises no serial, or null when the
 * name only looks like one.
 *
 * `isKilterBuiltBox` is a prefix match (`Tensioner`, `Kilter-anything` and a
 * gadget called `Decoy` all pass it), which is fine where it only picks a write
 * mode for a box the climber chose, but not for telling a climber "Found a
 * board". So the name, less any `@apiLevel`, has to be exactly `<Type> Board`
 * (case, spaces and hyphens aside), the form every Aurora box advertises and
 * the one the recon data saw (`Kilter Board`). A bare `<Type>` counts only when
 * the device also advertises the Aurora service.
 */
function bareNameBoardType(name: string, serviceUuids: string[]): BoardName | null {
  if (!isKilterBuiltBox(name)) return null;
  const boardType = toBoardName(parseBoardTypeFromDeviceName(name));
  if (!boardType) return null;
  const displayName = name.trim().replace(API_LEVEL_SUFFIX, '').toLowerCase().replace(/[\s-]/g, '');
  if (displayName === `${boardType}board`) return boardType;
  const advertisesAuroraService = serviceUuids.some((serviceUuid) => serviceUuid.toLowerCase() === AURORA_SERVICE_UUID);
  return displayName === boardType && advertisesAuroraService ? boardType : null;
}

/**
 * The board one advertisement belongs to, or null when it is not one the
 * quickstart lists.
 *
 * A MoonBoard is admitted by its advertised name prefix and nothing else. The
 * Nordic UART service it may advertise is shared by heart-rate straps, LED
 * strips and every other UART gadget, and the MoonBoard-family scan filter
 * (`isLikelyBoardDevice` with `scanFamily: 'moonboard'`) also admits Woods
 * boards. Neither belongs in a list that says "Found a MoonBoard".
 *
 * Aurora boxes go through the same check the quickstart has always used, so a
 * stray `Printer #751737` still never reaches the serial lookup.
 */
export function classifyQuickstartDevice({
  deviceId,
  name,
  serviceUuids,
  rssi,
}: {
  deviceId: string;
  name: string | undefined;
  serviceUuids: string[];
  rssi: number | null | undefined;
}): QuickstartScanDevice | null {
  if (!name) return null;
  const signal = isUsableRssi(rssi) ? rssi : null;

  if (isMoonboardDeviceName(name)) {
    const serial = parseSerialNumber(name);
    if (serial) {
      return {
        key: `serial:${serial}`,
        deviceId,
        name,
        kind: 'serial',
        boardType: MOONBOARD_BOARD_NAME,
        serial,
        rssi: signal,
      };
    }
    return {
      key: `device:${deviceId}`,
      deviceId,
      name,
      kind: 'moonboard',
      boardType: MOONBOARD_BOARD_NAME,
      serial: null,
      rssi: signal,
    };
  }

  if (!isLikelyBoardDevice({ name, serviceUuids, scanFamily: 'aurora' })) return null;

  const serial = parseSerialNumber(name);
  if (serial) {
    return {
      key: `serial:${serial}`,
      deviceId,
      name,
      kind: 'serial',
      boardType: toBoardName(parseBoardTypeFromDeviceName(name)),
      serial,
      rssi: signal,
    };
  }

  const boardType = bareNameBoardType(name, serviceUuids);
  if (!boardType) return null;
  return { key: `device:${deviceId}`, deviceId, name, kind: 'bare_name', boardType, serial: null, rssi: signal };
}

/**
 * Strongest signal first, the order the connect picker uses. A board with no
 * reading goes last, and ties keep the order they were heard in.
 */
export function compareBySignal(first: { rssi: number | null }, second: { rssi: number | null }): number {
  if (first.rssi === second.rssi) return 0;
  if (first.rssi === null) return 1;
  if (second.rssi === null) return -1;
  return second.rssi - first.rssi;
}
