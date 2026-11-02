import { offlineBoardKey, offlineBoardKeyForBoard, type OfflineBoardScope } from '@boardsesh/offline-sync';
import type { UserBoard } from '@boardsesh/shared-schema';
import { getSetting, setSetting } from '../settings/hooks';
import { getCredentialGeneration } from '../lib/privacy/privacy-cache';

let capabilityWrites: Promise<void> = Promise.resolve();
const scopeRemovalEpochs = new Map<string, number>();

async function readCapabilityUserId(): Promise<string | undefined> {
  const { readLocalUserId } = await import('../lib/local-user-id');
  return readLocalUserId();
}

/** Record once, preserving a climber's later choice to disable or remove it. */
export function recordOpenedSprayWall(
  userId: string,
  board: Pick<UserBoard, 'boardType' | 'uuid' | 'layoutId' | 'sizeId'>,
): boolean {
  if (board.boardType !== 'spray' || !board.uuid) return false;
  const scopeKey = offlineBoardKeyForBoard(board);
  const stored = getSetting('offlineOpenedSprayWallsV1');
  const ledger = stored?.userId === userId ? stored : { userId, walls: {} };
  if (Object.prototype.hasOwnProperty.call(ledger.walls, scopeKey)) return false;
  setSetting('offlineOpenedSprayWallsV1', { userId, walls: { ...ledger.walls, [scopeKey]: board.uuid } });
  const owned = getSetting('offlineOwnedSprayWallsV1');
  if (
    owned?.userId === userId &&
    owned.wallUuids.includes(board.uuid) &&
    !getSetting('syncEnabledBoards').includes(scopeKey)
  )
    return false;
  return !getSetting('syncEnabledBoards').includes(scopeKey);
}

/** Independently persisted from the capped recent-board cards. */
export async function resolveSprayWallCapability(scope: OfflineBoardScope): Promise<string | undefined> {
  if (scope.boardType !== 'spray') return undefined;
  const generation = getCredentialGeneration();
  await capabilityWrites;
  const userId = await readCapabilityUserId();
  const ledger = getSetting('offlineOpenedSprayWallsV1');
  if (generation !== getCredentialGeneration() || !userId || ledger?.userId !== userId) return undefined;
  return ledger.walls[offlineBoardKey(scope)] ?? undefined;
}

export function forgetSprayWallCapability(scope: OfflineBoardScope): void {
  if (scope.boardType !== 'spray') return;
  const ledger = getSetting('offlineOpenedSprayWallsV1');
  const scopeKey = offlineBoardKey(scope);
  scopeRemovalEpochs.set(scopeKey, (scopeRemovalEpochs.get(scopeKey) ?? 0) + 1);
  if (!ledger || !Object.prototype.hasOwnProperty.call(ledger.walls, scopeKey) || ledger.walls[scopeKey] === null)
    return;
  setSetting('offlineOpenedSprayWallsV1', { ...ledger, walls: { ...ledger.walls, [scopeKey]: null } });
}

/** Manual re-enable restores its verified capability without changing the seen marker. */
export function rememberSprayWallDownloadCapability(boards: readonly UserBoard[]): Promise<void> {
  if (!boards.some((board) => board.boardType === 'spray')) return Promise.resolve();
  const generation = getCredentialGeneration();
  const removalEpochs = new Map(
    boards.map((board) => {
      const scopeKey = offlineBoardKeyForBoard(board);
      return [scopeKey, scopeRemovalEpochs.get(scopeKey) ?? 0] as const;
    }),
  );
  const pendingWrite = capabilityWrites.then(() =>
    writeSprayWallDownloadCapabilities(boards, generation, removalEpochs),
  );
  capabilityWrites = pendingWrite.catch(() => undefined);
  return pendingWrite;
}

async function writeSprayWallDownloadCapabilities(
  boards: readonly UserBoard[],
  generation: number,
  removalEpochs: ReadonlyMap<string, number>,
): Promise<void> {
  const userId = await readCapabilityUserId();
  if (!userId || generation !== getCredentialGeneration()) return;
  const stored = getSetting('offlineOpenedSprayWallsV1');
  const walls = { ...(stored?.userId === userId ? stored.walls : {}) };
  let changed = false;
  for (const board of boards) {
    if (board.boardType !== 'spray' || !board.uuid) continue;
    const scopeKey = offlineBoardKeyForBoard(board);
    if ((scopeRemovalEpochs.get(scopeKey) ?? 0) !== removalEpochs.get(scopeKey)) continue;
    if (walls[scopeKey] !== board.uuid) {
      walls[scopeKey] = board.uuid;
      changed = true;
    }
  }
  if (changed && generation === getCredentialGeneration()) setSetting('offlineOpenedSprayWallsV1', { userId, walls });
}
