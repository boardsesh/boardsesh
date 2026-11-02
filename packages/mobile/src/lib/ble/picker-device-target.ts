import { parseAnyBoardTypeFromDeviceName, parseSerialNumber } from '@boardsesh/ble-protocol';
import { configFromResolvedEntry } from './board-config-match';
import type { ResolvedBoardEntry } from './resolve-serials';
import type { DiscoveredDevice } from './types';

/**
 * Physical board identity captured when a picker session opens.
 * `rememberedDeviceId`: the BLE id of the box this phone remembers for that
 * board, when it is remembered by id (a MoonBoard or a serial-less Kilter-built
 * box) and a hang-up's 10 minutes have not run out.
 */
export type PickerBoardTarget = { boardUuid: string; boardName: string; rememberedDeviceId?: string };

/**
 * How a scanned controller relates to the board a picker session is for.
 *
 * - `target`: its serial resolves to exactly this board, or nothing on record
 *   names its board and it is the box this phone remembers for this one
 *   (`rememberedDeviceId`).
 * - `other`: it is positively a different board. Its serial resolves to
 *   another board, or its advertised board type is not the target's.
 * - `unknown`: nothing says either way. No serial (every stock MoonBoard and
 *   every bare-name Kilter or Tension box this phone doesn't remember), a
 *   serial nobody has recorded, or a recording that names no board.
 *
 * The picker lists `target` then `unknown` and hides only `other` until the
 * climber asks for every board (#7125). Nothing resolved in 2,521 of 2,522
 * MoonBoard pickers and half of Android Kilter pickers (30 days to 2026-10-31),
 * so hiding `unknown` as well opened those gym connects on "Your selected board
 * was not found" with nothing listed.
 */
export type PickerTargetMatch = 'target' | 'unknown' | 'other';

export function classifyPickerDevice(
  device: DiscoveredDevice,
  resolvedBoards: ReadonlyMap<string, ResolvedBoardEntry>,
  target: PickerBoardTarget,
): PickerTargetMatch {
  // Aurora serials are unique only within a board type, and the resolution map
  // is keyed by serial. A controller that says it is a Tension is never the
  // gym's Kilter, whatever its serial resolves to.
  const advertisedType = parseAnyBoardTypeFromDeviceName(device.name);
  if (advertisedType !== undefined && advertisedType !== target.boardName) return 'other';

  const serial = parseSerialNumber(device.name);
  const resolvedEntry = serial ? resolvedBoards.get(serial) : undefined;
  const resolvedConfig = resolvedEntry ? configFromResolvedEntry(resolvedEntry) : null;
  if (resolvedConfig) {
    if (resolvedConfig.boardName !== target.boardName) return 'other';
    // A recorded geometry with no board UUID names no physical board, so it
    // cannot contradict the target. Picking it still runs the geometry check.
    if (resolvedConfig.boardUuid) return resolvedConfig.boardUuid === target.boardUuid ? 'target' : 'other';
  }
  // Nothing on record names this box's board. The one this phone remembers
  // for the target (by BLE id: no serial to resolve) is the target's own.
  return target.rememberedDeviceId !== undefined && device.deviceId === target.rememberedDeviceId
    ? 'target'
    : 'unknown';
}

/**
 * A box only its BLE id could ever tell apart: it advertises the target's board
 * type and no serial. Every stock MoonBoard box looks like this, and so does a
 * Kilter-built box that advertises only `Kilter Board`. On a first connect the
 * climber's own box is one of these, sitting in the `unknown` group, so the
 * picker counts it as their board heard and keeps "Don't see your board?" off
 * the sheet while it is listed. An `unknown` box with a serial nobody recorded
 * is another box, and one that advertises no board type could be anything.
 */
export function isSerialLessBoxOfTargetType(device: DiscoveredDevice, target: PickerBoardTarget): boolean {
  return (
    parseSerialNumber(device.name) === undefined && parseAnyBoardTypeFromDeviceName(device.name) === target.boardName
  );
}

export type PickerDeviceGroups = Record<PickerTargetMatch, DiscoveredDevice[]>;

/**
 * Split a scan into the three groups, keeping scan order inside each. Shared by
 * the picker sheet and the picker analytics so the two count the same rows.
 */
export function groupPickerDevices(
  devices: ReadonlyArray<DiscoveredDevice>,
  resolvedBoards: ReadonlyMap<string, ResolvedBoardEntry>,
  target: PickerBoardTarget,
): PickerDeviceGroups {
  const groups: PickerDeviceGroups = { target: [], unknown: [], other: [] };
  for (const device of devices) {
    groups[classifyPickerDevice(device, resolvedBoards, target)].push(device);
  }
  return groups;
}
