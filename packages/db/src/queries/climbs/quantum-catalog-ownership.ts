import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { boardClimbs } from '../../schema';

type SupplierCatalogColumns = {
  userId: SQLWrapper;
  isBoardseshAuthored: SQLWrapper;
  controllerRouteUuid: SQLWrapper;
};

/**
 * A row a catalogue supplier owns: no Boardsesh owner, not authored in the app,
 * and carrying the supplier's route id. Deleted accounts leave public authored
 * climbs ownerless; `is_boardsesh_authored` keeps them app-owned.
 */
export function supplierCatalogClimbCondition(boardTypeCondition: SQL, climb: SupplierCatalogColumns): SQL {
  return sql`(${boardTypeCondition} AND ${climb.userId} IS NULL
    AND ${climb.isBoardseshAuthored} IS FALSE AND ${climb.controllerRouteUuid} IS NOT NULL)`;
}

/** The Quantum supplier's catalogue rows, for the Quantum importer and layer paths. */
export function quantumCatalogClimbCondition(
  climb: SupplierCatalogColumns & { boardType: SQLWrapper } = boardClimbs,
): SQL {
  return supplierCatalogClimbCondition(sql`${climb.boardType} = 'quantum'`, climb);
}
