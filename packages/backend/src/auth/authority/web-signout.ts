import { eq, sql } from 'drizzle-orm';
import { authSessionDenials, users } from '@boardsesh/db/schema/auth';
import type { AuthorityDatabase } from './adapter';
import { verifyLegacyNextAuthJwe } from '../legacy-web-credentials';
import { AuthSubjectDeniedError, requireHumanSubjectForIssuance } from '../human-admission';
import { decideCredential } from '../credential-cutoffs';
import { transactionSettings } from '../current-store/command-context';
import { denyFirstPartySessionInTransaction } from './lineage';
import {
  captureExpectedAuthority,
  lockEnforcedProjection,
  type ExpectedCurrentStoreAuthority,
} from '../current-store/foundation-context';

export type WebSignOutResult = { status: 'signed-out' | 'denied' | 'unavailable' };

/** Private transport validates CSRF and the tab's expected login before calling. */
export async function signOutLegacyWebSession(
  database: AuthorityDatabase,
  credential: string,
  secret: string,
  now = new Date(),
  resolveAuthority?: () => ExpectedCurrentStoreAuthority,
): Promise<WebSignOutResult> {
  const proof = await verifyLegacyNextAuthJwe(credential, secret, now);
  if (!proof) return { status: 'denied' };
  const authority =
    proof.requiresAccountCutoff && resolveAuthority ? captureExpectedAuthority(resolveAuthority()) : undefined;
  if (proof.requiresAccountCutoff && !authority) return { status: 'unavailable' };
  const authSessionId = proof.authSessionId ?? proof.lineageId;
  try {
    return await database.transaction(async (transaction) => {
      await transactionSettings(transaction);
      await transaction.execute(sql`SELECT pg_advisory_xact_lock_shared(6975, 2)`);
      // Unknown ancestry needs a generation write. Lock its selected authority
      // before the user, in the same order as every other security writer.
      if (proof.requiresAccountCutoff) await lockEnforcedProjection(transaction, authority!);
      const [subject] = await transaction
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, proof.userId))
        .for('update');
      if (!subject) return { status: 'denied' as const };
      const state = await requireHumanSubjectForIssuance(transaction, proof.userId);
      // This old generation is already revoked. A delayed sibling logout must
      // neither advance the cutoff again nor end a genuinely later login.
      if (proof.requiresAccountCutoff && proof.generation < state.generation) return { status: 'signed-out' as const };
      const [denial] = await transaction
        .select()
        .from(authSessionDenials)
        .where(eq(authSessionDenials.sessionId, authSessionId));
      if (denial) return { status: denial.userId === proof.userId ? ('signed-out' as const) : ('denied' as const) };
      if (
        decideCredential(
          {
            kind: 'web-session',
            generationClaim: proof.generation,
            sessionKeyClaim: authSessionId,
            authTimeClaim: null,
          },
          state,
          now.getTime(),
        ).denial !== null
      )
        return { status: 'denied' as const };
      await denyFirstPartySessionInTransaction(
        transaction,
        {
          userId: proof.userId,
          authSessionId,
          generation: proof.generation,
          requiresAccountCutoff: proof.requiresAccountCutoff,
          authenticatedAt: proof.linkGuarded ? proof.originalAuthenticatedAt : null,
          linkGuarded: proof.linkGuarded,
          expiresAt: proof.expiresAt,
        },
        now,
        authority,
      );
      return { status: 'signed-out' as const };
    });
  } catch (error) {
    return { status: error instanceof AuthSubjectDeniedError ? 'denied' : 'unavailable' };
  }
}
