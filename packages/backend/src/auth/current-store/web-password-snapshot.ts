import { ACCOUNT_EMAIL_CANDIDATE_LIMIT, resolveAccountEmail } from '@boardsesh/auth-protocol/account-email';
import { accountEmailCandidates } from '@boardsesh/db/queries/account-email';
import { authSubjectCutoffs, userCredentials, users } from '@boardsesh/db/schema/auth';
import { and, eq, inArray } from 'drizzle-orm';
import type { CurrentStoreTransaction } from './foundation-context';
import { MAX_CURRENT_STORE_PASSWORD_CANDIDATES } from './password-identity';

export interface WebPasswordCandidate {
  readonly userId: string;
  readonly email: string;
  readonly name: string | null;
  readonly image: string | null;
  readonly createdAt: Date;
  readonly emailVerified: Date | null;
  readonly passwordHash: string | null;
  readonly generation: number;
  readonly deleted: boolean;
}

export async function currentStoreWebPasswordSnapshot(
  transaction: CurrentStoreTransaction,
  email: string,
  lockedIds?: readonly string[],
): Promise<WebPasswordCandidate[]> {
  const rows = await transaction
    .select({
      userId: users.id,
      email: users.email,
      name: users.name,
      image: users.image,
      createdAt: users.createdAt,
      emailVerified: users.emailVerified,
      passwordHash: userCredentials.passwordHash,
      generation: authSubjectCutoffs.generation,
      deletedAt: authSubjectCutoffs.deletedAt,
    })
    .from(users)
    .leftJoin(userCredentials, eq(userCredentials.userId, users.id))
    .leftJoin(authSubjectCutoffs, eq(authSubjectCutoffs.userId, users.id))
    .where(
      lockedIds ? and(accountEmailCandidates(email), inArray(users.id, [...lockedIds])) : accountEmailCandidates(email),
    )
    .orderBy(users.id)
    .limit(ACCOUNT_EMAIL_CANDIDATE_LIMIT + 1);
  return resolveAccountEmail(email, rows).rows.map((candidate) => ({
    ...candidate,
    createdAt: new Date(candidate.createdAt.getTime()),
    generation: candidate.generation ?? 0,
    deleted: candidate.deletedAt !== null,
  }));
}

export function sameCredentialMembers(before: readonly WebPasswordCandidate[], after: readonly WebPasswordCandidate[]) {
  if (before.length !== after.length || before.length > MAX_CURRENT_STORE_PASSWORD_CANDIDATES) return false;
  const previousById = new Map(before.map((candidate) => [candidate.userId, candidate]));
  return after.every((candidate) => {
    const previous = previousById.get(candidate.userId);
    return (
      previous &&
      previous.email === candidate.email &&
      previous.passwordHash === candidate.passwordHash &&
      previous.generation === candidate.generation &&
      previous.deleted === candidate.deleted
    );
  });
}
