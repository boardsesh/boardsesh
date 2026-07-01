import type { RawProjectingStats } from '@boardsesh/profile-stats';

/**
 * The biggest-fight glance tile, or its fallback. When the climber has a
 * hardest-won send of ≥4 tries (`projecting.unlocked`), the tile celebrates that
 * project; otherwise it falls back to total sends so the 2×2 grid always stays
 * full. The gate and pick are computed send-only upstream in `buildProjectingStats`.
 */
export type BiggestFightTile = { kind: 'fight'; tries: number; grade: string } | { kind: 'sends'; total: number };

export function resolveBiggestFightTile(projecting: RawProjectingStats, totalAscents: number): BiggestFightTile {
  if (projecting.unlocked && projecting.biggestProject) {
    return { kind: 'fight', tries: projecting.biggestProject.tries, grade: projecting.biggestProject.label };
  }
  return { kind: 'sends', total: totalAscents };
}

export type DeltaKind = 'up' | 'down' | 'same';

/** Classify an active-days month-over-month delta for the tile's delta chip. */
export function deltaKind(delta: number): DeltaKind {
  if (delta > 0) return 'up';
  if (delta < 0) return 'down';
  return 'same';
}
