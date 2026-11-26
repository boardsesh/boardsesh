import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { QUANTUM_RELEASED_LAYOUT_IDS } from '@boardsesh/board-constants/quantum';
import { boardClimbs } from '../../schema';

/** Deleted accounts leave public authored climbs ownerless; they remain app-owned. */
export function quantumCatalogClimbCondition(
  climb: {
    boardType: SQLWrapper;
    userId: SQLWrapper;
    isBoardseshAuthored: SQLWrapper;
    controllerRouteUuid: SQLWrapper;
  } = boardClimbs,
): SQL {
  return sql`(${climb.boardType} = 'quantum' AND ${climb.userId} IS NULL
    AND ${climb.isBoardseshAuthored} IS FALSE AND ${climb.controllerRouteUuid} IS NOT NULL)`;
}

export function retiredQuantumCatalogClimbCondition(prefix: SQL = sql`board_climbs.`): SQL {
  return sql`(${prefix}is_listed IS NOT TRUE AND ${quantumCatalogClimbCondition({
    boardType: sql`${prefix}board_type`,
    userId: sql`${prefix}user_id`,
    isBoardseshAuthored: sql`${prefix}is_boardsesh_authored`,
    controllerRouteUuid: sql`${prefix}controller_route_uuid`,
  })})`;
}

/** Rows that must not hydrate through a saved or public climb reference. */
export function unavailableQuantumClimbCondition(prefix: SQL = sql`board_climbs.`): SQL {
  return sql`(${prefix}board_type IS NOT DISTINCT FROM 'quantum' AND (
    ${prefix}layout_id NOT IN ${QUANTUM_RELEASED_LAYOUT_IDS} OR ${retiredQuantumCatalogClimbCondition(prefix)}
  ))`;
}
