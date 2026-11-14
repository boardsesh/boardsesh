import { and, asc, eq, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import { authBrowserBindings, authBrowserIntents, authFirstPasswordChallenges, users } from '@boardsesh/db/schema/auth';
import { firstPasswordMode } from '@boardsesh/auth-protocol';
import type { AuthorityDatabase } from './adapter';
import { captureIdentityAuthority, revalidateIdentityAuthority, type IdentityAuthorityQualification } from './router';
import { providerDatabaseNow } from './provider-security-context';
import { getCredentialDatabase } from '../credential-database';
import { currentStoreAuthorityConfiguration } from '../current-store/authority-configuration';

export const FIRST_PASSWORD_SCRUB_BATCH_SIZE = 25;
export const FIRST_PASSWORD_SCRUB_BUDGET_MS = 750;

/** Scrub secrets only, never delete accounts, challenges or replay receipts.
 * The batch has a DB-clock work budget and short individual SQL/lock bounds.
 * Busy users, selections, intents and challenges are retried on the next tick. */
export async function scrubExpiredFirstPasswordPreparations(
  database: AuthorityDatabase,
  qualificationInput: IdentityAuthorityQualification,
) {
  const qualification = Object.freeze({ ...qualificationInput });
  return database.transaction(async (transaction) => {
    await transaction.execute(sql`SET LOCAL statement_timeout='1000ms'`);
    await transaction.execute(sql`SET LOCAL lock_timeout='100ms'`);
    const authority = await captureIdentityAuthority(transaction, qualification);
    const started = await providerDatabaseNow(transaction);
    const deadline = started.getTime() + FIRST_PASSWORD_SCRUB_BUDGET_MS;
    const withinBudget = async () => (await providerDatabaseNow(transaction)).getTime() < deadline;
    const candidates = await transaction
      .select({
        hash: authFirstPasswordChallenges.challengeHash,
        userId: authFirstPasswordChallenges.userId,
        bindingId: authFirstPasswordChallenges.browserBindingHash,
        intentId: authFirstPasswordChallenges.browserIntentHash,
      })
      .from(authFirstPasswordChallenges)
      .where(
        and(
          eq(authFirstPasswordChallenges.phase, 'prepared'),
          isNull(authFirstPasswordChallenges.consumedAt),
          isNotNull(authFirstPasswordChallenges.pendingPasswordHash),
          lte(authFirstPasswordChallenges.expiresAt, started),
        ),
      )
      .orderBy(asc(authFirstPasswordChallenges.expiresAt), asc(authFirstPasswordChallenges.challengeHash))
      .limit(FIRST_PASSWORD_SCRUB_BATCH_SIZE);
    let scrubbed = 0;
    for (const candidate of candidates) {
      if (!(await withinBudget())) break;
      // A correlation binding may now belong to a later account. Observe it,
      // lock both fixed old UID and current selected UID in sorted order, then
      // lock/reread the binding before acquiring intent/challenge locks.
      const [observedBinding] = await transaction
        .select({ userId: authBrowserBindings.userId })
        .from(authBrowserBindings)
        .where(eq(authBrowserBindings.id, candidate.bindingId));
      const userIds = [
        ...new Set([candidate.userId, ...(observedBinding?.userId ? [observedBinding.userId] : [])]),
      ].sort();
      const presentUsers = await transaction.select({ id: users.id }).from(users).where(inArray(users.id, userIds));
      const lockedUsers = await transaction
        .select({ id: users.id })
        .from(users)
        .where(inArray(users.id, userIds))
        .orderBy(asc(users.id))
        .for('update', { skipLocked: true });
      if (!presentUsers.some((user) => user.id === candidate.userId) || lockedUsers.length !== presentUsers.length)
        continue;
      if (!(await withinBudget())) break;
      const [binding] = await transaction
        .select({ userId: authBrowserBindings.userId })
        .from(authBrowserBindings)
        .where(eq(authBrowserBindings.id, candidate.bindingId))
        .for('update', { skipLocked: true });
      if (observedBinding && (!binding || binding.userId !== observedBinding.userId)) continue;
      if (!(await withinBudget())) break;
      const [observedIntent] = await transaction
        .select({ id: authBrowserIntents.id })
        .from(authBrowserIntents)
        .where(eq(authBrowserIntents.id, candidate.intentId));
      const [intent] = await transaction
        .select({ id: authBrowserIntents.id })
        .from(authBrowserIntents)
        .where(eq(authBrowserIntents.id, candidate.intentId))
        .for('update', { skipLocked: true });
      if (observedIntent && !intent) continue;
      if (!(await withinBudget())) break;
      const [challenge] = await transaction
        .select()
        .from(authFirstPasswordChallenges)
        .where(eq(authFirstPasswordChallenges.challengeHash, candidate.hash))
        .for('update', { skipLocked: true });
      const now = await providerDatabaseNow(transaction);
      if (now.getTime() >= deadline) break;
      if (
        !challenge ||
        challenge.userId !== candidate.userId ||
        challenge.phase !== 'prepared' ||
        challenge.consumedAt !== null ||
        challenge.pendingPasswordHash === null ||
        challenge.expiresAt.getTime() > now.getTime()
      )
        continue;
      await transaction
        .update(authFirstPasswordChallenges)
        .set({
          phase: 'terminal',
          pendingPasswordHash: null,
          preparedAt: null,
          preparationTokenHash: null,
          proposedCredentialHash: null,
          consumedAt: now,
          candidateCredentialHash: null,
          recoveryExpiresAt: null,
        })
        .where(
          and(
            eq(authFirstPasswordChallenges.challengeHash, challenge.challengeHash),
            eq(authFirstPasswordChallenges.phase, 'prepared'),
            isNull(authFirstPasswordChallenges.consumedAt),
            lte(authFirstPasswordChallenges.expiresAt, now),
          ),
        );
      scrubbed++;
    }
    await revalidateIdentityAuthority(transaction, authority);
    return { observed: candidates.length, scrubbed };
  });
}

/** Existing awaited maintenance hook only. Keep a compatible profile configured to drain
 * abandoned preparations after the feature switches off; no content fallback. */
export async function runFirstPasswordPreparationMaintenance(
  input: Readonly<Record<string, string | undefined>> = process.env,
) {
  const environment = Object.freeze({ ...input });
  firstPasswordMode(environment);
  if (
    environment.AUTH_IDENTITY_DATABASE_CONTRACT !== 'private-first-password-v1' &&
    environment.AUTH_IDENTITY_DATABASE_CONTRACT !== 'private-native-handoff-v1' &&
    environment.AUTH_IDENTITY_DATABASE_CONTRACT !== 'private-browser-renewal-v1'
  )
    return { observed: 0, scrubbed: 0 };
  const authority = currentStoreAuthorityConfiguration(environment);
  const database = await getCredentialDatabase('private-first-password-v1');
  return scrubExpiredFirstPasswordPreparations(database, {
    expectedProjectionId: authority.expectedProjectionId,
    expectedNormalizerVersion: authority.expectedNormalizerVersion,
  });
}
