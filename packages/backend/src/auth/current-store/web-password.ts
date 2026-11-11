import type { DbInstance } from '@boardsesh/db/client';
import {
  AUTH_PROTOCOL_VERSION,
  REGISTRATION_VALIDATION_MESSAGES,
  type PasswordCommand,
  type PasswordReply,
  type RegisterCommand,
  type RegisterReply,
} from '@boardsesh/auth-protocol';
import { ACCOUNT_EMAIL_CANDIDATE_LIMIT, resolveAccountEmail } from '@boardsesh/auth-protocol/account-email';
import { accountEmailCandidates } from '@boardsesh/db/queries/account-email';
import { authSubjectCutoffs, userCredentials, users } from '@boardsesh/db/schema/auth';
import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { lockEnforcedProjection, CurrentStoreFoundationError } from './foundation-context';
import {
  matchCurrentStorePasswordCandidate,
  MAX_CURRENT_STORE_PASSWORD_CANDIDATES,
  prepareCurrentStorePasswordRegistration,
} from './password-identity';

// Preserve the legacy WEB schema. Native retains its separate parser; password
// login deliberately does not inherit these registration bounds or trimming.
const registrationSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(128, 'Password must be less than 128 characters'),
  name: z.string().min(1, 'Name is required').max(100, 'Name must be less than 100 characters').optional(),
});

export { WebPasswordCommandError, isWebPasswordCommandFresh, type WebPasswordAuthority } from './command-context';
import {
  captureAuthority,
  assertFresh,
  boundSignInLockWaits,
  preflight,
  transactionSettings,
  claimCommand,
  type WebPasswordAuthority,
} from './command-context';
import { issueEmailVerification } from './email-verification';
import { insertReservedPasswordIdentity } from './reserved-password-registration';

function validationMessage(message: string): (typeof REGISTRATION_VALIDATION_MESSAGES)[number] {
  return (
    REGISTRATION_VALIDATION_MESSAGES.find((allowed) => allowed === message) ??
    'Invalid input: expected object, received undefined'
  );
}

/** Backend creates credential state; the private mail plan is delivery I/O only. */
export async function registerWebPassword(
  database: DbInstance,
  authorityInput: WebPasswordAuthority,
  input: RegisterCommand,
): Promise<RegisterReply> {
  const authority = captureAuthority(authorityInput);
  const { requestId, issuedAt } = input;
  const validation = registrationSchema.safeParse(input.payload);
  const registration = validation.success ? { ...validation.data } : undefined;
  const invalidMessage = validation.success ? undefined : validationMessage(validation.error.issues[0].message);
  await preflight(database, authority);
  // Existing exact precheck and bcrypt12 are shared with native; the final
  // transaction still checks ownership/reservation before every insert.
  const prepared = registration ? await prepareCurrentStorePasswordRegistration(database, registration) : null;
  return database.transaction(async (transaction): Promise<RegisterReply> => {
    await transactionSettings(transaction);
    await lockEnforcedProjection(transaction, authority);
    const claimed = await claimCommand(transaction, { requestId, issuedAt, operation: 'register' });
    assertFresh(issuedAt);
    if (!claimed)
      return {
        protocolVersion: AUTH_PROTOCOL_VERSION,
        operation: 'register',
        requestId,
        outcome: 'error',
        code: 'replayed',
      };
    if (!registration || invalidMessage)
      return {
        protocolVersion: AUTH_PROTOCOL_VERSION,
        operation: 'register',
        requestId,
        outcome: 'error',
        code: 'validation_error',
        message: invalidMessage ?? 'Invalid input: expected object, received undefined',
      };
    const inserted = await insertReservedPasswordIdentity(transaction, authority, {
      email: registration.email,
      prepared,
      emailVerificationEnabled: authority.emailVerificationEnabled,
    });
    assertFresh(issuedAt);
    // Every occupied normalized key is unavailable to a newly generated ID;
    // there is no existing-user takeover or collision-owner selection.
    if (inserted.outcome === 'exists')
      return {
        protocolVersion: AUTH_PROTOCOL_VERSION,
        operation: 'register',
        requestId,
        outcome: 'error',
        code: 'exists',
      };
    const { identity } = inserted;
    const { userId } = identity;
    assertFresh(issuedAt);
    if (!authority.emailVerificationEnabled)
      return {
        protocolVersion: AUTH_PROTOCOL_VERSION,
        operation: 'register',
        requestId,
        outcome: 'created',
        userId,
        createdAt: identity.createdAt.toISOString(),
        requiresVerification: false,
      };
    const mailPlan = await issueEmailVerification(transaction, authority, userId);
    if (!mailPlan) throw new CurrentStoreFoundationError('RESERVATION_INCONSISTENT');
    assertFresh(issuedAt);
    return {
      protocolVersion: AUTH_PROTOCOL_VERSION,
      operation: 'register',
      requestId,
      outcome: 'created',
      userId,
      createdAt: identity.createdAt.toISOString(),
      requiresVerification: true,
      mailPlan,
    };
  });
}

interface ExactCandidate {
  readonly userId: string;
  readonly email: string;
  readonly name: string | null;
  readonly image: string | null;
  readonly createdAt: Date;
  readonly passwordHash: string | null;
  readonly generation: number;
  readonly deleted: boolean;
}

