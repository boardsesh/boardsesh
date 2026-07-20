import { z } from 'zod';

const COST_KINDS = ['recurring', 'incidental'] as const;
const COST_CATEGORIES = ['hosting', 'ai', 'domain', 'other'] as const;

// 'YYYY-MM' with a valid month component. Fixed-width so string comparison is a
// correct month ordering.
const monthKey = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "month must be 'YYYY-MM'");

// GraphQL ID of a cost_entries row (bigserial serialized as a numeric string).
const costEntryId = z.string().regex(/^\d+$/, 'id must be a numeric cost entry id').max(20);

// Shared field shape for create + update. amountCents is capped at $1,000,000
// (100,000,000 cents) as a sanity bound.
const costEntryFields = {
  kind: z.enum(COST_KINDS),
  category: z.enum(COST_CATEGORIES),
  label: z.string().trim().min(1).max(120),
  amountCents: z.number().int().min(0).max(100_000_000),
  currency: z.string().trim().length(3).optional().nullable(),
  startMonth: monthKey,
  endMonth: monthKey.optional().nullable(),
  note: z.string().trim().max(500).optional().nullable(),
};

// endMonth only makes sense for recurring entries, and must not precede the
// start. Declared as predicates over the minimal shape they read so they apply
// cleanly to both the create and update object schemas.
const endMonthOnlyForRecurring = {
  check: (data: { kind: string; endMonth?: string | null }) => data.kind === 'recurring' || data.endMonth == null,
  options: { message: 'incidental entries cannot have an endMonth', path: ['endMonth'] },
};
const endMonthNotBeforeStart = {
  check: (data: { startMonth: string; endMonth?: string | null }) =>
    data.endMonth == null || data.endMonth >= data.startMonth,
  options: { message: 'endMonth must be on or after startMonth', path: ['endMonth'] },
};

export const CreateCostEntryInputSchema = z
  .object(costEntryFields)
  .strict()
  .refine(endMonthOnlyForRecurring.check, endMonthOnlyForRecurring.options)
  .refine(endMonthNotBeforeStart.check, endMonthNotBeforeStart.options);

export const UpdateCostEntryInputSchema = z
  .object({ id: costEntryId, ...costEntryFields })
  .strict()
  .refine(endMonthOnlyForRecurring.check, endMonthOnlyForRecurring.options)
  .refine(endMonthNotBeforeStart.check, endMonthNotBeforeStart.options);

export const DeleteCostEntryInputSchema = z.object({ id: costEntryId }).strict();

export type CreateCostEntryInput = z.infer<typeof CreateCostEntryInputSchema>;
export type UpdateCostEntryInput = z.infer<typeof UpdateCostEntryInputSchema>;
export type DeleteCostEntryInput = z.infer<typeof DeleteCostEntryInputSchema>;
