import { pgTable, text, integer, timestamp, bigserial, index, pgEnum } from 'drizzle-orm/pg-core';
import { users } from '../auth/users';

/**
 * Cost transparency: what it costs to run Boardsesh, kept up to date by hand
 * through the `/admin/costs` page (no provider-API auto-fetch — only Vercel of
 * our six bills is automatable, so it isn't worth the machinery). Rolled up per
 * month and published on the mobile "running costs" screen ahead of asking for
 * donations.
 */

/**
 * Whether an entry repeats every month (a subscription / hosting plan) or is a
 * one-off charge that hit a single month (a domain renewal, a one-time fee).
 * Recurring entries are *definitions*, not materialised per-month rows: the
 * monthly rollup is computed at query time from `start_month`..`end_month`, so
 * there is no cron and no expansion job. A price change is modeled by ending one
 * recurring entry and starting a new one at the new amount.
 */
export const costEntryKindEnum = pgEnum('cost_entry_kind', ['recurring', 'incidental']);

/**
 * Broad grouping for the by-category breakdown on the transparency screen.
 * Kept as a plain text column (not a pg enum) so a new bucket can be added
 * without a migration.
 */
export type CostCategory = 'hosting' | 'ai' | 'domain' | 'other';

export const costEntries = pgTable(
  'cost_entries',
  {
    id: bigserial({ mode: 'number' }).primaryKey().notNull(),
    kind: costEntryKindEnum('kind').notNull(),
    category: text('category').$type<CostCategory>().notNull(),
    // Human label shown in the admin table and (aggregated) on the public
    // screen — e.g. "Vercel", "Claude Max — <owner>", "Domain renewal".
    label: text('label').notNull(),
    // Money is stored as an integer number of cents; never a float.
    amountCents: integer('amount_cents').notNull(),
    currency: text('currency').notNull().default('USD'),
    // Month keys are 'YYYY-MM'. Fixed-width, so lexicographic string comparison
    // is a correct month-range filter. For `recurring`, `start_month` is the
    // first billed month; for `incidental`, it's the month the charge hit.
    startMonth: text('start_month').notNull(),
    // Recurring only; NULL means "still ongoing". Always NULL for incidentals.
    endMonth: text('end_month'),
    note: text('note'),
    // Admin who created the row (audit). Nulled if that user is later deleted.
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { mode: 'string' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { mode: 'string' }).defaultNow().notNull(),
  },
  (table) => ({
    startMonthIdx: index('cost_entries_start_month_idx').on(table.startMonth),
  }),
);

export type CostEntry = typeof costEntries.$inferSelect;
export type NewCostEntry = typeof costEntries.$inferInsert;
