import type { BoardLayersSnapshot } from '@boardsesh/shared-schema';
import { pubsub } from '../pubsub';

/** Mark a confirmed roster stale without discarding the last observed layers. */
export async function markBoardLayersStale(
  boardId: number,
  expectedOwnerToken: string,
  seq: number,
): Promise<BoardLayersSnapshot | null> {
  const boardKey = String(boardId);
  const current = await pubsub.getBoardLayers(boardKey);
  if (current === null || current.stale) return current;

  const result = await pubsub.markBoardLayersStaleIfOwned(boardKey, expectedOwnerToken, {
    ...current,
    observedAt: new Date().toISOString(),
    stale: true,
    seq,
  });
  if (result?.changed) {
    pubsub.publishBoardPresenceEvent(boardKey, {
      __typename: 'BoardLayersChanged',
      snapshot: result.snapshot,
    });
  }
  return result?.snapshot ?? null;
}
