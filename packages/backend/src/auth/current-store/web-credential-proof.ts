import { randomUUID } from 'node:crypto';
import { authSubjectCutoffs } from '@boardsesh/db/schema/auth';
import { eq, sql } from 'drizzle-orm';
import { executeFirstRow } from '@boardsesh/db/client';
import {
  WEB_CREDENTIAL_PROOF_VERSION,
  webCredentialProofMode,
  type WebCredentialProof,
} from '@boardsesh/auth-protocol';
import type { CurrentStoreTransaction } from './foundation-context';

/** Caller already holds the gate and subject lock. Never read generation after the reply. */
export async function issueWebCredentialProof(
  transaction: CurrentStoreTransaction,
  userId: string,
  requestedVersion: 1 | undefined,
  provedGeneration?: number,
): Promise<WebCredentialProof | undefined> {
  const mode = webCredentialProofMode(process.env);
  if (requestedVersion === undefined) {
    if (mode === 'required') throw new Error('Versioned web credential proof required');
    return undefined;
  }
  if (mode === 'off') throw new Error('Web credential proofs are disabled');
  const [cutoff] = await transaction.select().from(authSubjectCutoffs).where(eq(authSubjectCutoffs.userId, userId));
  if (cutoff?.deletedAt || (provedGeneration !== undefined && (cutoff?.generation ?? 0) !== provedGeneration))
    throw new Error('Web credential proof is stale');
  const clock = await executeFirstRow<{ authenticated_at: Date }>(
    transaction,
    sql`SELECT clock_timestamp() AS authenticated_at`,
  );
  if (!clock?.authenticated_at) throw new Error('Web credential proof clock unavailable');
  return {
    version: WEB_CREDENTIAL_PROOF_VERSION,
    userId,
    authSessionId: randomUUID(),
    generation: provedGeneration ?? cutoff?.generation ?? 0,
    authenticatedAt: new Date(clock.authenticated_at).toISOString(),
    linkGuarded: true,
  };
}
