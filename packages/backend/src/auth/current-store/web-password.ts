import { createHash, randomUUID } from 'node:crypto';
import type { DbInstance } from '@boardsesh/db/client';
import {
  AUTH_COMMAND_FUTURE_SKEW_MS,
  AUTH_COMMAND_MAX_AGE_MS,
  AUTH_COMMAND_TIMEOUT_MS,
  REGISTRATION_VALIDATION_MESSAGES,
  type PasswordCommand,
  type PasswordReply,
  type RegisterCommand,
  type RegisterReply,
} from '@boardsesh/auth-protocol';
import {
  authEmailReservations,
  authSubjectCutoffs,
  userCredentials,
  users,
  verificationTokens,
} from '@boardsesh/db/schema/auth';
import { eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { normalizeAccountEmail } from '../normalize-email';
import { reserveEnforcedEmail } from './email-reservations';
import {
  captureExpectedAuthority,
  lockEnforcedProjection,
  type CurrentStoreTransaction,
  type ExpectedCurrentStoreAuthority,
} from './foundation-context';
import {
  insertCurrentStorePasswordIdentity,
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

export interface WebPasswordAuthority extends ExpectedCurrentStoreAuthority {
  readonly emailVerificationEnabled: boolean;
}

export class WebPasswordCommandError extends Error {
  constructor(readonly code: 'expired_request') {
    super('Current-store command expired');
    this.name = 'WebPasswordCommandError';
  }
}

function captureAuthority(authority: WebPasswordAuthority): WebPasswordAuthority {
  return { ...captureExpectedAuthority(authority), emailVerificationEnabled: authority.emailVerificationEnabled };
}

function isFresh(issuedAt: number) {
  const now = Date.now();
  return (
    Number.isSafeInteger(issuedAt) &&
    issuedAt >= 0 &&
    issuedAt <= now + AUTH_COMMAND_FUTURE_SKEW_MS &&
    now - issuedAt <= AUTH_COMMAND_MAX_AGE_MS
  );
}

function assertFresh(issuedAt: number) {
  if (!isFresh(issuedAt)) throw new WebPasswordCommandError('expired_request');
}

export function isWebPasswordCommandFresh(issuedAt: number): boolean {
  return isFresh(issuedAt);
}

async function transactionSettings(transaction: CurrentStoreTransaction) {
  await transaction.execute(sql`SET LOCAL statement_timeout = '5000ms'`);
  await transaction.execute(sql`SET LOCAL lock_timeout = '4000ms'`);
}

/** No bcrypt work inside this short-lived global gate. Rechecked at commit. */
async function preflight(database: DbInstance, authority: WebPasswordAuthority) {
  await database.transaction(async (transaction) => {
    await transactionSettings(transaction);
    await lockEnforcedProjection(transaction, authority);
  });
}

async function claimCommand(
  transaction: CurrentStoreTransaction,
  command: { readonly operation: 'register' | 'password'; readonly requestId: string; readonly issuedAt: number },
) {
  assertFresh(command.issuedAt);
  const commandHash = createHash('sha256').update(`${command.operation}\0${command.requestId}`).digest('hex');
  const claimed = await transaction
    .insert(verificationTokens)
    .values({
      identifier: `ba03-web-auth:${commandHash}`,
      token: commandHash,
      expires: new Date(
        command.issuedAt + AUTH_COMMAND_MAX_AGE_MS + AUTH_COMMAND_FUTURE_SKEW_MS + AUTH_COMMAND_TIMEOUT_MS,
      ),
    })
    .onConflictDoNothing()
    .returning({ token: verificationTokens.token });
  return claimed.length === 1;
}

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
    if (!claimed) return { operation: 'register', requestId, outcome: 'error', code: 'replayed' };
    if (!registration || invalidMessage)
      return {
        operation: 'register',
        requestId,
        outcome: 'error',
        code: 'validation_error',
        message: invalidMessage ?? 'Invalid input: expected object, received undefined',
      };
    const [existing] = await transaction
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, registration.email))
      .limit(1);
    const [reservation] = await transaction
      .select()
      .from(authEmailReservations)
      .where(eq(authEmailReservations.normalizedEmail, normalizeAccountEmail(registration.email)))
      .for('update');
    assertFresh(issuedAt);
    // Every occupied normalized key is unavailable to a newly generated ID;
    // there is no existing-user takeover or collision-owner selection.
    if (!prepared || existing || reservation)
      return { operation: 'register', requestId, outcome: 'error', code: 'exists' };
    const userId = randomUUID();
    await reserveEnforcedEmail(transaction, { ...authority, requestedUserId: userId, rawEmail: registration.email });
    const identity = await insertCurrentStorePasswordIdentity(
      transaction,
      prepared,
      authority.emailVerificationEnabled,
      userId,
    );
    assertFresh(issuedAt);
    if (!authority.emailVerificationEnabled)
      return {
        operation: 'register',
        requestId,
        outcome: 'created',
        userId,
        createdAt: identity.createdAt.toISOString(),
        requiresVerification: false,
      };
    const token = randomUUID();
    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await transaction.insert(verificationTokens).values({ identifier: registration.email, token, expires });
    assertFresh(issuedAt);
    return {
      operation: 'register',
      requestId,
      outcome: 'created',
      userId,
      createdAt: identity.createdAt.toISOString(),
      requiresVerification: true,
      mailPlan: {
        recipient: registration.email,
        identifier: registration.email,
        token,
        expiresAt: expires.toISOString(),
      },
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

async function exactSnapshot(database: DbInstance, email: string): Promise<ExactCandidate[]> {
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
    .where(eq(users.email, email))
    .orderBy(users.id)
    .limit(MAX_CURRENT_STORE_PASSWORD_CANDIDATES + 1);
  return rows.map((candidate) => ({
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
  const snapshot = await exactSnapshot(database, email);
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
    if (!claimed) return { operation: 'password', requestId, outcome: 'error', code: 'replayed' };
    // Manifest → users → credentials → cutoffs. Other participating commands
    // must take the same gate first; old writers are explicitly NOT assumed so.
    const currentUsers = await transaction
      .select()
      .from(users)
      .where(eq(users.email, email))
      .orderBy(users.id)
      .limit(MAX_CURRENT_STORE_PASSWORD_CANDIDATES + 1)
      .for('update');
    const userIds = currentUsers.map((user) => user.id);
    const currentCredentials = userIds.length
      ? await transaction
          .select()
          .from(userCredentials)
          .where(inArray(userCredentials.userId, userIds))
          .orderBy(userCredentials.userId)
          .for('update')
      : [];
    const currentCutoffs = userIds.length
      ? await transaction
          .select()
          .from(authSubjectCutoffs)
          .where(inArray(authSubjectCutoffs.userId, userIds))
          .orderBy(authSubjectCutoffs.userId)
          .for('update')
      : [];
    const hashes = new Map(currentCredentials.map((credential) => [credential.userId, credential.passwordHash]));
    const cutoffs = new Map(currentCutoffs.map((cutoff) => [cutoff.userId, cutoff]));
    const current: ExactCandidate[] = currentUsers.map((user) => ({
      userId: user.id,
      email: user.email,
      name: user.name,
      image: user.image,
      createdAt: user.createdAt,
      passwordHash: hashes.get(user.id) ?? null,
      generation: cutoffs.get(user.id)?.generation ?? 0,
      deleted: cutoffs.get(user.id)?.deletedAt != null,
    }));
    const selected = matched ? currentUsers.find((user) => user.id === matched.userId) : undefined;
    assertFresh(issuedAt);
    if (!selected || !sameCredentialMembers(snapshot, current) || cutoffs.get(selected.id)?.deletedAt)
      return { operation: 'password', requestId, outcome: 'invalid_credentials' };
    return {
      operation: 'password',
      requestId,
      outcome: 'authenticated',
      user: { id: selected.id, email: selected.email, name: selected.name, image: selected.image },
      verification: {
        userId: selected.id,
        required: authority.emailVerificationEnabled,
        verified: selected.emailVerified !== null,
      },
    };
  });
}
