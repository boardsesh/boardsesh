import type { ConnectionContext, RecordConsentRejectionInput } from '@boardsesh/shared-schema';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { logger } from '../../../utils/logger';
import { applyRateLimit, validateInput } from '../shared/helpers';
import { RecordConsentRejectionInputSchema } from '../../../validation/schemas';

/**
 * Per-IP cap for the anonymous rejection-event endpoint. Set deliberately
 * loose — a normal session at most flips consent a handful of times, so a
 * limit of 30/min still leaves enormous headroom for legitimate UI flows
 * while preventing a single source from filling `consent_rejection_events`.
 */
const RECORD_CONSENT_REJECTION_RATE_LIMIT_PER_MIN = 30;

export const consentEventsMutations = {
  /**
   * Record an anonymous consent-rejection event.
   *
   * Intentionally NOT authenticated — the whole point is to track whether
   * the consent flow is doing its job, and the user may have just denied
   * everything (including any future identity claim).
   *
   * No PII is stored: not the userId, not the IP, not the user agent.
   * Best-effort: swallows DB failures so a flaky write never blocks the
   * consent UI on the client.
   *
   * Coarse IP-based rate limit prevents a hostile client from filling the
   * `consent_rejection_events` table. Rate limit is keyed off `ctx.clientIp`
   * for anonymous requests (see applyRateLimit logic) and falls back to
   * connectionId when neither IP nor userId is available.
   */
  recordConsentRejection: async (
    _: unknown,
    { input }: { input: RecordConsentRejectionInput },
    ctx: ConnectionContext,
  ): Promise<boolean> => {
    await applyRateLimit(ctx, RECORD_CONSENT_REJECTION_RATE_LIMIT_PER_MIN, 'recordConsentRejection');
    const parsed = validateInput(RecordConsentRejectionInputSchema, input, 'input');

    try {
      await db.insert(dbSchema.consentRejectionEvents).values({
        source: parsed.source,
      });
      return true;
    } catch (error) {
      logger.warn('[consent-events] failed to record rejection:', error);
      return false;
    }
  },
};
