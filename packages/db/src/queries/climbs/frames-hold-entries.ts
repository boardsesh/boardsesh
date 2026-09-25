import { woodsSizeIdToDimension } from '@boardsesh/board-config';
import { convertLitUpHoldsStringToMap, isSentinelHoldState } from '@boardsesh/board-constants/hold-states';
import type { BoardName } from '@boardsesh/board-constants';

export type NormalizedHold = {
  holdId: number;
  holdState: string;
};

export type NormalizedHoldRow = NormalizedHold & {
  frameNumber: number;
};

/**
 * Parse the Aurora-style frame string ("p<id>r<role>p<id>r<role>...,p<id>r<role>...")
 * into a flat list of holds with their state name. Multi-frame strings (comma
 * separated) are flattened with the frame index preserved.
 *
 * Returns only holds whose state code resolves to a named state (STARTING /
 * HAND / FINISH / FOOT) — unknown codes (the synthetic "1=42" sentinel) are
 * dropped so they can't poison signatures.
 *
 * Lives in `@boardsesh/db` so the backend's similarity resolver and the nightly
 * neighbour job (`scripts/refresh-climb-neighbors.ts`) read a climb's holds the
 * same way; the backend re-exports it from `climb-similarity.ts`.
 */
export function parseFramesToHoldEntries(boardType: BoardName, frames: string | null | undefined): NormalizedHoldRow[] {
  if (!frames) return [];
  const frameMap = convertLitUpHoldsStringToMap(frames, boardType);
  const rows: NormalizedHoldRow[] = [];
  for (const [frameIndexKey, holdsMap] of Object.entries(frameMap)) {
    const frameNumber = Number(frameIndexKey);
    for (const [holdIdKey, hold] of Object.entries(holdsMap)) {
      if (isSentinelHoldState(hold.state)) continue;
      const holdId = Number(holdIdKey);
      if (!Number.isFinite(holdId)) continue;
      rows.push({ frameNumber, holdId, holdState: hold.state });
    }
  }
  return rows;
}

/**
 * The distinct hold positions of a climb, ascending. Roles are ignored: this is
 * the set the position-only Jaccard in `findSimilarClimbs` compares.
 */
export function distinctHoldIds(boardType: BoardName, frames: string | null | undefined): number[] {
  const ids = new Set(parseFramesToHoldEntries(boardType, frames).map(({ holdId }) => holdId));
  return Array.from(ids).sort((left, right) => left - right);
}

/**
 * The stored Woods size for an existing climb, read back from the denormalised
 * `compatible_size_ids` the create path writes. Returns null for a row that
 * predates it (or an imported row the catalog repair hasn't reached), which the
 * caller treats as "size unknown" rather than guessing a wall.
 */
export function storedWoodsSizeId(compatibleSizeIds: number[] | null | undefined): number | null {
  const sizeId = compatibleSizeIds?.find((candidate) => woodsSizeIdToDimension(candidate) !== undefined);
  return sizeId ?? null;
}