/**
 * The accounts a typed address names: rows storing it exactly, else the one
 * row storing it in other capitals. Several such rows name nobody.
 */
async function addressSnapshot(database: DbInstance, email: string): Promise<ExactCandidate[]> {
  const rows = await database
    .select({
      userId: users.id,
      email: users.email,
      name: users.name,
      image: users.image,
      createdAt: users.createdAt,
      passwordHash: userCredentials.passwordHash,
      generation: authSubjectCutoffs.generation,
      deletedAt: authSubjectCutoffs.deletedAt,
    })
    .from(users)
    .leftJoin(userCredentials, eq(userCredentials.userId, users.id))
    .leftJoin(authSubjectCutoffs, eq(authSubjectCutoffs.userId, users.id))
    .where(accountEmailCandidates(email))
    .orderBy(users.id)
    .limit(ACCOUNT_EMAIL_CANDIDATE_LIMIT + 1);
  return resolveAccountEmail(email, rows).rows.map((candidate) => ({
    ...candidate,
    createdAt: new Date(candidate.createdAt.getTime()),
    generation: candidate.generation ?? 0,
    deleted: candidate.deletedAt !== null,
  }));
}

function sameCredentialMembers(before: readonly ExactCandidate[], after: readonly ExactCandidate[]) {
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

/** One-request password/UID verification snapshot, NOT a continuing credential. */
export async function authenticateWebPassword(
  database: DbInstance,
  authorityInput: WebPasswordAuthority,
  input: PasswordCommand,
): Promise<PasswordReply> {
  const authority = captureAuthority(authorityInput);
  const { requestId, issuedAt } = input;
  const { email, password } = input.payload;
  await preflight(database, authority);
  const snapshot = await addressSnapshot(database, email);
  const credentialCandidates = snapshot.flatMap((candidate) =>
    candidate.passwordHash === null
      ? []
      : [{ userId: candidate.userId, createdAt: candidate.createdAt, passwordHash: candidate.passwordHash }],
  );
  const matched = await matchCurrentStorePasswordCandidate(credentialCandidates, password);
  return database.transaction(async (transaction): Promise<PasswordReply> => {
    await transactionSettings(transaction);
    await lockEnforcedProjection(transaction, authority);
    const claimed = await claimCommand(transaction, { requestId, issuedAt, operation: 'password' });
    assertFresh(issuedAt);
    if (!claimed)
      return {
        protocolVersion: AUTH_PROTOCOL_VERSION,
        operation: 'password',
        requestId,
        outcome: 'error',
        code: 'replayed',
      };
    // A password that matched no one is wrong whatever the rows say now, so it
    // takes no user lock: a burst of wrong guesses naming a held account never
    // waits or holds a pool connection behind it.
    if (!matched) {
      assertFresh(issuedAt);
      return {
        protocolVersion: AUTH_PROTOCOL_VERSION,
        operation: 'password',
        requestId,
        outcome: 'invalid_credentials',
      };
    }
    // Gate, then users FOR KEY SHARE: a sign-in writes no identity row, so it
    // only has to keep every credential writer out until it answers. Every such
    // writer takes users FOR UPDATE first, which KEY SHARE excludes, while the
    // foreign-key KEY SHARE an ordinary write (a logbook sync page) holds does not
    // conflict, so a sign-in never waits for one. No other climber's command
    // shares a lock with this one. Old writers are explicitly NOT assumed to
    // take the gate or the user lock. A held row is given up on after 250 ms
    // and answered unavailable, never as a wrong password.
    // BA-02: the lock covers every row the address rule could name (the typed
    // text and its other capitals), still in users.id order.
    await boundSignInLockWaits(transaction);
    const lockedUsers = await transaction
      .select({ id: users.id })
      .from(users)
      .where(accountEmailCandidates(email))
      .orderBy(users.id)
      .limit(ACCOUNT_EMAIL_CANDIDATE_LIMIT + 1)
      .for('key share');
    // A statement of its own, after the lock: the locking statement's snapshot
    // predates its wait, so only a later one sees a reset that committed during it.
    const reread = lockedUsers.length
      ? (
          await transaction
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
              inArray(
                users.id,
                lockedUsers.map((user) => user.id),
              ),
            )
            .orderBy(users.id)
        ).map((candidate) => ({
          ...candidate,
          generation: candidate.generation ?? 0,
          deleted: candidate.deletedAt !== null,
        }))
      : [];
    // The same address rule as the snapshot, applied to the rows read after the
    // lock, so a change in which accounts the address names refuses below.
    const current = resolveAccountEmail(email, reread).rows;
    const selected = matched ? current.find((candidate) => candidate.userId === matched.userId) : undefined;
    assertFresh(issuedAt);
    if (!selected || !sameCredentialMembers(snapshot, current) || selected.deleted)
      return {
        protocolVersion: AUTH_PROTOCOL_VERSION,
        operation: 'password',
        requestId,
        outcome: 'invalid_credentials',
      };
    return {
      protocolVersion: AUTH_PROTOCOL_VERSION,
      operation: 'password',
      requestId,
      outcome: 'authenticated',
      user: { id: selected.userId, email: selected.email, name: selected.name, image: selected.image },
      verification: {
        userId: selected.userId,
        required: authority.emailVerificationEnabled,
        verified: selected.emailVerified !== null,
      },
    };
  });
}
