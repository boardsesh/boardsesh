import type { DbInstance } from '@boardsesh/db/client';
import {
  AUTH_PROTOCOL_VERSION,
  type PreEnforcementPasswordCommand,
  type PasswordReply,
} from '@boardsesh/auth-protocol';
import { ACCOUNT_EMAIL_CANDIDATE_LIMIT } from '@boardsesh/auth-protocol/account-email';
import { accountEmailCandidates } from '@boardsesh/db/queries/account-email';
import { users } from '@boardsesh/db/schema/auth';
import { compare } from 'bcryptjs';
import { sql } from 'drizzle-orm';
import type { CurrentStoreTransaction } from './foundation-context';
import { assertFresh, boundSignInLockWaits, claimCommand } from './command-context';
import { capturePreEnforcementContext, revalidatePreEnforcementContext } from './pre-enforcement-context';
import { currentStoreWebPasswordSnapshot, sameCredentialMembers } from './web-password-snapshot';
import { matchCurrentStorePasswordCandidate } from './password-identity';
import { issueVerifiedWebCredentialProof } from './web-credential-proof';

export const PASSWORD_LOGIN_COMMAND_MS = 7_000;
export function requirePasswordLoginBudget(deadline: number): number {
  const remaining = Math.floor(deadline - performance.now());
  if (remaining <= 0) throw new Error('Password authentication unavailable');
  return remaining;
}

async function passwordLoginTransactionSettings(transaction: CurrentStoreTransaction, deadline: number) {
  const remaining = Math.min(5_000, requirePasswordLoginBudget(deadline));
  await transaction.execute(
    sql`SELECT set_config('statement_timeout', ${String(remaining)}, true), set_config('lock_timeout', ${String(Math.min(4_000, remaining))}, true), set_config('transaction_timeout', ${String(remaining)}, true)`,
  );
}

/** Actual password authentication only: no canonical session or identity mutation. */
export async function authenticatePasswordBeforeEnforcement(
  database: DbInstance,
  policyInput: { readonly emailVerificationEnabled: boolean },
  input: PreEnforcementPasswordCommand,
  deadline = performance.now() + PASSWORD_LOGIN_COMMAND_MS,
): Promise<PasswordReply> {
  const { emailVerificationEnabled } = policyInput;
  const { requestId, issuedAt } = input;
  const { email, password } = input.payload;
  requirePasswordLoginBudget(deadline);
  const prepared = await database.transaction(async (transaction) => {
    await passwordLoginTransactionSettings(transaction, deadline);
    const context = await capturePreEnforcementContext(transaction);
    return { context, snapshot: await currentStoreWebPasswordSnapshot(transaction, email) };
  });
  requirePasswordLoginBudget(deadline);
  const candidates = prepared.snapshot.flatMap((candidate) =>
    candidate.passwordHash === null
      ? []
      : [{ userId: candidate.userId, createdAt: candidate.createdAt, passwordHash: candidate.passwordHash }],
  );
  // The handler holds one work slot for the complete command. Comparisons run
  // sequentially within it so a duplicate cohort never stacks bcrypt slices.
  let previous: Promise<unknown> = Promise.resolve();
  const matched = await matchCurrentStorePasswordCandidate(candidates, password, (passwordHash, submittedPassword) => {
    const comparison = previous.then(() => compare(submittedPassword, passwordHash));
    previous = comparison.catch(() => undefined);
    return comparison;
  });
  requirePasswordLoginBudget(deadline);
  const base = { protocolVersion: AUTH_PROTOCOL_VERSION, operation: 'password', requestId } as const;
  return database.transaction(async (transaction) => {
    await passwordLoginTransactionSettings(transaction, deadline);
    await revalidatePreEnforcementContext(transaction, prepared.context);
    if (!(await claimCommand(transaction, { operation: 'password', requestId, issuedAt })))
      return { ...base, outcome: 'error', code: 'replayed' };
    assertFresh(issuedAt);
    if (!matched) return { ...base, outcome: 'invalid_credentials' };
    await boundSignInLockWaits(transaction);
    await transaction
      .select({ id: users.id })
      .from(users)
      .where(accountEmailCandidates(email))
      .orderBy(users.id)
      .limit(ACCOUNT_EMAIL_CANDIDATE_LIMIT + 1)
      .for('key share');
    // A separate statement must see a reset that committed while KEY SHARE waited.
    const current = await currentStoreWebPasswordSnapshot(transaction, email);
    const selected = current.find((candidate) => candidate.userId === matched.userId);
    assertFresh(issuedAt);
    if (!selected || selected.deleted || !sameCredentialMembers(prepared.snapshot, current))
      return { ...base, outcome: 'invalid_credentials' };
    const credentialProof = await issueVerifiedWebCredentialProof(transaction, selected.userId, selected.generation);
    await revalidatePreEnforcementContext(transaction, prepared.context);
    assertFresh(issuedAt);
    requirePasswordLoginBudget(deadline);
    return {
      ...base,
      outcome: 'authenticated',
      credentialProof,
      user: { id: selected.userId, email: selected.email, name: selected.name, image: selected.image },
      verification: {
        userId: selected.userId,
        required: emailVerificationEnabled,
        verified: selected.emailVerified !== null,
      },
    };
  });
}
