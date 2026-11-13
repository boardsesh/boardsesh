import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { users } from '@boardsesh/db/schema/auth';
import type { AuthorityDatabase } from './adapter';
import {
  captureExpectedAuthority,
  lockEnforcedProjection,
  type ExpectedCurrentStoreAuthority,
} from '../current-store/foundation-context';
import { captureIdentityAuthority } from './router';
import { recordIdentitySecurityMutation } from './security-mutation';

/** Qualified core seam. Shipped operator transports must enforce activation before calling. */
export async function revokeAdministrativeCredentials(
  database: AuthorityDatabase,
  expected: ExpectedCurrentStoreAuthority,
  userId: string,
  expectedGeneration: number,
): Promise<void> {
  const capturedAuthority = captureExpectedAuthority(expected);
  await database.transaction(async (transaction) => {
    await lockEnforcedProjection(transaction, capturedAuthority);
    const receipt = await captureIdentityAuthority(transaction, capturedAuthority);
    const [lockedSubject] = await transaction
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, userId))
      .for('update');
    if (!lockedSubject) throw new Error('ACTIVE_SUBJECT_REQUIRED');
    await recordIdentitySecurityMutation(
      transaction,
      {
        ...capturedAuthority,
        userId,
        expectedGeneration,
        operationId: randomUUID(),
        kind: 'admin-revocation',
        domains: ['first-party', 'partner'],
      },
      receipt,
    );
  });
}
