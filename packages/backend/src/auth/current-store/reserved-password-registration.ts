import { randomUUID } from 'node:crypto';
import { authEmailReservations, users } from '@boardsesh/db/schema/auth';
import { eq, sql } from 'drizzle-orm';
import { normalizeAccountEmail } from '../normalize-email';
import { reserveEnforcedEmail } from './email-reservations';
import {
  captureExpectedAuthority,
  CurrentStoreFoundationError,
  lockEnforcedProjection,
  type CurrentStoreTransaction,
  type ExpectedCurrentStoreAuthority,
} from './foundation-context';
import { insertCurrentStorePasswordIdentity, type PreparedPasswordRegistration } from './password-identity';

/**
 * Prewrite conflicts are returned so an RPC caller can commit its negative
 * outcome/nonce. All SQL and trust failures must abort the outer transaction.
 */
export async function insertReservedPasswordIdentity(
  transaction: CurrentStoreTransaction,
  authorityInput: ExpectedCurrentStoreAuthority,
  options: {
    readonly email: string;
    readonly prepared: PreparedPasswordRegistration | null;
    readonly emailVerificationEnabled: boolean;
  },
): Promise<{ outcome: 'exists' } | { outcome: 'created'; identity: { userId: string; createdAt: Date } }> {
  const authority = captureExpectedAuthority(authorityInput);
  const { email, emailVerificationEnabled } = options;
  const prepared = options.prepared ? { ...options.prepared } : null;
  const key = normalizeAccountEmail(email);
  const manifest = await lockEnforcedProjection(transaction, authority);
  const [reservation] = await transaction
    .select()
    .from(authEmailReservations)
    .where(eq(authEmailReservations.normalizedEmail, key))
    .for('update');
  if (reservation) {
    if (reservation.basisProjectionId !== manifest.projectionId)
      throw new CurrentStoreFoundationError('STALE_AUTHORITY');
    return { outcome: 'exists' };
  }
  // Match the normalized key, as login does: the same mailbox in another case
  // must not slip past this and become the key's sole owner.
  const [existing] = await transaction
    .select({ id: users.id })
    .from(users)
    .where(sql`LOWER(${users.email}) = ${key}`)
    .limit(1);
  // An existing row without a reservation is an incomplete authority,
  // not evidence that the staged writer may silently use an unfenced precheck.
  if (existing || !prepared || prepared.email !== email)
    throw new CurrentStoreFoundationError('RESERVATION_INCONSISTENT');
  const userId = randomUUID();
  await reserveEnforcedEmail(transaction, { ...authority, rawEmail: email, requestedUserId: userId });
  const identity = await insertCurrentStorePasswordIdentity(transaction, prepared, emailVerificationEnabled, userId);
  return { outcome: 'created', identity };
}
