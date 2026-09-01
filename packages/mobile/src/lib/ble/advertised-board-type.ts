import { parseBoardTypeFromDeviceName, parseSerialNumber } from '@boardsesh/ble-protocol';

/**
 * Only the advertised name matters here, so this takes the narrowest shape that
 * carries it — both the connect-time picker's `DiscoveredDevice` and the
 * quickstart scan's lighter records satisfy it. The other scan-result fields
 * are declared optional purely so a caller can hand over a full record without
 * TypeScript's excess-property check rejecting the literal; nothing reads them.
 */
export type NamedDevice = { name?: string; deviceId?: string; rssi?: number };

/**
 * The board type a controller announces in its BLE device name
 * (`Tension Board#12345@3`), keyed by the serial in that same name.
 *
 * Aurora numbers each board app separately, so a serial identifies a controller
 * only WITHIN a type: a Kilter `#12345` and a Tension `#12345` are different
 * hardware. The advertised name is the only trustworthy signal about the box in
 * front of the climber, so it decides which resolved board may claim a serial.
 *
 * This module is the single source of that rule. Both surfaces that turn scan
 * results into boards — the connect-time device picker (`resolve-serials.ts`)
 * and the Bluetooth quickstart sheet — go through it, so they can't drift into
 * disagreeing about which board a serial means.
 *
 * A serial whose name carries no recognisable type is simply absent from the
 * map, and is left unfiltered downstream: an unknown type is not evidence of a
 * mismatch, and dropping the match would lose a board we could otherwise name.
 */
export type AdvertisedBoardTypes = ReadonlyMap<string, string>;

export function advertisedBoardTypesBySerial(devices: ReadonlyArray<NamedDevice>): Map<string, string> {
  const advertisedTypes = new Map<string, string>();
  for (const device of devices) {
    const serial = parseSerialNumber(device.name);
    if (!serial || advertisedTypes.has(serial)) continue;
    const boardType = parseBoardTypeFromDeviceName(device.name);
    if (boardType) advertisedTypes.set(serial, boardType);
  }
  return advertisedTypes;
}

/**
 * The single board type a request can be scoped to, or undefined when the scan
 * is mixed (or nothing advertised a type). One argument can't describe two
 * types, so a mixed scan goes out unscoped and `matchesAdvertisedType` filters
 * the response per serial.
 */
export function sharedAdvertisedBoardType(advertisedTypes: AdvertisedBoardTypes): string | undefined {
  const distinctTypes = new Set(advertisedTypes.values());
  return distinctTypes.size === 1 ? [...distinctTypes][0] : undefined;
}

/**
 * Whether a board of `boardType` may claim `serialNumber`. Unknown on either
 * side means "can't tell" — keep it, per the permissive rule above.
 */
export function matchesAdvertisedType(
  serialNumber: string,
  boardType: string | null | undefined,
  advertisedTypes: AdvertisedBoardTypes,
): boolean {
  const advertisedType = advertisedTypes.get(serialNumber);
  if (!advertisedType || !boardType) return true;
  return boardType === advertisedType;
}
