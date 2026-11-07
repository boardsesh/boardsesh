import { and, eq, inArray, isNull } from 'drizzle-orm';
import { users, authSubjectCutoffs } from '@boardsesh/db/schema/auth';
import { db, type Database } from '../db/client';
import { requireReadCommitted } from './current-store/foundation-context';

import {
  AuthAdmissionUnavailableError,
  AUTH_ADMISSION_BATCH_SIZE,
  runAuthAdmissionRead,
} from './admission-read-runner';
export {
  AuthAdmissionUnavailableError,
  AUTH_ADMISSION_RESPONSE_DEADLINE_MS,
  AUTH_ADMISSION_BATCH_SIZE,
  MAX_UNSETTLED_AUTH_ADMISSION_READS,
  isAuthAdmissionUnavailable,
  runAuthAdmissionRead,
} from './admission-read-runner';

export class AuthSubjectDeniedError extends Error {
  constructor() {
    super('Authentication is required');
    this.name = 'AuthSubjectDeniedError';
  }
}

type AdmissionTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];
/** Fresh primary admission only. A generation or JWT issue time is not deletion. */
export async function isHumanSubjectActive(userId: string): Promise<boolean> {
  if (!userId) return false;
  return runAuthAdmissionRead(async () => {
    const [subject] = await db
      .select({ id: users.id, deletedAt: authSubjectCutoffs.deletedAt })
      .from(users)
      .leftJoin(authSubjectCutoffs, eq(authSubjectCutoffs.userId, users.id))
      .where(eq(users.id, userId))
      .limit(1);
    return Boolean(subject && subject.deletedAt === null);
  });
}

/** One bounded primary read for an active-connection sweep, never a result cache. */
export async function activeHumanSubjectIds(userIds: readonly string[]): Promise<ReadonlySet<string>> {
  const requestedIds = [...new Set(userIds)];
  if (!requestedIds.length) return new Set();
  if (requestedIds.length > AUTH_ADMISSION_BATCH_SIZE) throw new AuthAdmissionUnavailableError();
  return runAuthAdmissionRead(async () => {
    const subjects = await db
      .select({ id: users.id })
      .from(users)
      .leftJoin(authSubjectCutoffs, eq(authSubjectCutoffs.userId, users.id))
      .where(and(inArray(users.id, requestedIds), isNull(authSubjectCutoffs.deletedAt)));
    return new Set(subjects.map((subject) => subject.id));
  });
}

/**
 * Issuance must own this transaction. Lock the user before refresh/account
 * child rows; never put the bounded read response race around a write.
 */
export async function requireHumanSubjectForIssuance(transaction: AdmissionTransaction, userId: string): Promise<void> {
  try {
    await requireReadCommitted(transaction);
    const [subject] = await transaction
      .select({ id: users.id, deletedAt: authSubjectCutoffs.deletedAt })
      .from(users)
      .leftJoin(authSubjectCutoffs, eq(authSubjectCutoffs.userId, users.id))
      .where(eq(users.id, userId))
      .limit(1)
      .for('key share', { of: users });
    if (!subject || subject.deletedAt !== null) throw new AuthSubjectDeniedError();
  } catch (error) {
    if (error instanceof AuthSubjectDeniedError) throw error;
    throw new AuthAdmissionUnavailableError();
  }
}
