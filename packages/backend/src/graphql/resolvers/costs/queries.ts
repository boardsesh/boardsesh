import type { ConnectionContext } from '@boardsesh/shared-schema';
import { desc } from 'drizzle-orm';
import { db, dbRead } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { requireAdmin } from '../social/roles';
import { applyRateLimit } from '../shared/helpers';
import { serializeCostEntry } from './serialize';
import { buildRunningCostsReport, currentMonthKey } from './rollup';

const DEFAULT_WINDOW_MONTHS = 12;
const MAX_WINDOW_MONTHS = 60;

export const costQueries = {
  // Admin-only: every cost line item, for the /admin/costs editor table.
  costEntries: async (_: unknown, __: unknown, ctx: ConnectionContext) => {
    await requireAdmin(ctx);
    const rows = await db
      .select()
      .from(dbSchema.costEntries)
      .orderBy(desc(dbSchema.costEntries.startMonth), desc(dbSchema.costEntries.id));
    return rows.map(serializeCostEntry);
  },

  // Public (no auth): rolled-up monthly totals for the transparency screen.
  // Recurring entries are definitions, so we read the whole (small) table and
  // compute the window in-process — a recurring entry that started years ago is
  // still active this month.
  runningCosts: async (_: unknown, { months }: { months?: number | null }, ctx: ConnectionContext) => {
    await applyRateLimit(ctx, 60, 'runningCosts');
    const windowMonths = Math.min(Math.max(Math.trunc(months ?? DEFAULT_WINDOW_MONTHS), 1), MAX_WINDOW_MONTHS);
    const rows = await dbRead.select().from(dbSchema.costEntries);
    return buildRunningCostsReport(rows, windowMonths, currentMonthKey());
  },
};
