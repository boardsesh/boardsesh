import { z } from 'zod';
import { ANALYTICS_CONSENT_CHOICES, CONSENT_SOURCES, CONSENT_VERSION } from '@boardsesh/consent';

/**
 * `setAnalyticsConsent` input. The unions come from `@boardsesh/consent`, the
 * same source the clients build their records from, and the database's CHECK
 * constraints repeat them as the last line of defence.
 */
export const SetAnalyticsConsentInputSchema = z.object({
  analytics: z.enum(ANALYTICS_CONSENT_CHOICES),
  // A client can only have asked under a version this server knows. Anything
  // higher is junk, and a stored future version would count as current on every
  // device until CONSENT_VERSION caught up with it. Deploy the backend first
  // when bumping CONSENT_VERSION.
  version: z.number().int().positive().max(CONSENT_VERSION),
  source: z.enum(CONSENT_SOURCES),
  basedOnDecidedAt: z
    .string()
    .max(64)
    .refine((candidate) => {
      const decidedAtMs = Date.parse(candidate);
      return Number.isFinite(decidedAtMs) && new Date(decidedAtMs).toISOString() === candidate;
    }, 'basedOnDecidedAt must be the ISO 8601 timestamp returned by the server')
    .nullish(),
  // A recovered write: compare-and-set on basedOnDecidedAt for a denial too.
  // Older clients never send it, so their denials stay unconditional.
  conditional: z.boolean().nullish(),
});

export type ValidatedSetAnalyticsConsentInput = z.infer<typeof SetAnalyticsConsentInputSchema>;
