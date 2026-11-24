import { createHash } from 'node:crypto';
import {
  authAccount,
  authEmailProjection,
  authPasswordChangeEvidence,
  authSubjectCutoffs,
  userCredentials,
  users,
} from '@boardsesh/db/schema/auth';
import { and, eq, sql } from 'drizzle-orm';
import { CURRENT_EMAIL_NORMALIZER_VERSION, type CurrentStoreTransaction } from './current-store/foundation-context';

export const PASSWORD_CHANGE_EVIDENCE_MODE_ENV = 'AUTH_PASSWORD_CHANGE_EVIDENCE_MODE';
type Environment = Readonly<Record<string, string | undefined>>;

/** Schema and exact credential grants land before an operator enables capture. */
export function passwordChangeEvidenceEnabled(environment: Environment = process.env): boolean {
  const mode = environment[PASSWORD_CHANGE_EVIDENCE_MODE_ENV];
  if (mode === undefined || mode === '' || mode === 'off') return false;
  if (mode === 'on') return true;
  throw new Error('AUTH_PASSWORD_CHANGE_EVIDENCE_MODE_INVALID');
}

export function passwordFingerprint(passwordHash: string): string {
  return createHash('sha256').update(passwordHash, 'utf8').digest('hex');
}

/**
 * Call only after a real primary password insert/replacement in this transaction.
 * The caller already owns its users row. Import and mirror primitives never call
 * this: observing or copying bytes cannot establish when a password changed.
 * Once on, failure aborts the password transaction; evidence is never best effort.
 */
export async function recordPasswordChangeEvidence(
  transaction: CurrentStoreTransaction,
  userId: string,
  passwordHash: string,
): Promise<void> {
  if (!passwordChangeEvidenceEnabled()) return;
  const fingerprint = passwordFingerprint(passwordHash);
  await transaction
    .insert(authPasswordChangeEvidence)
    .values({ userId, passwordFingerprint: fingerprint, changedAt: sql`clock_timestamp()` })
    .onConflictDoUpdate({
      target: authPasswordChangeEvidence.userId,
      set: { passwordFingerprint: fingerprint, changedAt: sql`clock_timestamp()` },
    });
}

/**
 * One statement snapshot binds the manifest, selected credential and evidence.
 * No password or mismatched/missing evidence means unrecognised, never an
 * inferred age. Nothing here creates evidence or locks credential rows.
 */
export async function readPasswordEvidenceAccounts(
  transaction: CurrentStoreTransaction,
  normalizedEmail: string,
  limit: number,
): Promise<readonly { readonly userId: string; readonly passwordChangedAt: Date | null }[]> {
  // Bound users before looking up credential rows: an invalid canonical
  // inventory must not consume a sibling account's candidate slot.
  const candidates = transaction
    .select({ userId: users.id })
    .from(users)
    .where(sql`LOWER(${users.email}) = ${normalizedEmail}`)
    .limit(limit)
    .as('password_evidence_candidates');
  const canonicalCredential = transaction
    .select({
      count: sql<number>`count(*)::integer`.as('credential_count'),
      passwordHash: sql<string | null>`CASE WHEN count(*) = 1 THEN min(${authAccount.password}) END`.as(
        'canonical_password_hash',
      ),
      accountId: sql<string | null>`CASE WHEN count(*) = 1 THEN min(${authAccount.accountId}) END`.as(
        'canonical_account_id',
      ),
      generation: sql<number | null>`CASE WHEN count(*) = 1 THEN min(${authAccount.sourceGeneration}) END`.as(
        'canonical_source_generation',
      ),
    })
    .from(authAccount)
    .where(and(eq(authAccount.userId, candidates.userId), eq(authAccount.providerId, 'credential')))
    .as('password_evidence_canonical');
  const accounts = await transaction
    .select({
      userId: candidates.userId,
      manifestId: authEmailProjection.projectionId,
      authority: authEmailProjection.writerAuthority,
      phase: authEmailProjection.phase,
      normalizerVersion: authEmailProjection.normalizerVersion,
      epoch: authEmailProjection.writerEpoch,
      legacyPasswordHash: userCredentials.passwordHash,
      canonicalPasswordHash: canonicalCredential.passwordHash,
      canonicalAccountId: canonicalCredential.accountId,
      canonicalGeneration: canonicalCredential.generation,
      canonicalCount: canonicalCredential.count,
      generation: sql<number>`coalesce(${authSubjectCutoffs.generation}, 0)::integer`,
      deletedAt: authSubjectCutoffs.deletedAt,
      fingerprint: authPasswordChangeEvidence.passwordFingerprint,
      changedAt: authPasswordChangeEvidence.changedAt,
    })
    .from(candidates)
    .leftJoin(authEmailProjection, eq(authEmailProjection.isCurrent, true))
    .leftJoin(userCredentials, eq(userCredentials.userId, candidates.userId))
    .leftJoinLateral(canonicalCredential, eq(authEmailProjection.writerAuthority, 'better-auth'))
    .leftJoin(authSubjectCutoffs, eq(authSubjectCutoffs.userId, candidates.userId))
    .leftJoin(authPasswordChangeEvidence, eq(authPasswordChangeEvidence.userId, candidates.userId));
  const result = new Map<string, { readonly userId: string; readonly passwordChangedAt: Date | null }>();
  for (const account of accounts) {
    if (
      account.manifestId !== null &&
      (account.normalizerVersion !== CURRENT_EMAIL_NORMALIZER_VERSION ||
        !Number.isSafeInteger(account.epoch) ||
        (account.epoch ?? 0) < 1 ||
        !['current-store', 'better-auth'].includes(account.authority ?? '') ||
        !['preparing', 'prepared', 'enforced'].includes(account.phase ?? '') ||
        (account.authority === 'better-auth' && account.phase !== 'enforced'))
    )
      throw new Error('PASSWORD_CHANGE_EVIDENCE_AUTHORITY_UNAVAILABLE');
    const passwordHash =
      account.authority === 'better-auth'
        ? account.canonicalCount === 1 &&
          account.canonicalAccountId === account.userId &&
          account.canonicalGeneration === account.generation
          ? account.canonicalPasswordHash
          : null
        : account.legacyPasswordHash;
    const changedAt =
      !account.deletedAt &&
      typeof passwordHash === 'string' &&
      account.fingerprint === passwordFingerprint(passwordHash) &&
      account.changedAt instanceof Date &&
      Number.isFinite(account.changedAt.getTime())
        ? account.changedAt
        : null;
    result.set(account.userId, { userId: account.userId, passwordChangedAt: changedAt });
  }
  return [...result.values()];
}
