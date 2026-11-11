/** Unmounted real-transaction adapter. Caller owns COMMIT/ROLLBACK and verified bearer lookup. */
import { and, eq, inArray, isNull } from 'drizzle-orm';
import {
  accountConsolidationMembers,
  accountConsolidationSessionProofs,
  authSubjectCutoffs,
  mobileRefreshTokens,
  users,
} from '@boardsesh/db/schema/auth';
import type { CurrentStoreTransaction } from '../current-store/foundation-context';
import type { ConsolidationExchangeTransaction } from './exchange';
import type { ConsolidationTransferDecision } from './decision';

type AllowedTransfer = Extract<ConsolidationTransferDecision, { allowed: true }>;

export function nativeConsolidationExchangeTransaction<Result>(
  transaction: CurrentStoreTransaction,
  expectedTokenHash: string,
  issue: (decision: AllowedTransfer, canonicalSessionId: string) => Promise<Result>,
): ConsolidationExchangeTransaction<Result> {
  let canonicalSessionId: string | undefined;
  return {
    async lockSubjectsInOrder(userIds) {
      // Sequential locks, independent of planner input order or query plan.
      for (const userId of [...new Set(userIds)].sort())
        await transaction.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');
    },
    async readLockedTransfer(credentialId) {
      const [parent] = await transaction
        .select()
        .from(mobileRefreshTokens)
        .where(and(eq(mobileRefreshTokens.id, credentialId), eq(mobileRefreshTokens.tokenHash, expectedTokenHash)))
        .for('update');
      if (!parent) return null;
      const [member] = await transaction
        .select()
        .from(accountConsolidationMembers)
        .where(eq(accountConsolidationMembers.sourceUserId, parent.userId))
        .for('update');
      const [enrollment] = await transaction
        .select()
        .from(accountConsolidationSessionProofs)
        .where(eq(accountConsolidationSessionProofs.credentialId, credentialId))
        .for('update');
      if (
        !member ||
        member.status !== 'applied' ||
        !member.appliedAt ||
        !enrollment ||
        enrollment.kind !== 'native-refresh' ||
        enrollment.mergeId !== member.mergeId ||
        enrollment.sourceUserId !== parent.userId
      )
        return null;
      const subjects = await transaction
        .select({ id: users.id })
        .from(users)
        .where(inArray(users.id, [member.sourceUserId, member.canonicalUserId]));
      const cutoffs = await transaction
        .select()
        .from(authSubjectCutoffs)
        .where(inArray(authSubjectCutoffs.userId, [member.sourceUserId, member.canonicalUserId]))
        .for('update');
      const source = cutoffs.find((cutoff) => cutoff.userId === member.sourceUserId);
      const target = cutoffs.find((cutoff) => cutoff.userId === member.canonicalUserId);
      const [targetRetirement] = await transaction
        .select({ sourceUserId: accountConsolidationMembers.sourceUserId })
        .from(accountConsolidationMembers)
        .where(
          and(
            eq(accountConsolidationMembers.sourceUserId, member.canonicalUserId),
            eq(accountConsolidationMembers.status, 'applied'),
          ),
        );
      if (!source?.deletedAt || subjects.length !== 2 || targetRetirement) return null;
      canonicalSessionId = enrollment.canonicalSessionId;
      return {
        proof: {
          kind: 'native-refresh',
          userId: parent.userId,
          credentialId: parent.id,
          issuedAtMs: parent.createdAt.getTime(),
          expiresAtMs: Math.min(parent.expiresAt.getTime(), enrollment.expiresAt.getTime()),
          authenticatedAtMs: parent.authenticatedAt?.getTime() ?? null,
          sourceGeneration: parent.subjectGeneration ?? 0,
          sourceNativeGeneration: parent.nativeGeneration ?? 0,
          revoked: parent.revokedAt !== null || enrollment.revokedAt !== null || enrollment.consumedAt !== null,
          sessionId: parent.sessionId,
        },
        state: {
          retirement: { ...member, targetUserId: member.canonicalUserId, retiredAtMs: member.appliedAt.getTime() },
          source: {
            userId: member.sourceUserId,
            active: false,
            generation: source.generation,
            nativeGeneration: source.nativeGeneration,
            consolidationMergeId: member.mergeId,
          },
          target: {
            userId: member.canonicalUserId,
            active: !target?.deletedAt,
            generation: target?.generation ?? 0,
            nativeGeneration: target?.nativeGeneration ?? 0,
            consolidationMergeId: null,
          },
          bridgeRevoked: member.nativeBridgeRevokedAt !== null,
        },
      };
    },
    async consumeOnce(credentialId, mergeId) {
      const claimed = await transaction
        .update(accountConsolidationSessionProofs)
        .set({ consumedAt: new Date() })
        .where(
          and(
            eq(accountConsolidationSessionProofs.credentialId, credentialId),
            eq(accountConsolidationSessionProofs.mergeId, mergeId),
            isNull(accountConsolidationSessionProofs.consumedAt),
            isNull(accountConsolidationSessionProofs.revokedAt),
          ),
        )
        .returning({ credentialId: accountConsolidationSessionProofs.credentialId });
      if (claimed.length !== 1) return false;
      const consumed = await transaction
        .update(mobileRefreshTokens)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(mobileRefreshTokens.id, credentialId),
            eq(mobileRefreshTokens.tokenHash, expectedTokenHash),
            isNull(mobileRefreshTokens.revokedAt),
          ),
        )
        .returning({ id: mobileRefreshTokens.id });
      return consumed.length === 1;
    },
    async issueCanonical(decision) {
      if (!canonicalSessionId) throw new Error('Consolidation canonical lineage is unavailable.');
      return issue(decision, canonicalSessionId);
    },
  };
}

