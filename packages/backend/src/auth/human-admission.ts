import { and, eq, inArray, isNull } from 'drizzle-orm';
import { users, authSubjectCutoffs, userCredentials } from '@boardsesh/db/schema/auth';
import type { Database } from '../db/client';
import { logger } from '../utils/logger';
import { readOnAdmissionConnection } from './admission-pool';
import { requireReadCommitted } from './current-store/foundation-context';
import {
  cutoffEnforcement,
  isCredentialAdmitted,
  type CredentialDecision,
  type CredentialDenialReason,
  type SubjectCutoffState,
} from './credential-cutoffs';

import {
  AuthAdmissionUnavailableError,
  AUTH_ADMISSION_BATCH_SIZE,
  runAuthAdmissionRead,
} from './admission-read-runner';
import { createAdmissionCoalescer } from './admission-read-coalescer';
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

/**
 * A credential we signed that `decideCredential` refuses: its account is
 * deleted or missing, a cutoff ended it, or a stamp is malformed. Thrown only
 * when a validator is asked to (`throwOnRefusal`); an expired or foreign
 * credential is never this.
 */
export class AuthCredentialRefusedError extends Error {
  constructor() {
    super('Authentication is required');
    this.name = 'AuthCredentialRefusedError';
  }
}

type AdmissionTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/** Nothing writes a per-login denial yet (BA-04 PRs 6 and 9). */
const NO_DENIED_SESSIONS: ReadonlySet<string> = new Set();

function cutoffState(generation: number | null, nativeGeneration: number | null): SubjectCutoffState {
  return {
    generation: generation ?? 0,
    nativeGeneration: nativeGeneration ?? 0,
    deniedSessionKeys: NO_DENIED_SESSIONS,
  };
}

const readCoalescedSubjectState = createAdmissionCoalescer(readHumanSubjectStates);

/**
 * Fresh primary admission only: undefined is a deleted or missing account.
 * Concurrent callers share reads and briefly wait for a free one when all are busy.
 */
export async function readHumanSubjectState(userId: string): Promise<SubjectCutoffState | undefined> {
  if (!userId) return undefined;
  return readCoalescedSubjectState(userId);
}

/** For one-shot capabilities (transfer token, watch code) that carry no stamps of their own. */
export async function isHumanSubjectActive(userId: string): Promise<boolean> {
  return (await readHumanSubjectState(userId)) !== undefined;
}

/**
 * One bounded primary read, never a result cache. The cutoff row is already
 * joined for `deleted_at`, so its two generations cost no extra statement.
 */
export async function readHumanSubjectStates(
  userIds: readonly string[],
): Promise<ReadonlyMap<string, SubjectCutoffState>> {
  const requestedIds = [...new Set(userIds)];
  if (!requestedIds.length) return new Map();
  if (requestedIds.length > AUTH_ADMISSION_BATCH_SIZE) throw new AuthAdmissionUnavailableError();
  return runAuthAdmissionRead((markExecuting) =>
    readOnAdmissionConnection(markExecuting, async (admissionDatabase) => {
      const subjects = await admissionDatabase
        .select({
          id: users.id,
          generation: authSubjectCutoffs.generation,
          nativeGeneration: authSubjectCutoffs.nativeGeneration,
        })
        .from(users)
        .leftJoin(authSubjectCutoffs, eq(authSubjectCutoffs.userId, users.id))
        .where(and(inArray(users.id, requestedIds), isNull(authSubjectCutoffs.deletedAt)));
      return new Map(
        subjects.map((subject) => [subject.id, cutoffState(subject.generation, subject.nativeGeneration)]),
      );
    }),
  );
}

/** Where a credential was presented: one label per reader, for the log only. */
export type CredentialReader = 'request' | 'socket-sweep' | 'refresh';

const CUTOFF_LOG_WINDOW_MS = 10_000;
const openCutoffLogWindows = new Map<string, number>();

/**
 * One line per reader, outcome and reason straight away, then a count when its
 * 10 s window closes. Fixed labels only: never a user ID, token or claim.
 * A deletion is not logged here; it was refused before cutoffs existed.
 */
