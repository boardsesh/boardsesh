import { z } from 'zod';

/**
 * Allowed source surfaces for a consent-rejection event.
 * Kept as an explicit enum so an arbitrary client can't pollute the
 * column with free-form strings, while still leaving room to add new
 * surfaces without a DB migration (`source` is stored as `text`).
 */
export const RecordConsentRejectionInputSchema = z.object({
  source: z.enum(['banner', 'dialog', 'settings']),
});

export type RecordConsentRejectionInputParsed = z.infer<typeof RecordConsentRejectionInputSchema>;
