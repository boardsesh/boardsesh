/**
 * Tiny helper that fires the anonymous "consent rejected" event to the
 * backend. Best-effort — never throws and never blocks the consent UI.
 *
 * The mutation is unauthenticated (the user may have just denied everything,
 * including any future identity claim), and the server stores no PII.
 */

import { executeGraphQL } from './graphql/client';
import {
  RECORD_CONSENT_REJECTION,
  type RecordConsentRejectionMutationResponse,
  type RecordConsentRejectionMutationVariables,
} from './graphql/operations/consent-events';

export type ConsentRejectionSource = 'banner' | 'dialog' | 'settings';

export async function recordConsentRejection(source: ConsentRejectionSource): Promise<void> {
  if (typeof window === 'undefined') return;
  try {
    await executeGraphQL<RecordConsentRejectionMutationResponse, RecordConsentRejectionMutationVariables>(
      RECORD_CONSENT_REJECTION,
      { input: { source } },
    );
  } catch (error) {
    // Swallow — the consent UI must never fail because of a telemetry write.
    console.warn('[consent-events] failed to record rejection:', error);
  }
}
