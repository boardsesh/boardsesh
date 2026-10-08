import type { UserBoard } from '@boardsesh/shared-schema';
import { sanitizeActiveBoard } from './active-board-snapshot';
import { getPreference, removePreference, setPreference } from './preference-store';
import { getPrivacyRevocationGeneration, subscribeToPrivacyRevocations } from './privacy/privacy-cache';

export { sanitizeActiveBoard } from './active-board-snapshot';

const authorizedSnapshots = new Map<string, { generation: number; board: UserBoard }>();
const projectionGenerations = new WeakMap<UserBoard, number>();
subscribeToPrivacyRevocations(() => authorizedSnapshots.clear());

/** A copied projection is usable only in the privacy scope that authorized it. */
export function currentActiveBoardProjection(board: UserBoard): UserBoard {
  return projectionGenerations.get(board) === getPrivacyRevocationGeneration() ? board : sanitizeActiveBoard(board);
}

export function authorizeActiveBoardProjection(board: UserBoard): UserBoard {
  projectionGenerations.set(board, getPrivacyRevocationGeneration());
  return board;
}

export async function readActiveBoardSnapshot(storageKey: string): Promise<UserBoard | null> {
  const stored = await getPreference<UserBoard>(storageKey);
  if (!stored) return null;
  const snapshot = authorizedSnapshots.get(storageKey);
  // Legacy files also pass through the sanitizer. Relaunching cannot restore
  // withdrawn metadata from a file written by an older app.
  return snapshot?.generation === getPrivacyRevocationGeneration() && snapshot.board.uuid === stored.uuid
    ? snapshot.board
    : sanitizeActiveBoard(stored);
}

export async function writeActiveBoardSnapshot(storageKey: string, board: UserBoard): Promise<void> {
  const generation = getPrivacyRevocationGeneration();
  await setPreference(storageKey, sanitizeActiveBoard(board));
  if (generation !== getPrivacyRevocationGeneration()) return;
  authorizedSnapshots.set(storageKey, { generation, board: authorizeActiveBoardProjection(board) });
}

export async function clearActiveBoardSnapshot(storageKey: string): Promise<void> {
  authorizedSnapshots.delete(storageKey);
  await removePreference(storageKey);
}
