import {
  MOONBOARD_GRID,
  encodeMoonboardPacket,
  encodeMoonboardClear,
  getMoonboardSerialPosition,
  type MoonboardPacketOptions,
} from '@boardsesh/moonboard-ble-protocol';
import type { BoardLight, BoardRole } from '@boardsesh/ble-core';

export { getMoonboardSerialPosition, isMoonboardDeviceName } from '@boardsesh/moonboard-ble-protocol';
export type { MoonboardPacketOptions };

// Boardsesh saved frames use these role IDs. The portable codec consumes roles
// and physical indices rather than catalog frame strings.
const MOONBOARD_ROLE_MAP: Readonly<Record<number, BoardRole>> = { 42: 'start', 43: 'hand', 44: 'finish' };

export type MoonboardPacketResult = {
  packet: Uint8Array;
  skippedRoleCount: number;
  skippedPositionCount: number;
  totalPlacements: number;
  /** Only a deliberate empty input may clear; all-skipped non-empty input must be refused. */
  isClear: boolean;
};

export function getMoonboardBluetoothPacket(
  frames: string,
  numRows: number = MOONBOARD_GRID.numRows,
  options: MoonboardPacketOptions = {},
): MoonboardPacketResult {
  const lights: BoardLight[] = [];
  let skippedRoleCount = 0;
  let skippedPositionCount = 0;
  const frameParts = frames.split('p').filter(Boolean);
  for (const frame of frameParts) {
    const [placement, role] = frame.split('r');
    const holdRole = MOONBOARD_ROLE_MAP[Number(role)];
    if (!holdRole) {
      skippedRoleCount++;
      continue;
    }
    try {
      lights.push({ index: getMoonboardSerialPosition(Number(placement), numRows), role: holdRole });
    } catch {
      skippedPositionCount++;
    }
  }
  if (skippedPositionCount > 0) {
    console.warn(`[BLE] Skipped ${skippedPositionCount} MoonBoard holds with invalid ids for this payload`);
  }
  return {
    // Preserve legacy bytes and isClear diagnostics. The app rejects full misses;
    // the new public session independently rejects an empty show() before writing.
    packet: lights.length ? encodeMoonboardPacket(lights, { ...options, numRows }) : encodeMoonboardClear(),
    skippedRoleCount,
    skippedPositionCount,
    totalPlacements: frameParts.length,
    isClear: frames === '',
  };
}
