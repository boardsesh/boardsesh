import type { ClimbFilters } from './climb-filter-types';

export const CURRENT_FILTER_SCHEMA_VERSION = 2;

export function normalizePersistedClimbFilters(
  filters: ClimbFilters,
  filterSchemaVersion: number | undefined,
): ClimbFilters {
  if (filterSchemaVersion === CURRENT_FILTER_SCHEMA_VERSION) return filters;

  if (
    (filters.boulders === true && filters.routes === false) ||
    (filters.boulders === true && filters.routes === true) ||
    (filters.boulders === false && filters.routes === false)
  ) {
    const normalized = { ...filters };
    delete normalized.boulders;
    delete normalized.routes;
    return normalized;
  }

  return filters;
}
