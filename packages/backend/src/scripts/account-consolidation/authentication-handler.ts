import { createHash } from 'node:crypto';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  accounts,
  accountConsolidationMembers,
  authEmailProjection,
  authEmailReservationMembers,
  authEmailReservations,
  authEmailVerificationTokens,
  authPasswordRecoveryTokens,
  authSubjectCutoffs,
  mobileRefreshTokens,
  sessions,
  userCredentials,
  users,
  verificationTokens,
} from '@boardsesh/db/schema/auth';
import { notificationDevices } from '@boardsesh/db/schema/app';
import type { ConsolidationDomainHandler } from './executor';

/** Authentication is finalized last, in the same group transaction as all ownership moves. */
export function authenticationConsolidationHandler(): ConsolidationDomainHandler {
  return {
    name: 'authentication',
    userReferences: [
      'public.accounts.userId',
      'public.sessions.userId',
      'public.mobile_refresh_tokens.user_id',
      'public.user_credentials.user_id',
      'public.notification_devices.user_id',
    ],
    async apply(transaction, context) {
      const { survivorUserId, sourceUserIds, mergeId, group } = context;
      const appliedAt = new Date();
      const [survivor] = await transaction.select().from(users).where(eq(users.id, survivorUserId));
      const [targetCutoff] = await transaction
        .select()
        .from(authSubjectCutoffs)
        .where(eq(authSubjectCutoffs.userId, survivorUserId))
        .for('update');
      if (!survivor || survivor.email !== group.normalizedEmail || targetCutoff?.deletedAt)
        throw new Error('Consolidation authentication state changed.');
      const counters = {
        retiredSubjects: 0,
        providerLinks: 0,
        sourcePasswordsRemoved: 0,
        nativeSessionsRevoked: 0,
        webSessionsRemoved: 0,
      };
      const placeholders: { userId: string; email: string }[] = [];
      for (const sourceUserId of [...sourceUserIds].sort()) {
        const [source] = await transaction.select().from(users).where(eq(users.id, sourceUserId));
        const [sourceCutoff] = await transaction
          .select()
          .from(authSubjectCutoffs)
          .where(eq(authSubjectCutoffs.userId, sourceUserId))
          .for('update');
        if (!source || sourceCutoff?.deletedAt) throw new Error('Consolidation source is unavailable.');
        const sourceGenerationBefore = sourceCutoff?.generation ?? 0;
        const sourceNativeGenerationBefore = sourceCutoff?.nativeGeneration ?? 0;
        await transaction.insert(accountConsolidationMembers).values({
          sourceUserId,
          canonicalUserId: survivorUserId,
          mergeId,
          status: 'applied',
          appliedAt,
        });
        const revokedSessions = await transaction
          .update(mobileRefreshTokens)
          .set({ revokedAt: appliedAt })
          .where(and(eq(mobileRefreshTokens.userId, sourceUserId), isNull(mobileRefreshTokens.revokedAt)))
          .returning({ id: mobileRefreshTokens.id });
        counters.nativeSessionsRevoked += revokedSessions.length;
        const moved = await transaction
          .update(accounts)
          .set({ userId: survivorUserId })
          .where(and(eq(accounts.userId, sourceUserId), inArray(accounts.provider, ['google', 'apple'])))
          .returning({ provider: accounts.provider });
        counters.providerLinks += moved.length;
        const passwords = await transaction
          .delete(userCredentials)
          .where(eq(userCredentials.userId, sourceUserId))
          .returning({ userId: userCredentials.userId });
        counters.sourcePasswordsRemoved += passwords.length;
        // Source sessions end here. Canonical sessions and credentials remain unchanged.
        const removedSessions = await transaction
          .delete(sessions)
          .where(eq(sessions.userId, sourceUserId))
          .returning({ sessionToken: sessions.sessionToken });
        counters.webSessionsRemoved += removedSessions.length;
        await transaction
          .update(notificationDevices)
          .set({ active: false, updatedAt: appliedAt })
          .where(eq(notificationDevices.userId, sourceUserId));
        await transaction
          .update(authEmailVerificationTokens)
          .set({ supersededAt: appliedAt })
          .where(eq(authEmailVerificationTokens.userId, sourceUserId));
        await transaction
          .update(authPasswordRecoveryTokens)
          .set({ supersededAt: appliedAt })
          .where(eq(authPasswordRecoveryTokens.userId, sourceUserId));
        const placeholder = `${createHash('sha256').update(`${mergeId}:${sourceUserId}`).digest('hex')}@retired.boardsesh.invalid`;
        await transaction
          .update(users)
          .set({ email: placeholder, emailVerified: null, updatedAt: appliedAt })
          .where(eq(users.id, sourceUserId));
        placeholders.push({ userId: sourceUserId, email: placeholder });
        await transaction
          .insert(authSubjectCutoffs)
          .values({
            userId: sourceUserId,
            generation: sourceGenerationBefore + 1,
            nativeGeneration: sourceNativeGenerationBefore,
            revokedThrough: appliedAt,
            deletedAt: appliedAt,
            lastOperationId: mergeId,
          })
          .onConflictDoUpdate({
            target: authSubjectCutoffs.userId,
            set: {
              generation: sourceGenerationBefore + 1,
              nativeGeneration: sourceNativeGenerationBefore,
              revokedThrough: appliedAt,
              deletedAt: appliedAt,
              lastOperationId: mergeId,
            },
          });
        // Old email-keyed links must never reset whichever account now holds the address.
        await transaction
          .delete(verificationTokens)
          .where(inArray(verificationTokens.identifier, [source.email, `password-reset:${source.email}`]));
        counters.retiredSubjects++;
      }
      // Legacy links identify only an email, so a pre-merge link for this ambiguous
      // normalized address cannot prove its original UID. Request a fresh link.
      // UID-scoped canonical recovery rows and existing sessions remain untouched.
      await transaction
        .delete(verificationTokens)
        .where(inArray(verificationTokens.identifier, [survivor.email, `password-reset:${survivor.email}`]));
      const [projection] = await transaction
        .select()
        .from(authEmailProjection)
        .where(eq(authEmailProjection.isCurrent, true))
        .for('update');
      if (projection) {
        if (projection.phase === 'preparing') throw new Error('Consolidation projection is being prepared.');
        const [reservation] = await transaction
          .select()
          .from(authEmailReservations)
          .where(eq(authEmailReservations.normalizedEmail, group.normalizedEmail))
          .for('update');
        if (reservation && !['owned', 'blocked_ambiguous'].includes(reservation.state))
          throw new Error('Consolidation email reservation changed.');
        await transaction
          .delete(authEmailReservationMembers)
          .where(eq(authEmailReservationMembers.normalizedEmail, group.normalizedEmail));
        await transaction
          .insert(authEmailReservations)
          .values({
            normalizedEmail: group.normalizedEmail,
            basisProjectionId: projection.projectionId,
            state: 'owned',
            ownerUserId: survivorUserId,
          })
          .onConflictDoUpdate({
            target: authEmailReservations.normalizedEmail,
            set: { state: 'owned', ownerUserId: survivorUserId },
          });
        await transaction
          .insert(authEmailReservationMembers)
          .values({ normalizedEmail: group.normalizedEmail, userId: survivorUserId });
        for (const placeholder of placeholders) {
          await transaction.insert(authEmailReservations).values({
            normalizedEmail: placeholder.email,
            basisProjectionId: projection.projectionId,
            state: 'owned',
            ownerUserId: placeholder.userId,
          });
          await transaction
            .insert(authEmailReservationMembers)
            .values({ normalizedEmail: placeholder.email, userId: placeholder.userId });
        }
        await transaction
          .update(authEmailProjection)
          .set({
            keyCount: sql`${authEmailProjection.keyCount} + ${placeholders.length + (reservation ? 0 : 1)}`,
            ambiguousKeyCount: sql`${authEmailProjection.ambiguousKeyCount} - ${reservation?.state === 'blocked_ambiguous' ? 1 : 0}`,
          })
          .where(eq(authEmailProjection.projectionId, projection.projectionId));
      }
      return counters;
    },
  };
}
