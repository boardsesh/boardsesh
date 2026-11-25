import { users } from '@boardsesh/db/schema/auth';
import { normalizeAccountEmail } from '../normalize-email';
import {
  CurrentStoreFoundationError,
  lockEmailKeyForCreation,
  type CurrentStoreTransaction,
} from './foundation-context';
import { insertCurrentStorePasswordIdentity, type PreparedPasswordRegistration } from './password-identity';

export {
  capturePreEnforcementContext as captureRegistrationContext,
  revalidatePreEnforcementContext as revalidateRegistrationContext,
  type PreEnforcementContext as RegistrationContext,
} from './pre-enforcement-context';
import {
  revalidatePreEnforcementContext as revalidateRegistrationContext,
  type PreEnforcementContext as RegistrationContext,
} from './pre-enforcement-context';

/**
 * Web and installed native registration share this write boundary. The precheck
 * before bcrypt is only an optimization: this locked check decides ownership.
 * Old OAuth/web replicas that never take the key remain a deployment fence.
 */
export async function insertPreEnforcementPasswordIdentity(
  transaction: CurrentStoreTransaction,
  context: RegistrationContext,
  email: string,
  prepared: PreparedPasswordRegistration | null,
  emailVerificationEnabled: boolean,
) {
  await revalidateRegistrationContext(transaction, context);
  const key = normalizeAccountEmail(email);
  await lockEmailKeyForCreation(transaction, key);
  const holders = await registrationEmailHolders(transaction, key);
  if (holders.length > 0) return { outcome: 'exists' as const };
  if (!prepared || prepared.email !== email) throw new CurrentStoreFoundationError('RESERVATION_INCONSISTENT');
  const identity = await insertCurrentStorePasswordIdentity(transaction, prepared, emailVerificationEnabled);
  await revalidateRegistrationContext(transaction, context);
  return { outcome: 'created' as const, identity };
}

/**
 * Cleanup has not made stored addresses normal yet. Use the same JS rule as
 * preparation, including its complete whitespace and Unicode case semantics.
 * This temporary scan is deliberately not an indexed lower(email) lookup or a
 * prepared snapshot. Registration/resend are infrequent and never log results.
 */
export async function registrationEmailHolders(transaction: CurrentStoreTransaction, normalizedEmail: string) {
  const candidates = await transaction
    .select({ id: users.id, email: users.email, emailVerified: users.emailVerified, createdAt: users.createdAt })
    .from(users);
  return candidates.filter((candidate) => normalizeAccountEmail(candidate.email) === normalizedEmail);
}
