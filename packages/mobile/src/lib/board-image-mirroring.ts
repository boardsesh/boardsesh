import type { BoardName } from '@boardsesh/shared-schema';

/** Quantum has no reflected hold/LED map, including for stale queue metadata. */
export function getBoardImageMirrored(
  boardName: BoardName,
  requestedMirrored: boolean | undefined,
): boolean | undefined {
  return boardName === 'quantum' ? false : requestedMirrored;
}
