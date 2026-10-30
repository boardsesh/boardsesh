import { parseAnyBoardTypeFromDeviceName, parseSerialNumber } from '@boardsesh/ble-protocol';
import { configFromResolvedEntry } from './board-config-match';
import type { ResolvedBoardEntry } from './resolve-serials';
import type { DiscoveredDevice } from './types';

/** Physical board identity captured when a picker session opens. */
export type PickerBoardTarget = { boardUuid: string; boardName: string };

export function deviceMatchesPickerTarget(
  device: DiscoveredDevice,
  resolvedBoards: ReadonlyMap<string, ResolvedBoardEntry>,
  target: PickerBoardTarget,
): boolean {
  const serial = parseSerialNumber(device.name);
  const resolvedEntry = serial ? resolvedBoards.get(serial) : undefined;
  if (!resolvedEntry) return false;
  const resolvedConfig = configFromResolvedEntry(resolvedEntry);
  if (resolvedConfig?.boardUuid !== target.boardUuid || resolvedConfig.boardName !== target.boardName) return false;

  // Aurora serials are unique only within a board type. The resolution map is
  // keyed by serial, so a Tension advert must not inherit a Kilter's identity.
  const advertisedType = parseAnyBoardTypeFromDeviceName(device.name);
  return advertisedType === undefined || advertisedType === target.boardName;
}
