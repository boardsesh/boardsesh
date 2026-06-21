import { normaliseSetIds, toBoardName } from '@boardsesh/board-config';
import { parseSerialNumber } from '@boardsesh/ble-protocol';
import type { BoardName } from '@boardsesh/shared-schema';
import type { Climb, ClimbQueueItem } from '@boardsesh/queue';
import type { DiscoveredDevice } from './types';
import type { ResolvedBoardEntry } from './resolve-serials';

export type BleBoardConfig = {
  boardName: BoardName;
  layoutId: number;
  sizeId: number;
  setIds: string;
  boardSlug?: string | null;
};

export type PickerSelectionDecision =
  | { kind: 'forward' }
  | { kind: 'mismatch'; serial: string; config: BleBoardConfig; entry: ResolvedBoardEntry };

export function configFromResolvedEntry(entry: ResolvedBoardEntry): BleBoardConfig | undefined {
  if (entry.kind === 'saved') {
    const boardName = toBoardName(entry.board.boardType);
    if (!boardName) return undefined;
    return {
      boardName,
      layoutId: entry.board.layoutId,
      sizeId: entry.board.sizeId,
      setIds: entry.board.setIds,
      boardSlug: entry.board.slug,
    };
  }

  const boardName = toBoardName(entry.config.boardName);
  if (!boardName) return undefined;
  return {
    boardName,
    layoutId: entry.config.layoutId,
    sizeId: entry.config.sizeId,
    setIds: entry.config.setIds,
    boardSlug: entry.config.boardSlug,
  };
}

export function matchesBleBoardConfig(config: BleBoardConfig, currentConfig: BleBoardConfig | undefined): boolean {
  if (!currentConfig) return true;
  return (
    config.boardName === currentConfig.boardName &&
    config.layoutId === currentConfig.layoutId &&
    config.sizeId === currentConfig.sizeId &&
    normaliseSetIds(config.setIds) === normaliseSetIds(currentConfig.setIds)
  );
}

export type ClimbBoardCompatibility = 'compatible' | 'incompatible' | 'unknown';

/** The active-board fields needed to judge whether a climb belongs to this board. */
export type ActiveBoardForCompatibility = Pick<BleBoardConfig, 'boardName' | 'layoutId'>;

/**
 * Decide whether a queued climb can be lit on the connected board.
 *
 * - `unknown` — the climb carries no board metadata (older items, or party-synced
 *   items from before the metadata round-trip). Never block on this; send as today.
 * - `incompatible` — a KNOWN `boardType` or `layoutId` clearly differs from the
 *   active board. A "spill" climb (party peer on another board, or a queue left
 *   over from a board switch) — skip it instead of dark-firing the wall.
 * - `compatible` — the known metadata matches the active board.
 *
 * An unrecognised `boardType` string is treated as no board signal (we can't
 * judge it), falling through to the layout check.
 */
export function classifyClimbBoardCompatibility(
  activeConfig: ActiveBoardForCompatibility | undefined,
  climb: Pick<Climb, 'boardType' | 'layoutId'>,
): ClimbBoardCompatibility {
  if (!activeConfig) return 'unknown';
  const climbBoardName = climb.boardType ? toBoardName(climb.boardType) : undefined;
  const hasLayoutSignal = climb.layoutId != null;
  if (climbBoardName == null && !hasLayoutSignal) return 'unknown';
  if (climbBoardName != null && climbBoardName !== activeConfig.boardName) return 'incompatible';
  if (hasLayoutSignal && climb.layoutId !== activeConfig.layoutId) return 'incompatible';
  return 'compatible';
}

/**
 * Scan the queue forward from the current item for the first climb that isn't
 * `incompatible` with the active board, returning it plus how many incompatible
 * climbs were skipped to reach it (the current item counts as skipped when it is
 * itself incompatible). Returns `{ item: null }` when every remaining climb is
 * incompatible. When `activeConfig` is unknown, nothing is incompatible, so the
 * current item is returned with `skippedCount: 0`.
 */
export function findNextCompatibleQueueItem(
  queue: ReadonlyArray<ClimbQueueItem>,
  currentUuid: string | null,
  activeConfig: ActiveBoardForCompatibility | undefined,
): { item: ClimbQueueItem | null; skippedCount: number } {
  const foundIndex = currentUuid ? queue.findIndex((entry) => entry.uuid === currentUuid) : -1;
  const startIndex = foundIndex >= 0 ? foundIndex : 0;
  let skippedCount = 0;
  for (let index = startIndex; index < queue.length; index++) {
    const item = queue[index];
    if (classifyClimbBoardCompatibility(activeConfig, item.climb) === 'incompatible') {
      skippedCount++;
      continue;
    }
    return { item, skippedCount };
  }
  return { item: null, skippedCount };
}

export function decideBlePickerSelection({
  deviceId,
  devices,
  resolvedBoards,
  currentBoardConfig,
}: {
  deviceId: string;
  devices: ReadonlyArray<DiscoveredDevice>;
  resolvedBoards: ReadonlyMap<string, ResolvedBoardEntry>;
  currentBoardConfig?: BleBoardConfig;
}): PickerSelectionDecision {
  const device = devices.find((candidateDevice) => candidateDevice.deviceId === deviceId);
  const serial = device ? parseSerialNumber(device.name) : undefined;
  if (!serial) return { kind: 'forward' };

  const resolvedEntry = resolvedBoards.get(serial);
  if (!resolvedEntry) return { kind: 'forward' };

  const config = configFromResolvedEntry(resolvedEntry);
  if (!config || matchesBleBoardConfig(config, currentBoardConfig)) return { kind: 'forward' };

  return { kind: 'mismatch', serial, config, entry: resolvedEntry };
}
