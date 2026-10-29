import { z } from 'zod';

/**
 * `setProjectNewsEmailConsent` input. Only the three client platforms may
 * write through GraphQL; `email_link` is the unsubscribe link's own source and
 * is written server-side only. The table's CHECK constraint repeats the union.
 */
export const SetProjectNewsEmailConsentInputSchema = z.object({
  subscribed: z.boolean(),
  source: z.enum(['web', 'ios', 'android']),
});

export type ValidatedSetProjectNewsEmailConsentInput = z.infer<typeof SetProjectNewsEmailConsentInputSchema>;
