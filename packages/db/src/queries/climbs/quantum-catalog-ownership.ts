import { and, eq, isNotNull, isNull, type SQL } from 'drizzle-orm';
import { boardClimbs } from '../../schema';

/** Deleted accounts leave public authored climbs ownerless; they remain app-owned. */
export function quantumCatalogClimbCondition(): SQL {
  return and(
    eq(boardClimbs.boardType, 'quantum'),
    isNull(boardClimbs.userId),
    eq(boardClimbs.isBoardseshAuthored, false),
    isNotNull(boardClimbs.controllerRouteUuid),
  )!;
}
