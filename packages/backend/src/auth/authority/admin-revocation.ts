import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { users } from '@boardsesh/db/schema/auth';
import type { AuthorityDatabase } from './adapter';
import { recordSecurityMutation } from '../current-store/security-mutations';
import { lockEnforcedProjection, type ExpectedCurrentStoreAuthority } from '../current-store/foundation-context';

/** Qualified core seam. Shipped operator transports must enforce activation before calling. */
export async function revokeAdministrativeCredentials(
  database: AuthorityDatabase,
  expected: ExpectedCurrentStoreAuthority,
  userId: string,
  expectedGeneration: number,
): Promise<void> {
  await database.transaction(async (transaction) => {
    await lockEnforcedProjection(transaction, expected);
    const [lockedSubject] = await transaction
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, userId))
      .for('update');
    if (!lockedSubject) throw new Error('ACTIVE_SUBJECT_REQUIRED');
    await recordSecurityMutation(transaction, {
      ...expected,
      userId,
      expectedGeneration,
      operationId: randomUUID(),
      kind: 'admin-revocation',
      domains: ['first-party', 'partner'],
    });
  });
}
