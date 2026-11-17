import { mirrorAuthorityToCurrentStore } from './reverse-identity';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import {
  accounts,
  authAccount,
  authEmailProjection,
  authSubjectCutoffs,
  userCredentials,
  users,
} from '@boardsesh/db/schema';
import type { AuthorityTransaction } from './adapter';
import { identityMirrorMode } from './mirror-configuration';
import { identityMirrorRecord } from './mirror-activation';
import { IdentityCopyPreconditionError, type IdentityCopyAuthority } from './identity-copy-preconditions';
import {
  AUTHORITY_GATE_KEY,
  AUTHORITY_GATE_NAMESPACE,
  CURRENT_EMAIL_NORMALIZER_VERSION,
  CurrentStoreFoundationError,
  requireReadCommitted,
} from '../current-store/foundation-context';
import { sql } from 'drizzle-orm';

export type IdentitySyncDirection = 'current-store-to-authority' | 'authority-to-current-store';

/** Start before creation writes too: acquiring the gate after a user write reverses switch lock order. */
export async function lockIdentityMirrorGate(transaction: AuthorityTransaction): Promise<void> {
  await requireReadCommitted(transaction);
  await transaction.execute(
    sql`SELECT pg_catalog.pg_advisory_xact_lock_shared(${AUTHORITY_GATE_NAMESPACE}, ${AUTHORITY_GATE_KEY})`,
  );
}

/**
 * The single copy primitive for mirror and import. Caller owns commit.
 * Always lock the user before reading source credentials, even for a backfill.
 * No identity, session, authentication age, OAuth token, or revocation evidence is created.
 *
 * `qualified` is the enforced current-store manifest the caller checked its
 * preconditions under (the import's, or the backend's at startup). The manifest
 * is read after the shared gate, so a switch or re-preparation that committed
 * since makes this transaction refuse with STALE_AUTHORITY before any write.
 */
export async function syncIdentity(
  transaction: AuthorityTransaction,
  userId: string,
  direction: IdentitySyncDirection,
  qualified?: IdentityCopyAuthority,
): Promise<void> {
  if (process.env.DEBUG_SQL === 'true') throw new Error('Unsafe identity mirror SQL logging');
  if (direction === 'authority-to-current-store') {
    await mirrorAuthorityToCurrentStore(transaction, userId);
    return;
  }
  if (direction !== 'current-store-to-authority') throw new Error('AUTH_IDENTITY_DIRECTION_UNSUPPORTED');
  const expected = qualified ? { ...qualified } : undefined;
  await lockIdentityMirrorGate(transaction);
  const [manifest] = await transaction
    .select({
      authority: authEmailProjection.writerAuthority,
      phase: authEmailProjection.phase,
      projectionId: authEmailProjection.projectionId,
      epoch: authEmailProjection.writerEpoch,
      normalizerVersion: authEmailProjection.normalizerVersion,
    })
    .from(authEmailProjection)
    .where(eq(authEmailProjection.isCurrent, true));
  if (
    expected &&
    (!manifest ||
      manifest.phase !== 'enforced' ||
      manifest.authority !== 'current-store' ||
      manifest.normalizerVersion !== CURRENT_EMAIL_NORMALIZER_VERSION ||
      manifest.projectionId !== expected.projectionId ||
      manifest.epoch !== expected.epoch)
  )
    throw new CurrentStoreFoundationError('STALE_AUTHORITY');
  if (manifest?.authority === 'better-auth') throw new Error('AUTH_IDENTITY_SOURCE_AUTHORITY_REQUIRED');
  const [user] = await transaction.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');
  if (!user) return;
  const [cutoff] = await transaction
    .select()
    .from(authSubjectCutoffs)
    .where(eq(authSubjectCutoffs.userId, userId))
    .for('update');
  if (cutoff?.deletedAt) return;
  const generation = cutoff?.generation ?? 0;
  const [credential] = await transaction.select().from(userCredentials).where(eq(userCredentials.userId, userId));
  const providers = await transaction.select().from(accounts).where(eq(accounts.userId, userId));
  const targets = await transaction.select().from(authAccount).where(eq(authAccount.userId, userId)).for('update');
  if (targets.some((target) => target.sourceGeneration !== null && target.sourceGeneration > generation)) {
    throw new Error('AUTH_IDENTITY_SOURCE_GENERATION_STALE');
  }
  if (providers.some((provider) => provider.provider === 'credential'))
    throw new Error('AUTH_IDENTITY_PROVIDER_NAMESPACE_CONFLICT');
  const sourceRows = [
    ...(credential ? [{ providerId: 'credential', accountId: userId, password: credential.passwordHash }] : []),
    ...providers.map((provider) => ({
      providerId: provider.provider,
      accountId: provider.providerAccountId,
      password: null,
    })),
  ];
  // Structured pairs avoid ambiguous provider/subject string concatenation.
  for (const target of targets) {
    if (
      !sourceRows.some((source) => source.providerId === target.providerId && source.accountId === target.accountId)
    ) {
      await transaction.delete(authAccount).where(and(eq(authAccount.id, target.id), eq(authAccount.userId, userId)));
    }
  }
  for (const source of sourceRows) {
    const existing = targets.find(
      (target) => target.providerId === source.providerId && target.accountId === source.accountId,
    );
    if (existing && existing.password === source.password && existing.sourceGeneration === generation) continue;
    // A subject owned by another user must fail uniqueness, never be reassigned.
    await transaction
      .insert(authAccount)
      .values({ id: randomUUID(), userId, ...source, sourceGeneration: generation })
      .onConflictDoUpdate({
        target: [authAccount.providerId, authAccount.accountId],
        set: { password: source.password, sourceGeneration: generation },
        setWhere: eq(authAccount.userId, userId),
      });
    const [stored] = await transaction
      .select({ userId: authAccount.userId })
      .from(authAccount)
      .where(and(eq(authAccount.providerId, source.providerId), eq(authAccount.accountId, source.accountId)));
    if (stored?.userId !== userId) throw new Error('AUTH_IDENTITY_PROVIDER_OWNER_CONFLICT');
  }
}

/**
 * No queries or changed behavior under the default-off selector. Failure aborts the caller transaction.
 * With `on`, a process that never qualified at startup refuses (MIRROR_NOT_QUALIFIED), an inert one
 * refuses (STALE_AUTHORITY), and a qualified one copies only under the manifest it qualified.
 */
export async function mirrorIdentityIfEnabled(transaction: AuthorityTransaction, userId: string): Promise<void> {
  if (identityMirrorMode() === 'off') return;
  const record = identityMirrorRecord();
  if (!record) throw new IdentityCopyPreconditionError('MIRROR_NOT_QUALIFIED');
  if (record.state === 'inert') throw new CurrentStoreFoundationError('STALE_AUTHORITY');
  await syncIdentity(
    transaction,
    userId,
    'current-store-to-authority',
    record.state === 'qualified' ? record.authority : undefined,
  );
}
