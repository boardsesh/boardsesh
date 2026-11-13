import { eq } from 'drizzle-orm';
import { users, authSubjectCutoffs, authSessionDenials } from '@boardsesh/db/schema/auth';
import type { SubjectCutoffState } from '../credential-cutoffs';
import type { CurrentStoreTransaction } from './foundation-context';

/** Same primary transaction, after its subject lock; no separate pool or positive cache. */
export async function readLockedWebSubjectState(
  transaction: CurrentStoreTransaction,
  userId: string,
): Promise<SubjectCutoffState | undefined> {
  const [subject] = await transaction
    .select({
      id: users.id,
      generation: authSubjectCutoffs.generation,
      nativeGeneration: authSubjectCutoffs.nativeGeneration,
      deletedAt: authSubjectCutoffs.deletedAt,
    })
    .from(users)
    .leftJoin(authSubjectCutoffs, eq(authSubjectCutoffs.userId, users.id))
    .where(eq(users.id, userId));
  if (!subject || subject.deletedAt !== null) return undefined;
  const denied = await transaction
    .select({ sessionId: authSessionDenials.sessionId })
    .from(authSessionDenials)
    .where(eq(authSessionDenials.userId, userId));
  return {
    generation: subject.generation ?? 0,
    nativeGeneration: subject.nativeGeneration ?? 0,
    deniedSessionKeys: new Set(denied.map((denial) => denial.sessionId)),
  };
}
