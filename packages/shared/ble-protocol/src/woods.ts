import {
  WOODS_LED_MAPS,
  WOODS_WIRE_ROLE,
  isWoodsDeviceName,
  type WoodsBoardSize,
} from '@boardsesh/board-constants/woods';

// Re-exported so BLE callers can do device detection and size typing from a
// single module, mirroring how `moonboard.ts` surfaces `isMoonboardDeviceName`.
export { isWoodsDeviceName };
export type { WoodsBoardSize };

// The Woods command is a plain ASCII string of `ledIndex,roleCode` pairs,
// terminated by `,!` (spec §5). Unlike Aurora's binary frames it carries no
// colour — the board derives each LED's colour from the role code.
const WOODS_TERMINATOR = ',!';

// Frames Boardsesh stores for Woods climbs (`p{baseHoldLocation}r{roleCode}`)
// use the same numeric role codes the firmware expects on the wire (spec §6):
// 1 Foot, 2 Hand, 3 Finish, 4 Start. Any other code (an "off"/clear marker, or a
// stray value) is dropped, matching the "holds whose role is off are omitted"
// rule. Derived from WOODS_WIRE_ROLE rather than restated, so a role added to the
// constants can't silently go unlit here.
const WOODS_WIRE_ROLE_CODES = new Set<number>(Object.values(WOODS_WIRE_ROLE));

export type WoodsPacketResult = {
  packet: Uint8Array;
  /** Placements with no LED for this board size (skipped). */
  skippedPositionCount: number;
  /** Placements whose role code is not a lit Woods role (skipped). */
  skippedRoleCount: number;
  /** Total placement entries parsed from the frames string. */
  totalPlacements: number;
};

export class WoodsMultiFrameError extends Error {
  constructor() {
    super('Woods does not support Aurora comma-separated multi-frame climbs');
    this.name = 'WoodsMultiFrameError';
  }
}

// Note: UART_SERVICE_UUID / UART_WRITE_CHARACTERISTIC_UUID are available from
// './transport' — Woods uses the same Nordic UART transport as the newer
// MoonBoard controllers (spec §2).

/**
 * Build the Woods Board BLE command for a set of lit holds.
 *
 * Each lit hold becomes a `ledIndex,roleCode` pair: the role code comes straight
 * from the frame, the LED index from the per-size lookup table (spec §7). Pairs
 * are joined with `,` and the whole message is terminated with `,!`. Empty frames
 * produce a bare `,!` — the "clear the board" command (no pairs).
 *
 * Missing placements/roles are skipped gracefully; the result carries counts so
 * callers can detect a partial or full miss.
 *
 * Aurora comma-separated multi-frame input is unsupported. Reject it before
 * parsing so a syntactically valid subset can never be encoded and written while
 * the comma-contaminated placements are silently dropped. Flatten upstream if
 * Woods gains an explicit multi-frame policy.
 */
export function getWoodsBluetoothPacket(frames: string, size: WoodsBoardSize): WoodsPacketResult {
  if (frames.includes(',')) throw new WoodsMultiFrameError();

  const ledMap = WOODS_LED_MAPS[size];
  const pairs: string[] = [];
  let skippedRoleCount = 0;
  let skippedPositionCount = 0;

  const frameParts = frames.split('p').filter(Boolean);

  frameParts.forEach((frame) => {
    const [placement, role] = frame.split('r');
    const roleCode = Number(role);

    if (!WOODS_WIRE_ROLE_CODES.has(roleCode)) {
      skippedRoleCount++;
      return;
    }

    const ledIndex = ledMap[Number(placement)];
    if (ledIndex === undefined) {
      skippedPositionCount++;
      return;
    }

    pairs.push(`${ledIndex},${roleCode}`);
  });

  return {
    packet: new TextEncoder().encode(`${pairs.join(',')}${WOODS_TERMINATOR}`),
    skippedPositionCount,
    skippedRoleCount,
    totalPlacements: frameParts.length,
  };
}