/** Revoke pending and transferred native lineages for one former source, without unrelated survivor sessions. */
export async function revokeConsolidationSourceNativeSessions(
  transaction: CurrentStoreTransaction,
  sourceUserId: string,
) {
  const proofs = await transaction
    .update(accountConsolidationSessionProofs)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(accountConsolidationSessionProofs.sourceUserId, sourceUserId),
        eq(accountConsolidationSessionProofs.kind, 'native-refresh'),
      ),
    )
    .returning({ canonicalSessionId: accountConsolidationSessionProofs.canonicalSessionId });
  await transaction
    .update(accountConsolidationMembers)
    .set({ nativeBridgeRevokedAt: new Date() })
    .where(eq(accountConsolidationMembers.sourceUserId, sourceUserId));
  if (proofs.length)
    await transaction
      .update(mobileRefreshTokens)
      .set({ revokedAt: new Date() })
      .where(
        inArray(
          mobileRefreshTokens.sessionId,
          proofs.map((proof) => proof.canonicalSessionId),
        ),
      );
}

/** Reset/account-wide sign-out invalidates pending bridges even when legacy revoke does not increment generations. */
export async function revokeConsolidationTargetNativeBridges(
  transaction: CurrentStoreTransaction,
  targetUserId: string,
) {
  await transaction
    .update(accountConsolidationMembers)
    .set({ nativeBridgeRevokedAt: new Date() })
    .where(eq(accountConsolidationMembers.canonicalUserId, targetUserId));
  const members = await transaction
    .select({ sourceUserId: accountConsolidationMembers.sourceUserId })
    .from(accountConsolidationMembers)
    .where(eq(accountConsolidationMembers.canonicalUserId, targetUserId));
  if (members.length)
    await transaction
      .update(accountConsolidationSessionProofs)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(accountConsolidationSessionProofs.kind, 'native-refresh'),
          inArray(
            accountConsolidationSessionProofs.sourceUserId,
            members.map((member) => member.sourceUserId),
          ),
        ),
      );
}
