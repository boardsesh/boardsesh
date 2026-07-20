import type { CostEntry } from '@boardsesh/db/schema';

/**
 * Shape a cost_entries row for the GraphQL `CostEntry` type: the bigserial id
 * becomes a string, everything else passes through. Shared by the admin query
 * and the create/update mutations.
 */
export function serializeCostEntry(row: CostEntry) {
  return {
    id: String(row.id),
    kind: row.kind,
    category: row.category,
    label: row.label,
    amountCents: row.amountCents,
    currency: row.currency,
    startMonth: row.startMonth,
    endMonth: row.endMonth,
    note: row.note,
  };
}
