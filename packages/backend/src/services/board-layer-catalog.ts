import { and, arrayContains, sql, type SQL } from 'drizzle-orm';
import { boardClimbs } from '@boardsesh/db/schema';
import { quantumCatalogClimbCondition } from '@boardsesh/db/queries';

/**
 * A public climb identity alone cannot prove the geometry physically lit by
 * another device. Each catalog adapter must supply an immutable binding before
 * its persisted frames can become shared occupancy; unregistered boards fail closed.
 */
export function boardLayerCatalogFrames(boardType: string, sizeId: number): SQL<string | null> {
  if (boardType === 'quantum') {
    // App routes keep their controller UUID through edits. Only pinned source
    // geometry that fits this exact wall size can describe what a different phone lit.
    return sql<
      string | null
    >`CASE WHEN ${and(quantumCatalogClimbCondition(), arrayContains(boardClimbs.compatibleSizeIds, [sizeId]))} THEN ${boardClimbs.frames} ELSE NULL END`;
  }
  return sql<string | null>`NULL`;
}
