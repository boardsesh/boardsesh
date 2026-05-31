import { z } from 'zod';

/**
 * Composite sync cursor input. Both components are optional (null on the first
 * pull). `updatedAt` is an ISO-8601 string; `syncSeq` is a stringified bigint.
 * They are passed straight into a parameterized row-value comparison, so we only
 * need light shape validation here.
 */
export const SyncCursorInputSchema = z
  .object({
    updatedAt: z.string().optional().nullable(),
    syncSeq: z.string().optional().nullable(),
  })
  .optional()
  .nullable();

/**
 * Page-size bound shared by every sync resolver. Matches the SDL default of 500
 * and caps the per-request row count so a client can't ask for an unbounded scan.
 */
export const SyncLimitSchema = z.number().int().min(1).max(500);

export type SyncCursorInputValidated = z.infer<typeof SyncCursorInputSchema>;
