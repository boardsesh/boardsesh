import { issueWebCredentialProof } from './web-credential-proof';
import type { DbInstance } from '@boardsesh/db/client';
import {
  AUTH_PROTOCOL_VERSION,
  REGISTRATION_VALIDATION_MESSAGES,
  type PasswordCommand,
  type PasswordReply,
  type RegisterCommand,
  type RegisterReply,
  type WebSessionRequest,
} from '@boardsesh/auth-protocol';
import {
  ACCOUNT_EMAIL_CANDIDATE_LIMIT,
  normalizeAccountEmail,
  resolveAccountEmail,
} from '@boardsesh/auth-protocol/account-email';
import { accountEmailCandidates } from '@boardsesh/db/queries/account-email';
import { authSubjectCutoffs, userCredentials, users } from '@boardsesh/db/schema/auth';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { CurrentStoreFoundationError } from './foundation-context';
import {
  compareStoredPassword,
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
  transactionSettings,
  claimCommand,
  type WebPasswordAuthority,
} from './command-context';
import { issueEmailVerification } from './email-verification';
import { insertReservedPasswordIdentity } from './reserved-password-registration';
import type { CurrentStoreTransaction } from './foundation-context';
import {
  captureIdentityAuthority,
  revalidateIdentityAuthority,
  type IdentityAuthorityReceipt,
} from '../authority/router';
import { bindIdentityAuthority } from '../authority/identity-authority';
import { verifyAuthorityPassword } from '../authority/authority';
import { readFirstPartySession, type FirstPartyCredential, type FirstPartySession } from '../authority/session-reader';
import { issueWebSession, lockWebSessionAccounts } from '../authority/web-session';
import { readLockedWebSubjectState } from './web-credential-state';

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
  const configuredAuthority = captureAuthority(authorityInput);
  const { requestId, issuedAt } = input;
  const validation = registrationSchema.safeParse(input.payload);
  // Stored in the one normalized form (BA-02), as native registration stores it.
  const registration = validation.success
    ? { ...validation.data, email: normalizeAccountEmail(validation.data.email) }
    : undefined;
  const invalidMessage = validation.success ? undefined : validationMessage(validation.error.issues[0].message);
  const receipt = await database.transaction(async (transaction) => {
    await transactionSettings(transaction);
    return captureIdentityAuthority(transaction, configuredAuthority);
  });
  const authority = { ...configuredAuthority, expectedWriterEpoch: receipt.epoch };
  // The any-capitalisation precheck and bcrypt12 are shared with native; the final
  // transaction still checks ownership/reservation before every insert.
  const prepared = registration ? await prepareCurrentStorePasswordRegistration(database, registration) : null;
  return database.transaction(async (transaction): Promise<RegisterReply> => {
    await transactionSettings(transaction);
    await revalidateIdentityAuthority(transaction, receipt);
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
    const inserted = await insertReservedPasswordIdentity(
      transaction,
      authority,
      {
        email: registration.email,
        prepared,
        emailVerificationEnabled: authority.emailVerificationEnabled,
      },
      receipt,
    );
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
    await revalidateIdentityAuthority(transaction, receipt);
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
    await revalidateIdentityAuthority(transaction, receipt);
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

interface WebPasswordCandidate {
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

/**
 * The accounts a typed address names: rows storing it exactly, else the one
 * row storing it in other capitals. Several such rows name nobody.
 */
async function addressSnapshot(
  transaction: CurrentStoreTransaction,
  email: string,
  receipt: IdentityAuthorityReceipt,
  lockedIds?: readonly string[],
): Promise<WebPasswordCandidate[]> {
  const fields = {
    userId: users.id,
    email: users.email,
    name: users.name,
    image: users.image,
    createdAt: users.createdAt,
    emailVerified: users.emailVerified,
    generation: authSubjectCutoffs.generation,
    deletedAt: authSubjectCutoffs.deletedAt,
  };
  const predicate = lockedIds
    ? and(accountEmailCandidates(email), inArray(users.id, [...lockedIds]))
    : accountEmailCandidates(email);
  // Legacy takes hash+generation in one SELECT. Canonical takes both from the
  // actual adapter account SELECT below; the legacy table is never its source.
  const rows =
    receipt.authority === 'current-store'
      ? await transaction
          .select({ ...fields, passwordHash: userCredentials.passwordHash })
          .from(users)
          .leftJoin(userCredentials, eq(userCredentials.userId, users.id))
          .leftJoin(authSubjectCutoffs, eq(authSubjectCutoffs.userId, users.id))
          .where(predicate)
          .orderBy(users.id)
          .limit(ACCOUNT_EMAIL_CANDIDATE_LIMIT + 1)
      : await transaction
          .select({ ...fields, passwordHash: sql<string | null>`NULL` })
          .from(users)
          .leftJoin(authSubjectCutoffs, eq(authSubjectCutoffs.userId, users.id))
          .where(predicate)
          .orderBy(users.id)
          .limit(ACCOUNT_EMAIL_CANDIDATE_LIMIT + 1);
  if (
    receipt.authority === 'better-auth' &&
    rows.some((candidate) => candidate.email !== normalizeAccountEmail(candidate.email))
  )
    throw new CurrentStoreFoundationError('RESERVATION_INCONSISTENT');
  const resolved = resolveAccountEmail(email, rows).rows;
  const snapshot: WebPasswordCandidate[] = [];
  const identity = bindIdentityAuthority(transaction, receipt);
  for (const candidate of resolved) {
    const credential = receipt.authority === 'better-auth' ? await identity.readPassword(candidate.userId) : undefined;
    if (credential && credential.generation !== (candidate.generation ?? 0))
      throw new CurrentStoreFoundationError('STALE_GENERATION');
    snapshot.push({
      ...candidate,
      createdAt: new Date(candidate.createdAt.getTime()),
      passwordHash: receipt.authority === 'better-auth' ? (credential?.passwordHash ?? null) : candidate.passwordHash,
      generation: credential?.generation ?? candidate.generation ?? 0,
      deleted: candidate.deletedAt !== null,
    });
  }
  return snapshot;
}

function sameCredentialMembers(before: readonly WebPasswordCandidate[], after: readonly WebPasswordCandidate[]) {
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

/** Private verifier state; never serialize the candidate hashes or password. */
interface PreparedWebPasswordAuthentication {
  readonly receipt: IdentityAuthorityReceipt;
  readonly email: string;
  readonly snapshot: readonly WebPasswordCandidate[];
  readonly matchedUserId: string | null;
}

/**
 * Runs one sign-in's whole group of compares in a single turn. The staged
 * password command passes its process-wide gate.
 */
export type PasswordCompareSlot = <Result>(compares: () => Promise<Result>) => Promise<Result>;

type PasswordVerifier = (passwordHash: string, submittedPassword: string) => Promise<boolean>;

/** The group's compares one after another, so a slot never stacks bcrypt slices. */
function oneAtATime(verify: PasswordVerifier): PasswordVerifier {
  let previous: Promise<unknown> = Promise.resolve();
  return (passwordHash, submittedPassword) => {
    const result = previous.then(() => verify(passwordHash, submittedPassword));
    previous = result.catch(() => undefined);
    return result;
  };
}

/** Compares the password before any user lock is taken. */
async function prepareWebPasswordAuthentication(
  database: DbInstance,
  authority: WebPasswordAuthority,
  email: string,
  password: string,
  compareSlot?: PasswordCompareSlot,
): Promise<PreparedWebPasswordAuthentication> {
  const prepared = await database.transaction(async (transaction) => {
    await transactionSettings(transaction);
    const receipt = await captureIdentityAuthority(transaction, authority);
    return { receipt, snapshot: await addressSnapshot(transaction, email, receipt) };
  });
  const credentialCandidates = prepared.snapshot.flatMap((candidate) =>
    candidate.passwordHash === null
      ? []
      : [{ userId: candidate.userId, createdAt: candidate.createdAt, passwordHash: candidate.passwordHash }],
  );
  const authorityVerify: PasswordVerifier | undefined =
    prepared.receipt.authority === 'better-auth'
      ? (passwordHash, submittedPassword) =>
          verifyAuthorityPassword({ hash: passwordHash, password: submittedPassword })
      : undefined;
  // In a slot, the whole group (an address several accounts share, or the
  // stand-in for an unknown one) takes one turn, so it is never partly shed and
  // load cannot answer a shared address differently from an unknown one.
  const matched = compareSlot
    ? await compareSlot(() =>
        matchCurrentStorePasswordCandidate(
          credentialCandidates,
          password,
          oneAtATime(authorityVerify ?? compareStoredPassword),
        ),
      )
    : await matchCurrentStorePasswordCandidate(credentialCandidates, password, authorityVerify);
  return { ...prepared, email, matchedUserId: matched?.userId ?? null };
}

/** A no-match request takes no user lock. */
async function lockWebPasswordAuthentication(
  transaction: CurrentStoreTransaction,
  prepared: PreparedWebPasswordAuthentication,
  presentedUserId?: string,
): Promise<WebPasswordCandidate | null> {
  if (prepared.matchedUserId === null) return null;
  await boundSignInLockWaits(transaction);
  // A login that revokes a presented session also holds that account FOR
  // UPDATE. Take every row in users.id order with its final strength now, so
  // no row is upgraded later and two crossed logins queue instead of
  // deadlocking. The statement below then only re-takes rows already held,
  // plus any candidate that appeared since this read.
  if (presentedUserId !== undefined)
    await lockWebSessionAccounts(
      transaction,
      accountEmailCandidates(prepared.email),
      presentedUserId,
      ACCOUNT_EMAIL_CANDIDATE_LIMIT + 1,
    );
  const lockedUsers = await transaction
    .select({ id: users.id })
    .from(users)
    .where(accountEmailCandidates(prepared.email))
    .orderBy(users.id)
    .limit(ACCOUNT_EMAIL_CANDIDATE_LIMIT + 1)
    .for('key share');
  // A later statement sees a reset that committed while the lock was waiting.
  const current = lockedUsers.length
    ? await addressSnapshot(
        transaction,
        prepared.email,
        prepared.receipt,
        lockedUsers.map((user) => user.id),
      )
    : [];
  const selected = current.find((candidate) => candidate.userId === prepared.matchedUserId);
  return selected && sameCredentialMembers(prepared.snapshot, current) && !selected.deleted ? selected : null;
}

/**
 * The session the login arrived with, read in this transaction. One that no
 * longer reads as live needs no revocation; an unreadable store fails the login.
 *
 * A login revokes only a session it can name: a canonical row or a legacy
 * cookie with its own session id. A legacy cookie without one could only be
 * ended by cutting off its whole account (every session and every phone), so
 * it is left alone and the login goes ahead (#7596 review of #7722, finding 1).
 * The subject state is read before the user lock is taken; both ways it can
 * be used (an idempotent SID denial, or nothing) stay correct under the lock.
 */
async function readPresentedSession(
  transaction: CurrentStoreTransaction,
  request: WebSessionRequest,
  now: Date,
): Promise<FirstPartySession | undefined> {
  const { presented } = request;
  if (!presented) return undefined;
  let credential: FirstPartyCredential;
  if (presented.kind === 'canonical-token') credential = { kind: 'canonical-token', token: presented.token };
  else {
    const secret = process.env.NEXTAUTH_SECRET;
    if (!secret) throw new Error('Web session authority unavailable');
    credential = { kind: 'legacy-jwe', credential: presented.credential, secret };
  }
  const outcome = await readFirstPartySession(transaction, credential, now, (userId) =>
    readLockedWebSubjectState(transaction, userId),
  );
  if (outcome.status === 'unavailable') throw new Error('Web session authority unavailable');
  if (outcome.status !== 'admitted' || outcome.session.requiresAccountCutoff) return undefined;
  return outcome.session;
}

/**
 * One-request password/UID verification snapshot. With `webSession` (its mode
 * checked by the transport), it also issues a first-party web session for the
 * verified account and revokes the presented one, in the same transaction.
 */
export async function authenticateWebPassword(
  database: DbInstance,
  authorityInput: WebPasswordAuthority,
  input: PasswordCommand,
  compareSlot?: PasswordCompareSlot,
): Promise<PasswordReply> {
  if (process.env.DEBUG_SQL === 'true') throw new Error('Web authentication unavailable');
  const configuredAuthority = captureAuthority(authorityInput);
  const { requestId, issuedAt, credentialProofVersion } = input;
  const { email, password } = input.payload;
  const prepared = await prepareWebPasswordAuthentication(database, configuredAuthority, email, password, compareSlot);
  const { receipt } = prepared;
  const authority = { ...configuredAuthority, expectedWriterEpoch: receipt.epoch };
  return database.transaction(async (transaction): Promise<PasswordReply> => {
    await transactionSettings(transaction);
    await revalidateIdentityAuthority(transaction, receipt);
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
    if (prepared.matchedUserId === null) {
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
    // conflict, so a plain sign-in never waits for one. A login that revokes a
    // presented session takes that account FOR UPDATE, which does wait for such
    // a write and may answer unavailable after 250 ms; the web retries. No other climber's command
    // shares a lock with this one. Old writers are explicitly NOT assumed to
    // take the gate or the user lock. A held row is given up on after 250 ms
    // and answered unavailable, never as a wrong password.
    // BA-02: the lock covers every row the address rule could name (the typed
    // text and its other capitals), still in users.id order.
    const now = new Date();
    const presented = input.webSession ? await readPresentedSession(transaction, input.webSession, now) : undefined;
    const selected = await lockWebPasswordAuthentication(transaction, prepared, presented?.userId);
    assertFresh(issuedAt);
    if (!selected)
      return {
        protocolVersion: AUTH_PROTOCOL_VERSION,
        operation: 'password',
        requestId,
        outcome: 'invalid_credentials',
      };
    // The web refuses a sign-in that still needs email verification, so no
    // session is issued for it and the presented one stays.
    const webSession =
      input.webSession && !(authority.emailVerificationEnabled && selected.emailVerified === null)
        ? await issueWebSession(transaction, {
            userId: selected.userId,
            authenticatedAt: now,
            presented,
            now,
            authority: receipt,
          })
        : undefined;
    // The proof comes after the session. A cookie minted from it must carry the
    // session's generation, or it would die before the session does; a login
    // never moves the generation, so a difference here is a bug, not a race.
    const credentialProof = await issueWebCredentialProof(
      transaction,
      selected.userId,
      credentialProofVersion,
      selected.generation,
    );
    if (webSession && credentialProof && credentialProof.generation !== webSession.generation)
      throw new Error('Web credential proof and web session disagree');
    await revalidateIdentityAuthority(transaction, receipt);
    // Past the command's age limit nobody waits for the token: roll the new session back.
    if (webSession) assertFresh(issuedAt);
    return {
      protocolVersion: AUTH_PROTOCOL_VERSION,
      operation: 'password',
      requestId,
      outcome: 'authenticated',
      ...(credentialProof ? { credentialProof } : {}),
      ...(webSession
        ? {
            webSession: {
              sessionId: webSession.sessionId,
              token: webSession.token,
              expiresAt: webSession.expiresAt.toISOString(),
              generation: webSession.generation,
            },
          }
        : {}),
      user: { id: selected.userId, email: selected.email, name: selected.name, image: selected.image },
      verification: {
        userId: selected.userId,
        required: authority.emailVerificationEnabled,
        verified: selected.emailVerified !== null,
      },
    };
  });
}
