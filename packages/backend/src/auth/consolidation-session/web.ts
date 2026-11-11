/** Backend-only cookie bridge. Caller verifies/decrypts the exact cookie and its original revocation lineage. */
import { createHash } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  accountConsolidationMembers,
  accountConsolidationSessionProofs,
  authSubjectCutoffs,
  mobileRefreshTokens,
  users,
} from '@boardsesh/db/schema/auth';
import type { CurrentStoreTransaction } from '../current-store/foundation-context';
import {
  decideConsolidationSessionTransfer,
  type ConsolidationTransferDecision,
  type VerifiedConsolidationProof,
} from './decision';
import { ConsolidationExchangeError } from './exchange';

type VerifiedWebProof = Extract<VerifiedConsolidationProof, { kind: 'web-session' }>;
type AllowedTransfer = Extract<ConsolidationTransferDecision, { allowed: true }>;

/** Returns data for a cookie-writing response only; never authenticate readonly SSR as another subject. */
export async function exchangeVerifiedConsolidationWebSession<Result>(
  transaction: CurrentStoreTransaction,
  proof: VerifiedWebProof,
  issueCookie: (decision: AllowedTransfer, canonicalSessionId: string) => Promise<Result>,
  now: () => number = Date.now,
): Promise<Result> {
  if (proof.credentialId !== consolidationWebCredentialId(proof.userId, proof.sessionId))
    throw new ConsolidationExchangeError('INELIGIBLE');
  const [hint] = await transaction
    .select()
    .from(accountConsolidationMembers)
    .where(eq(accountConsolidationMembers.sourceUserId, proof.userId));
  if (!hint || hint.status !== 'applied') throw new ConsolidationExchangeError('INELIGIBLE');
  for (const userId of [hint.sourceUserId, hint.canonicalUserId].sort())
    await transaction.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');
  const [member] = await transaction
    .select()
    .from(accountConsolidationMembers)
    .where(eq(accountConsolidationMembers.sourceUserId, proof.userId))
    .for('update');
  if (
    !member?.appliedAt ||
    member.status !== 'applied' ||
    member.canonicalUserId !== hint.canonicalUserId ||
    member.mergeId !== hint.mergeId
  )
    throw new ConsolidationExchangeError('DRIFT');
  const cutoffs = await transaction
    .select()
    .from(authSubjectCutoffs)
    .where(inArray(authSubjectCutoffs.userId, [member.sourceUserId, member.canonicalUserId]))
    .for('update');
  const source = cutoffs.find((row) => row.userId === member.sourceUserId);
  const target = cutoffs.find((row) => row.userId === member.canonicalUserId);
  const targetRows = await transaction.select({ id: users.id }).from(users).where(eq(users.id, member.canonicalUserId));
  const [targetRetirement] = await transaction
    .select({ sourceUserId: accountConsolidationMembers.sourceUserId })
    .from(accountConsolidationMembers)
    .where(
      and(
        eq(accountConsolidationMembers.sourceUserId, member.canonicalUserId),
        eq(accountConsolidationMembers.status, 'applied'),
      ),
    );
  if (!source?.deletedAt || targetRows.length !== 1 || targetRetirement)
    throw new ConsolidationExchangeError('INELIGIBLE');
  const decision = decideConsolidationSessionTransfer(
    proof,
    {
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
      bridgeRevoked: member.webBridgeRevokedAt !== null,
    },
    now(),
  );
  if (!decision.allowed) throw new ConsolidationExchangeError('INELIGIBLE');
  const [previous] = await transaction
    .select()
    .from(accountConsolidationSessionProofs)
    .where(eq(accountConsolidationSessionProofs.credentialId, proof.credentialId))
    .for('update');
  if (
    !previous ||
    previous.kind !== 'web-session' ||
    previous.sourceUserId !== member.sourceUserId ||
    previous.mergeId !== member.mergeId ||
    previous.revokedAt !== null ||
    previous.expiresAt.getTime() <= now()
  )
    throw new ConsolidationExchangeError('INELIGIBLE');
  if (!previous.consumedAt)
    await transaction
      .update(accountConsolidationSessionProofs)
      .set({ consumedAt: new Date(now()) })
      .where(eq(accountConsolidationSessionProofs.credentialId, proof.credentialId));
  return issueCookie(
    { ...decision, originalExpiresAtMs: Math.min(decision.originalExpiresAtMs, previous.expiresAt.getTime()) },
    previous.canonicalSessionId,
  );
}

/** A canonical web logout must revoke the bridge mapping as well as its ordinary session. */
export async function revokeConsolidationWebSession(transaction: CurrentStoreTransaction, canonicalSessionId: string) {
  await transaction
    .update(accountConsolidationSessionProofs)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(accountConsolidationSessionProofs.kind, 'web-session'),
        eq(accountConsolidationSessionProofs.canonicalSessionId, canonicalSessionId),
      ),
    );
}

export async function revokeAllConsolidationTargetBridges(transaction: CurrentStoreTransaction, targetUserId: string) {
  const [schema] = await transaction.execute<{ available: boolean }>(
    sql`SELECT pg_catalog.to_regclass('public.account_consolidation_session_proofs') IS NOT NULL AS available`,
  );
  if (!schema?.available) return;
  const members = await transaction
    .select({ sourceUserId: accountConsolidationMembers.sourceUserId })
    .from(accountConsolidationMembers)
    .where(eq(accountConsolidationMembers.canonicalUserId, targetUserId));
  if (members.length) {
    const proofs = await transaction
      .update(accountConsolidationSessionProofs)
      .set({ revokedAt: new Date() })
      .where(
        inArray(
          accountConsolidationSessionProofs.sourceUserId,
          members.map((member) => member.sourceUserId),
        ),
      )
      .returning({
        sessionId: accountConsolidationSessionProofs.canonicalSessionId,
        kind: accountConsolidationSessionProofs.kind,
      });
    const nativeIds = proofs.filter((proof) => proof.kind === 'native-refresh').map((proof) => proof.sessionId);
    if (nativeIds.length)
      await transaction
        .update(mobileRefreshTokens)
        .set({ revokedAt: new Date() })
        .where(inArray(mobileRefreshTokens.sessionId, nativeIds));
  }
  await transaction
    .update(accountConsolidationMembers)
    .set({ nativeBridgeRevokedAt: new Date(), webBridgeRevokedAt: new Date() })
    .where(eq(accountConsolidationMembers.canonicalUserId, targetUserId));
}

/** Stable across rotated cookies of the same original login; never key by raw-cookie digest alone. */
export function consolidationWebCredentialId(sourceUserId: string, sourceSessionId: string): string {
  return `web:${createHash('sha256')
    .update(JSON.stringify([sourceUserId, sourceSessionId]))
    .digest('hex')}`;
}
