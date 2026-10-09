import { z } from 'zod';
import { ANALYTICS_CONSENT_CHOICES, CONSENT_SOURCES } from '@boardsesh/consent';

/**
 * `setAnalyticsConsent` input. The unions come from `@boardsesh/consent`, the
 * same source the clients build their records from, and the database's CHECK
 * constraints repeat them as the last line of defence.
 */
export const SetAnalyticsConsentInputSchema = z.object({
  analytics: z.enum(ANALYTICS_CONSENT_CHOICES),
  // Bounded so a junk number can't be stored as a "version" forever; real
  // versions are single digits.
  version: z.number().int().positive().max(1_000),
  source: z.enum(CONSENT_SOURCES),
  basedOnDecidedAt: z
    .string()
    .max(64)
    .refine((candidate) => {
      const decidedAtMs = Date.parse(candidate);
      return Number.isFinite(decidedAtMs) && new Date(decidedAtMs).toISOString() === candidate;
    }, 'basedOnDecidedAt must be the ISO 8601 timestamp returned by the server')
    .nullish(),
});

export type ValidatedSetAnalyticsConsentInput = z.infer<typeof SetAnalyticsConsentInputSchema>;
