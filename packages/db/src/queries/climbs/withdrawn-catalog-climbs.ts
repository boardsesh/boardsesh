import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { HIDDEN_WITHDRAWN_CLIMB_BOARD_NAMES } from '@boardsesh/board-config';
import { QUANTUM_RELEASED_LAYOUT_IDS } from '@boardsesh/board-constants/quantum';
import { supplierCatalogClimbCondition } from './quantum-catalog-ownership';

// The board list is read inside each function, never at module load, so a test
// that mocks @boardsesh/board-config without it can still import this module.

/**
 * `<boardType> IN ('a', 'b')`. The names go in as literals, as the per-board
 * `= 'quantum'` they replace did, so the planner sees constants. They come from
 * the closed SUPPORTED_BOARDS list, never from input. With no board left the
 * condition is `false`: Postgres has no empty IN list.
 */
function boardTypeInCondition(boardType: SQLWrapper, boardNames: readonly string[]): SQL {
  if (boardNames.length === 0) return sql`false`;
  return sql`${boardType} IN (${sql.raw(boardNames.map((boardName) => `'${boardName}'`).join(', '))})`;
}

/** `board_type` names a board whose withdrawn catalogue climbs are hidden from every read. */
export function hidesWithdrawnClimbsBoardCondition(boardType: SQLWrapper): SQL {
  return boardTypeInCondition(boardType, HIDDEN_WITHDRAWN_CLIMB_BOARD_NAMES);
}

/**
 * `board_type` names a board where {@link unavailableCatalogClimbCondition} can
 * hold: one that hides withdrawn climbs, or Quantum, whose models are released
 * one at a time. That release rule stays Quantum's own.
 */
export function unavailableCatalogClimbBoardCondition(boardType: SQLWrapper): SQL {
  return boardTypeInCondition(boardType, [...new Set<string>(['quantum', ...HIDDEN_WITHDRAWN_CLIMB_BOARD_NAMES])]);
}

/**
 * A catalogue climb its supplier withdrew, on a board whose capability hides such
 * climbs (`withdrawnCatalogClimbs: 'hidden'` in @boardsesh/board-config): a supplier
 * row that is no longer listed. Never NULL for a `board_climbs` row; on the null
 * side of an outer join it is false.
 *
 * Boards that keep withdrawn climbs readable by uuid (MoonBoard, Kilter) never
 * match, even though their importers also unlist the row.
 */
export function withdrawnCatalogClimbCondition(prefix: SQL = sql`board_climbs.`): SQL {
  return sql`(${prefix}is_listed IS NOT TRUE AND ${supplierCatalogClimbCondition(
    hidesWithdrawnClimbsBoardCondition(sql`${prefix}board_type`),
    {
      userId: sql`${prefix}user_id`,
      isBoardseshAuthored: sql`${prefix}is_boardsesh_authored`,
      controllerRouteUuid: sql`${prefix}controller_route_uuid`,
    },
  )})`;
}

/** A Quantum climb on a model that is not released yet. */
function unreleasedQuantumModelCondition(prefix: SQL): SQL {
  return sql`(${prefix}board_type IS NOT DISTINCT FROM 'quantum' AND ${prefix}layout_id NOT IN ${QUANTUM_RELEASED_LAYOUT_IDS})`;
}

/**
 * Rows that must not hydrate through a saved or public climb reference: a
 * withdrawn catalogue climb on a board that hides them, or a climb on an
 * unreleased Quantum model.
 */
export function unavailableCatalogClimbCondition(prefix: SQL = sql`board_climbs.`): SQL {
  return sql`(${unreleasedQuantumModelCondition(prefix)} OR ${withdrawnCatalogClimbCondition(prefix)})`;
}
