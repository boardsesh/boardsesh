import type { UserBoard } from '@boardsesh/shared-schema';
import type { BoardSerialConfig } from '@boardsesh/graphql/operations';
import { matchesAdvertisedType, type AdvertisedBoardTypes } from './advertised-board-type';

function candidateGroupKey(serialNumber: string, boardType: string): string {
  return `${serialNumber}\u0000${boardType}`;
}

/**
 * Turns the public candidates for nearby controllers into the choices we show
 * a signed-in climber. A saved serial pointer wins only within its own
 * serial-and-board-type group, and only if it still points to an available
 * candidate. That keeps stale pointers and serial reuse from hiding boards
 * the climber may need to choose manually.
 */
export function selectBleBoardCandidates(
  boards: ReadonlyArray<UserBoard>,
  configs: ReadonlyArray<BoardSerialConfig>,
  advertisedTypes: AdvertisedBoardTypes,
): UserBoard[] {
  const candidates = boards.filter(
    (board) => !board.serialNumber || matchesAdvertisedType(board.serialNumber, board.boardType, advertisedTypes),
  );
  const candidatesByGroup = new Map<string, UserBoard[]>();
  for (const board of candidates) {
    if (!board.serialNumber) continue;
    const groupKey = candidateGroupKey(board.serialNumber, board.boardType);
    const group = candidatesByGroup.get(groupKey) ?? [];
    group.push(board);
    candidatesByGroup.set(groupKey, group);
  }

  const preferredUuidsByGroup = new Map<string, Set<string>>();
  for (const config of configs) {
    if (!config.boardUuid) continue;
    if (!matchesAdvertisedType(config.serialNumber, config.boardName, advertisedTypes)) continue;
    const groupKey = candidateGroupKey(config.serialNumber, config.boardName);
    const group = candidatesByGroup.get(groupKey);
    if (!group?.some((board) => board.uuid === config.boardUuid)) continue;
    const preferredUuids = preferredUuidsByGroup.get(groupKey) ?? new Set<string>();
    preferredUuids.add(config.boardUuid);
    preferredUuidsByGroup.set(groupKey, preferredUuids);
  }

  return candidates.filter((board) => {
    if (!board.serialNumber) return true;
    const preferredUuids = preferredUuidsByGroup.get(candidateGroupKey(board.serialNumber, board.boardType));
    // A corrupted response with two pointers for one group is ambiguous. Keep
    // every candidate instead of relying on API response order.
    return !preferredUuids || preferredUuids.size !== 1 || preferredUuids.has(board.uuid);
  });
}
