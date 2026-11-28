import {
  WOODS_LED_MAPS,
  WOODS_WIRE_ROLE,
  encodeWoodsPacket,
  encodeWoodsClear,
  type WoodsBoardSize,
} from '@boardsesh/woods-ble-protocol';
import type { BoardLight, BoardRole } from '@boardsesh/ble-core';

export { isWoodsDeviceName } from '@boardsesh/woods-ble-protocol';
export type { WoodsBoardSize };

const FRAME_ROLES: Readonly<Record<number, BoardRole>> = {
  [WOODS_WIRE_ROLE.FOOT]: 'foot',
  [WOODS_WIRE_ROLE.HAND]: 'hand',
  [WOODS_WIRE_ROLE.FINISH]: 'finish',
  [WOODS_WIRE_ROLE.START]: 'start',
};

export type WoodsPacketResult = {
  packet: Uint8Array;
  skippedPositionCount: number;
  skippedRoleCount: number;
  totalPlacements: number;
};

export class WoodsMultiFrameError extends Error {
  constructor() {
    super('Woods does not support Aurora comma-separated multi-frame climbs');
    this.name = 'WoodsMultiFrameError';
  }
}

/** Compatibility adapter for Boardsesh's p{baseHoldLocation}r{roleCode} frames. */
export function getWoodsBluetoothPacket(frames: string, size: WoodsBoardSize): WoodsPacketResult {
  if (frames.includes(',')) throw new WoodsMultiFrameError();
  const ledMap = WOODS_LED_MAPS[size];
  const lights: BoardLight[] = [];
  let skippedRoleCount = 0;
  let skippedPositionCount = 0;
  const frameParts = frames.split('p').filter(Boolean);
  for (const frame of frameParts) {
    const [placement, role] = frame.split('r');
    const holdRole = FRAME_ROLES[Number(role)];
    if (!holdRole) {
      skippedRoleCount++;
      continue;
    }
    const index = ledMap[Number(placement)];
    if (index === undefined) {
      skippedPositionCount++;
      continue;
    }
    lights.push({ index, role: holdRole });
  }
  return {
    // Existing consumers use the skip counts to refuse an accidental empty send.
    packet: lights.length ? encodeWoodsPacket(lights, size) : encodeWoodsClear(),
    skippedPositionCount,
    skippedRoleCount,
    totalPlacements: frameParts.length,
  };
}
