import { getAuroraBluetoothPacket, parseApiLevel, type AuroraBoardName } from '@boardsesh/ble-protocol/aurora';
import { getMoonboardBluetoothPacket } from '@boardsesh/ble-protocol/moonboard';
import { getWoodsBluetoothPacket } from '@boardsesh/ble-protocol/woods';
import { getMoonBoardGeometryByLayoutId, toAuroraBoardName, woodsSizeIdToDimension } from '@boardsesh/board-config';
import { toFlatFrames } from '@boardsesh/board-constants/hold-states';
import { getLedPlacements } from '@boardsesh/board-constants/led-placements';
import type { ActiveBoard } from '../board/active-board';

export type PacketResult =
  | { kind: 'packet'; packet: Uint8Array }
  /** None of the climb's holds map to an LED on this board, so sending would just turn the lights off. */
  | { kind: 'incompatible' };

type PacketBoard = Pick<ActiveBoard, 'boardName' | 'layoutId' | 'sizeId'>;

/**
 * The Bluetooth packet that lights `frames` on `board`. An empty `frames` is a
 * deliberate "clear the board".
 *
 * `deviceName` is the connected controller's advertised name. Aurora encodes it
 * with the protocol version the controller reports there (`…@3`).
 */
export function buildBoardPacket(board: PacketBoard, frames: string, deviceName: string | null): PacketResult {
  const flatFrames = toFlatFrames(frames, board.boardName);

  if (board.boardName === 'moonboard') {
    // The Mini MoonBoard's LED strip runs 12 rows, the standard board 18.
    const { numRows } = getMoonBoardGeometryByLayoutId(board.layoutId);
    const result = getMoonboardBluetoothPacket(flatFrames, numRows);
    const encoded = result.totalPlacements - result.skippedRoleCount - result.skippedPositionCount;
    if (!result.isClear && encoded === 0) return { kind: 'incompatible' };
    return { kind: 'packet', packet: result.packet };
  }

  if (board.boardName === 'woods') {
    // Each Woods size has its own LED table. Multi-frame climbs arrive already
    // flattened above, which is how Boardsesh sends them too.
    const size = woodsSizeIdToDimension(board.sizeId);
    if (!size) return { kind: 'incompatible' };
    const result = getWoodsBluetoothPacket(flatFrames, size);
    const skipped = result.skippedRoleCount + result.skippedPositionCount;
    if (flatFrames !== '' && skipped === result.totalPlacements) return { kind: 'incompatible' };
    return { kind: 'packet', packet: result.packet };
  }

  const auroraBoard: AuroraBoardName | null = toAuroraBoardName(board.boardName);
  if (!auroraBoard) return { kind: 'incompatible' };
  const placements = getLedPlacements(auroraBoard, board.layoutId, board.sizeId);
  const result = getAuroraBluetoothPacket(flatFrames, placements, auroraBoard, parseApiLevel(deviceName ?? undefined));
  // An empty packet means every hold was skipped; an all-dark one would light nothing.
  if (result.packet.length === 0 || result.allLedsDark) return { kind: 'incompatible' };
  return { kind: 'packet', packet: result.packet };
}