function recordCutoffDenial(reader: CredentialReader, reason: CredentialDenialReason, outcome: 'denied' | 'observed') {
  const windowKey = `${reader}:${outcome}:${reason}`;
  const suppressed = openCutoffLogWindows.get(windowKey);
  if (suppressed !== undefined) {
    openCutoffLogWindows.set(windowKey, suppressed + 1);
    return;
  }
  openCutoffLogWindows.set(windowKey, 0);
  const fields = { reader, outcome, reason };
  logger.warn('[auth-cutoff] credential refused by a cutoff', fields);
  setTimeout(() => {
    const suppressedDenials = openCutoffLogWindows.get(windowKey) ?? 0;
    openCutoffLogWindows.delete(windowKey);
    if (suppressedDenials > 0)
      logger.warn('[auth-cutoff] more credentials refused like the last one', {
        ...fields,
        suppressedDenials,
        windowMs: CUTOFF_LOG_WINDOW_MS,
      });
  }, CUTOFF_LOG_WINDOW_MS).unref();
}

/**
 * Applies `AUTH_CUTOFF_ENFORCEMENT` to a decision. Under `observe` a cutoff
 * denial is logged as `observed` and the credential is used anyway.
 */
export function admitsCredential(decision: CredentialDecision, reader: CredentialReader): boolean {
  const admitted = isCredentialAdmitted(decision, cutoffEnforcement(process.env));
  if (decision.denial !== null && decision.denial !== 'subject-inactive') {
    recordCutoffDenial(reader, decision.denial, admitted ? 'observed' : 'denied');
  }
  return admitted;
}

/**
 * What a password sign-in proved before bcrypt, with no transaction open
 * (`authenticateCurrentStorePassword`). The issuer re-reads the same row under
 * its user lock and issues only if nothing moved (BA-04 section 4).
 */
export interface PasswordProof {
  readonly passwordHash: string;
  readonly generation: number;
}

/**
 * The password or the generation changed between the bcrypt check and the user
 * lock: a reset landed in between. The sign-in is answered as invalid
 * credentials and nothing is issued.
 */
export class PasswordProofStaleError extends Error {
  constructor() {
    super('The verified password no longer matches the account');
    this.name = 'PasswordProofStaleError';
  }
}

/**
 * Issuance must own this transaction. Lock the user before refresh/account
 * child rows; never put the bounded read response race around a write.
 *
 * Returns the same state the admission read does, read by a second statement
 * once the user lock is held. The locking statement's snapshot predates its
 * wait, so a mutation that held `users FOR UPDATE` and committed while this
 * issuer waited is visible only to a statement that starts after the lock.
 *
 * KEY SHARE keeps every generation writer out until this commits, because each
 * takes `users FOR UPDATE` first (`recordSecurityMutation` makes sure), yet never
 * waits for the foreign-key KEY SHARE of an ordinary write or a partner issuer's
 * FOR SHARE. So the state read here still holds when the child row is inserted.
 *
 * With a password proof, that second statement also reads the hash and refuses
 * with {@link PasswordProofStaleError} if it, or the generation, differs from
 * what bcrypt checked. Same statement count as without.
 */
export async function requireHumanSubjectForIssuance(
  transaction: AdmissionTransaction,
  userId: string,
  passwordProof?: PasswordProof,
): Promise<SubjectCutoffState> {
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
    if (passwordProof) {
      const [current] = await transaction
        .select({
          passwordHash: userCredentials.passwordHash,
          generation: authSubjectCutoffs.generation,
          nativeGeneration: authSubjectCutoffs.nativeGeneration,
          deletedAt: authSubjectCutoffs.deletedAt,
        })
        .from(users)
        .leftJoin(authSubjectCutoffs, eq(authSubjectCutoffs.userId, users.id))
        .leftJoin(userCredentials, eq(userCredentials.userId, users.id))
        .where(eq(users.id, userId))
        .limit(1);
      if (!current || current.deletedAt) throw new AuthSubjectDeniedError();
      if (current.passwordHash !== passwordProof.passwordHash || (current.generation ?? 0) !== passwordProof.generation)
        throw new PasswordProofStaleError();
      return cutoffState(current.generation, current.nativeGeneration);
    }
    const [cutoff] = await transaction
      .select({
        generation: authSubjectCutoffs.generation,
        nativeGeneration: authSubjectCutoffs.nativeGeneration,
        deletedAt: authSubjectCutoffs.deletedAt,
      })
      .from(authSubjectCutoffs)
      .where(eq(authSubjectCutoffs.userId, userId))
      .limit(1);
    if (cutoff?.deletedAt) throw new AuthSubjectDeniedError();
    return cutoffState(cutoff?.generation ?? null, cutoff?.nativeGeneration ?? null);
  } catch (error) {
    if (error instanceof AuthSubjectDeniedError || error instanceof PasswordProofStaleError) throw error;
    throw new AuthAdmissionUnavailableError();
  }
}
