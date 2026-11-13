import {
  requireIdentityGenerationMutationReceipt,
  type IdentityGenerationMutationReceipt,
} from '../current-store/security-mutation-core';
import { and, eq } from 'drizzle-orm';
import { accounts, authAccount, authSubjectCutoffs, userCredentials, users } from '@boardsesh/db/schema';
import type { AuthorityTransaction } from './adapter';
import { createAuthorityAdapter } from './adapter';
import { CURRENT_EMAIL_NORMALIZER_VERSION, lockEnforcedIdentityManifest } from '../current-store/foundation-context';

async function lockCanonicalUser(transaction: AuthorityTransaction, userId: string) {
  const manifest = await lockEnforcedIdentityManifest(transaction);
  if (manifest.writerAuthority !== 'better-auth' || manifest.normalizerVersion !== CURRENT_EMAIL_NORMALIZER_VERSION)
    throw new Error('AUTH_IDENTITY_CANONICAL_AUTHORITY_REQUIRED');
  const [user] = await transaction.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');
  if (!user) return null;
  const [cutoff] = await transaction
    .select()
    .from(authSubjectCutoffs)
    .where(eq(authSubjectCutoffs.userId, userId))
    .for('update');
  if (cutoff?.deletedAt) throw new Error('AUTH_IDENTITY_SUBJECT_DELETED');
  return { generation: cutoff?.generation ?? 0 };
}

/**
 * Only after the same transaction's first-party cutoff increment. Every
 * canonical row must have belonged to the previous generation; NULL or stale
 * imports cannot be blessed into the new generation. The primary credential
 * operation has already happened through the bound Better Auth adapter.
 */
export async function advanceCanonicalIdentityGeneration(
  transaction: AuthorityTransaction,
  userId: string,
  mutationReceipt: IdentityGenerationMutationReceipt,
): Promise<void> {
  if (process.env.DEBUG_SQL === 'true') throw new Error('Unsafe identity mirror SQL logging');
  const { previousGeneration, generation: nextGeneration } = requireIdentityGenerationMutationReceipt(
    transaction,
    userId,
    mutationReceipt,
  );
  if (
    !Number.isSafeInteger(previousGeneration) ||
    previousGeneration < 0 ||
    !Number.isSafeInteger(nextGeneration) ||
    nextGeneration !== previousGeneration + 1 ||
    nextGeneration > 2_147_483_647
  )
    throw new Error('AUTH_IDENTITY_GENERATION_INVALID');
  const subject = await lockCanonicalUser(transaction, userId);
  if (!subject) return;
  if (subject.generation !== nextGeneration) throw new Error('AUTH_IDENTITY_CUTOFF_GENERATION_STALE');
  const canonical = await transaction.select().from(authAccount).where(eq(authAccount.userId, userId)).for('update');
  if (canonical.some((account) => account.sourceGeneration !== previousGeneration))
    throw new Error('AUTH_IDENTITY_CANONICAL_GENERATION_STALE');
  const adapter = createAuthorityAdapter(transaction)({ logger: { disabled: true }, telemetry: { enabled: false } });
  const changed = await adapter.updateMany({
    model: 'account',
    where: [
      { field: 'userId', value: userId },
      { field: 'sourceGeneration', value: previousGeneration },
    ],
    update: { sourceGeneration: nextGeneration },
  });
  if (changed !== canonical.length) throw new Error('AUTH_IDENTITY_CANONICAL_GENERATION_STALE');
}

/** Caller owns the gate, user lock, primary write, revocation policy and commit. */
export async function mirrorAuthorityToCurrentStore(transaction: AuthorityTransaction, userId: string): Promise<void> {
  if (process.env.DEBUG_SQL === 'true') throw new Error('Unsafe identity mirror SQL logging');
  const subject = await lockCanonicalUser(transaction, userId);
  if (!subject) return;
  const canonical = await transaction.select().from(authAccount).where(eq(authAccount.userId, userId)).for('update');
  if (canonical.some((account) => account.sourceGeneration !== subject.generation))
    throw new Error('AUTH_IDENTITY_CANONICAL_GENERATION_STALE');
  const passwords = canonical.filter((account) => account.providerId === 'credential');
  if (
    passwords.length > 1 ||
    passwords.some((account) => account.accountId !== userId || typeof account.password !== 'string')
  )
    throw new Error('AUTH_IDENTITY_CREDENTIAL_NAMESPACE_INVALID');
  const password = passwords[0];
  const providers = canonical.filter((account) => account.providerId !== 'credential');
  if (providers.some((account) => !account.providerId || !account.accountId || account.password !== null))
    throw new Error('AUTH_IDENTITY_PROVIDER_NAMESPACE_INVALID');
  const [legacyPassword] = await transaction
    .select()
    .from(userCredentials)
    .where(eq(userCredentials.userId, userId))
    .for('update');
  // There is no supported password-removal command. A partial canonical import
  // must fail rather than erase a legacy password while claiming rollback safety.
  if (!password && legacyPassword) throw new Error('AUTH_IDENTITY_PASSWORD_REMOVAL_UNSUPPORTED');
  const passwordHash = password?.password;
  if (password && typeof passwordHash === 'string' && !legacyPassword) {
    await transaction
      .insert(userCredentials)
      .values({ userId, passwordHash, createdAt: password.createdAt, updatedAt: password.updatedAt });
  } else if (
    password &&
    typeof passwordHash === 'string' &&
    legacyPassword &&
    passwordHash !== legacyPassword.passwordHash
  ) {
    await transaction
      .update(userCredentials)
      .set({ passwordHash, updatedAt: password.updatedAt })
      .where(eq(userCredentials.userId, userId));
  }
  const legacyProviders = await transaction.select().from(accounts).where(eq(accounts.userId, userId)).for('update');
  if (legacyProviders.some((account) => account.provider === 'credential'))
    throw new Error('AUTH_IDENTITY_PROVIDER_NAMESPACE_CONFLICT');
  for (const legacy of legacyProviders) {
    if (
      !providers.some(
        (account) => account.providerId === legacy.provider && account.accountId === legacy.providerAccountId,
      )
    )
      await transaction
        .delete(accounts)
        .where(
          and(
            eq(accounts.userId, userId),
            eq(accounts.provider, legacy.provider),
            eq(accounts.providerAccountId, legacy.providerAccountId),
          ),
        );
  }
  for (const provider of providers) {
    if (
      legacyProviders.some(
        (account) => account.provider === provider.providerId && account.providerAccountId === provider.accountId,
      )
    )
      continue;
    await transaction
      .insert(accounts)
      .values({ userId, type: 'oauth', provider: provider.providerId, providerAccountId: provider.accountId })
      .onConflictDoNothing();
    const [stored] = await transaction
      .select({ userId: accounts.userId })
      .from(accounts)
      .where(and(eq(accounts.provider, provider.providerId), eq(accounts.providerAccountId, provider.accountId)));
    if (stored?.userId !== userId) throw new Error('AUTH_IDENTITY_PROVIDER_OWNER_CONFLICT');
  }
}
