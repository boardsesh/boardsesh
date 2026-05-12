import type { ConnectionContext, RecordConsentRejectionInput } from '@boardsesh/shared-schema';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { validateInput } from '../shared/helpers';
import { RecordConsentRejectionInputSchema } from '../../../validation/schemas';

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
   */
  recordConsentRejection: async (
    _: unknown,
    { input }: { input: RecordConsentRejectionInput },
    _ctx: ConnectionContext,
  ): Promise<boolean> => {
    const parsed = validateInput(RecordConsentRejectionInputSchema, input, 'input');

    try {
      await db.insert(dbSchema.consentRejectionEvents).values({
        source: parsed.source,
      });
      return true;
    } catch (error) {
      console.warn('[consent-events] failed to record rejection:', error);
      return false;
    }
  },
};
