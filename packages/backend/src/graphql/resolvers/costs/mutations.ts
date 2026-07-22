import type { ConnectionContext } from '@boardsesh/shared-schema';
import { eq, sql } from 'drizzle-orm';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import type { CostCategory } from '@boardsesh/db/schema';
import { requireAdmin } from '../social/roles';
import { applyRateLimit, validateInput } from '../shared/helpers';
import {
  CreateCostEntryInputSchema,
  UpdateCostEntryInputSchema,
  DeleteCostEntryInputSchema,
} from '../../../validation/schemas';
import { serializeCostEntry } from './serialize';

type ValidatedCostEntry = {
  kind: 'recurring' | 'incidental';
  category: CostCategory;
  label: string;
  amountCents: number;
  currency?: string | null;
  startMonth: string;
  endMonth?: string | null;
  note?: string | null;
};

// Normalize a validated input into column values. endMonth is forced null for
// incidentals (they don't span months); currency defaults to USD, uppercased.
function toColumnValues(input: ValidatedCostEntry) {
  return {
    kind: input.kind,
    category: input.category,
    label: input.label.trim(),
    amountCents: input.amountCents,
    currency: (input.currency ?? 'USD').toUpperCase(),
    startMonth: input.startMonth,
    endMonth: input.kind === 'recurring' ? (input.endMonth ?? null) : null,
    note: input.note?.trim() ? input.note.trim() : null,
  };
}

export const costMutations = {
  createCostEntry: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext) => {
    await requireAdmin(ctx);
    await applyRateLimit(ctx, 30, 'createCostEntry');

    const validated = validateInput(CreateCostEntryInputSchema, input, 'input');
    const [row] = await db
      .insert(dbSchema.costEntries)
      .values({ ...toColumnValues(validated), createdBy: ctx.userId ?? null })
      .returning();
    return serializeCostEntry(row);
  },

  updateCostEntry: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext) => {
    await requireAdmin(ctx);
    await applyRateLimit(ctx, 30, 'updateCostEntry');

    const validated = validateInput(UpdateCostEntryInputSchema, input, 'input');
    const [row] = await db
      .update(dbSchema.costEntries)
      // DB clock (matches defaultNow() on create) rather than the app clock.
      .set({ ...toColumnValues(validated), updatedAt: sql`now()` })
      .where(eq(dbSchema.costEntries.id, Number(validated.id)))
      .returning();

    if (!row) {
      throw new Error('Cost entry not found');
    }
    return serializeCostEntry(row);
  },

  deleteCostEntry: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext) => {
    await requireAdmin(ctx);
    await applyRateLimit(ctx, 30, 'deleteCostEntry');

    const validated = validateInput(DeleteCostEntryInputSchema, input, 'input');
    const deleted = await db
      .delete(dbSchema.costEntries)
      .where(eq(dbSchema.costEntries.id, Number(validated.id)))
      .returning({ id: dbSchema.costEntries.id });
    return deleted.length > 0;
  },
};
