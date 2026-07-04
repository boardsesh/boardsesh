import { MOONBOARD_GRID, MOONBOARD_DEVICE_NAME_PREFIXES } from '@boardsesh/board-constants/moonboard';

const MOONBOARD_FRAME_PREFIX = 'l#';
const MOONBOARD_FRAME_SUFFIX = '#';

// Boardsesh persists MoonBoard frames with the shared basic role codes only.
// The newer controller firmware can render extra preview-only roles, but the
// web client does not emit them in climb frames.
const MOONBOARD_ROLE_MAP = {
  42: 'S',
  43: 'P',
  44: 'E',
} as const;

export type MoonboardPacketResult = {
  packet: Uint8Array;
  skippedRoleCount: number;
  skippedPositionCount: number;
  totalPlacements: number;
  /**
   * True only for the deliberate clear-all input (`frames === ''`), whose
   * packet is the bare `l##` frame. Consumers must refuse to write whenever
   * `!isClear` and nothing encoded (all placements skipped, or a degenerate
   * non-empty frames string that parses to zero placements) — writing `l##`
   * there would silently dark the wall while the send reported success.
   */
  isClear: boolean;
};

// Note: UART_SERVICE_UUID is available from './transport' — not re-exported
// here to avoid collisions in the barrel index.

export function isMoonboardDeviceName(name?: string): boolean {
  return !!name && MOONBOARD_DEVICE_NAME_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * Convert a hold id to its position on the physical LED string.
 *
 * The LED strip is wired as a column-major serpentine, so the per-column LED
 * count — the number of rows — sets the stride. The standard board has 18 rows;
 * the Mini MoonBoard strip is 12 rows tall (confirmed against the official app's
 * protocol, which sends an `M` flag and addresses the Mini on a 12-row grid).
 * `numRows` defaults to the standard board so existing callers are unchanged.
 */
export function getMoonboardSerialPosition(holdId: number, numRows: number = MOONBOARD_GRID.numRows): number {
  const maxHoldId = MOONBOARD_GRID.numColumns * numRows;
  if (!Number.isInteger(holdId) || holdId < 1 || holdId > maxHoldId) {
    throw new Error(`MoonBoard hold id out of range: ${holdId}`);
  }

  const zeroBasedHoldId = holdId - 1;
  const colIndex = zeroBasedHoldId % MOONBOARD_GRID.numColumns;
  const rowIndex = Math.floor(zeroBasedHoldId / MOONBOARD_GRID.numColumns);

  if (colIndex % 2 === 0) {
    return colIndex * numRows + rowIndex;
  }

  return colIndex * numRows + (numRows - 1 - rowIndex);
}

export function getMoonboardBluetoothPacket(
  frames: string,
  numRows: number = MOONBOARD_GRID.numRows,
): MoonboardPacketResult {
  const encodedHolds: string[] = [];
  let skippedRoleCount = 0;
  let skippedPositionCount = 0;

  const frameParts = frames.split('p').filter(Boolean);

  frameParts.forEach((frame) => {
    const [placement, role] = frame.split('r');
    const holdId = Number(placement);
    const holdType = MOONBOARD_ROLE_MAP[Number(role) as keyof typeof MOONBOARD_ROLE_MAP];

    if (!holdType) {
      skippedRoleCount++;
      return;
    }

    try {
      encodedHolds.push(`${holdType}${getMoonboardSerialPosition(holdId, numRows)}`);
    } catch {
      skippedPositionCount++;
    }
  });

  if (skippedPositionCount > 0) {
    console.warn(`[BLE] Skipped ${skippedPositionCount} MoonBoard holds with invalid ids for this payload`);
  }

  const holdPayload = encodedHolds.join(',');

  // `l##` (empty holdPayload) is MoonBoard's clear-all: community firmware
  // (ArduinoMoonBoardLED) clears every LED on each incoming frame; unverified on
  // official Moon controllers (at worst a no-op). Only the deliberate-clear input
  // (frames === '') marks the result `isClear` — a climb that merely encodes to
  // nothing produces the same bytes but must be refused by the caller.
  return {
    packet: new TextEncoder().encode(`${MOONBOARD_FRAME_PREFIX}${holdPayload}${MOONBOARD_FRAME_SUFFIX}`),
    skippedRoleCount,
    skippedPositionCount,
    totalPlacements: frameParts.length,
    isClear: frames === '',
  };
}
