import { randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  authCredentialLineage,
  authSession,
  authSessionDenials,
  authSubjectCutoffs,
  authSecurityMutationEvents,
  mobileRefreshTokens,
  users,
} from '@boardsesh/db/schema/auth';
import type { AuthorityDatabase } from './adapter';
import {
  requireReadCommitted,
  lockEnforcedProjection,
  CurrentStoreFoundationError,
  type ExpectedCurrentStoreAuthority,
  captureExpectedAuthority,
} from '../current-store/foundation-context';
import type { FirstPartySession } from './session-reader';

// Include the installed JWE acceptance tolerance in the retention bound. A
// renewed legacy cookie may outlive the canonical session's original expiry.
const LEGACY_WEB_MAX_LIFETIME_MS = (30 * 24 * 60 * 60 + 60) * 1000;

/** Stable logins end alone; an unidentifiable legacy login needs an account cutoff. */
export async function denyFirstPartySession(
  database: AuthorityDatabase,
  presentedSession: FirstPartySession,
  requestedNow = new Date(),
  requestedAuthority?: ExpectedCurrentStoreAuthority,
): Promise<void> {
  // Capture the admitted proof before transaction acquisition can yield. Callers
  // may reuse their objects; later mutations must never become a newer proof.
  const session: FirstPartySession = {
    userId: presentedSession.userId,
    authSessionId: presentedSession.authSessionId,
    generation: presentedSession.generation,
    requiresAccountCutoff: presentedSession.requiresAccountCutoff,
    authenticatedAt: presentedSession.authenticatedAt ? new Date(presentedSession.authenticatedAt.getTime()) : null,
    expiresAt: new Date(presentedSession.expiresAt.getTime()),
  };
  const now = new Date(requestedNow.getTime());
  const expectedAuthority = requestedAuthority ? captureExpectedAuthority(requestedAuthority) : undefined;
  await database.transaction(async (transaction) => {
    await requireReadCommitted(transaction);
    await transaction.execute(sql`SELECT pg_advisory_xact_lock_shared(6975, 2)`);
    // A fallback cutoff is a fenced security write, never an ordinary read or bridge.
    let manifest: Awaited<ReturnType<typeof lockEnforcedProjection>> | undefined;
    if (session.requiresAccountCutoff) {
      if (!expectedAuthority) throw new CurrentStoreFoundationError('AUTHORITY_NOT_ENFORCED');
      manifest = await lockEnforcedProjection(transaction, expectedAuthority);
    }
    const [subject] = await transaction
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, session.userId))
      .for('update');
    if (session.requiresAccountCutoff) {
      if (!subject || !manifest) throw new CurrentStoreFoundationError('SUBJECT_DELETED');
      if (!Number.isSafeInteger(session.generation) || session.generation < 0)
        throw new CurrentStoreFoundationError('INVALID_COMMAND');
      const [existingCutoff] = await transaction
        .select()
        .from(authSubjectCutoffs)
        .where(eq(authSubjectCutoffs.userId, session.userId))
        .for('update');
      if (existingCutoff?.deletedAt) throw new CurrentStoreFoundationError('SUBJECT_DELETED');
      if ((existingCutoff?.generation ?? 0) !== session.generation) return;
      const operationId = randomUUID();
      await transaction
        .insert(authSubjectCutoffs)
        .values({
          userId: session.userId,
          generation: 0,
          revokedThrough: now,
          lastOperationId: operationId,
        })
        .onConflictDoNothing();
      const [previous] = await transaction
        .select()
        .from(authSubjectCutoffs)
        .where(eq(authSubjectCutoffs.userId, session.userId))
        .for('update');
      if (!previous || previous.deletedAt) throw new CurrentStoreFoundationError('SUBJECT_DELETED');
      // Repeated or delayed logout cannot end a login created after this cutoff.
      if (previous.generation !== session.generation) return;
      const [cutoff] = await transaction
        .update(authSubjectCutoffs)
        .set({
          generation: sql`${authSubjectCutoffs.generation} + 1`,
          revokedThrough: sql`greatest(${authSubjectCutoffs.revokedThrough}, clock_timestamp())`,
          lastOperationId: operationId,
        })
        .where(
          and(eq(authSubjectCutoffs.userId, session.userId), eq(authSubjectCutoffs.generation, session.generation)),
        )
        .returning();
      if (!cutoff) throw new CurrentStoreFoundationError('STALE_GENERATION');
      await transaction.insert(authSecurityMutationEvents).values({
        operationId,
        userId: session.userId,
        generation: cutoff.generation,
        previousGeneration: previous.generation,
        kind: 'legacy-signout',
        domains: ['first-party'],
        revokedThrough: cutoff.revokedThrough,
        writerEpoch: manifest.writerEpoch,
        projectionId: manifest.projectionId,
        payloadVersion: 1,
      });
      // Keep the evidence rows. The generation is authoritative for old raw JWTs/JWEs.
      await transaction
        .update(authSession)
        .set({ expiresAt: now, updatedAt: now })
        .where(
          and(
            eq(authSession.userId, session.userId),
            sql`coalesce(${authSession.revocationGeneration}, 0) <= ${session.generation}`,
          ),
        );
      await transaction
        .update(mobileRefreshTokens)
        .set({ revokedAt: now })
        .where(
          and(
            eq(mobileRefreshTokens.userId, session.userId),
            isNull(mobileRefreshTokens.revokedAt),
            sql`coalesce(${mobileRefreshTokens.subjectGeneration}, 0) <= ${session.generation}`,
          ),
        );
      await transaction
        .update(authCredentialLineage)
        .set({ revokedAt: now })
        .where(and(eq(authCredentialLineage.userId, session.userId), isNull(authCredentialLineage.revokedAt)));
      return;
    }
    const expiresAt = new Date(
      Math.max(session.expiresAt.getTime() + 60_000, now.getTime() + LEGACY_WEB_MAX_LIFETIME_MS),
    );
    await transaction
      .delete(authSession)
      .where(and(eq(authSession.id, session.authSessionId), eq(authSession.userId, session.userId)));
    await transaction
      .update(authCredentialLineage)
      .set({ revokedAt: now })
      .where(
        and(
          eq(authCredentialLineage.userId, session.userId),
          eq(authCredentialLineage.sessionId, session.authSessionId),
        ),
      );
    await transaction
      .insert(authSessionDenials)
      .values({
        sessionId: session.authSessionId,
        userId: session.userId,
        deniedAt: now,
        expiresAt,
      })
      .onConflictDoUpdate({
        target: authSessionDenials.sessionId,
        set: { expiresAt: sql`greatest(${authSessionDenials.expiresAt}, excluded.expires_at)` },
        setWhere: eq(authSessionDenials.userId, session.userId),
      });
  });
}
