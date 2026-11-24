import { createHash, createHmac } from 'node:crypto';
import { and, eq, gt, inArray, lt, lte, or, sql } from 'drizzle-orm';
import type { DbInstance } from '@boardsesh/db/client';
import {
  authPasswordGuessWindows,
  userCredentials,
  users,
  verificationTokens,
  type PasswordGuessSubjectKind,
  type PasswordGuessWindowKind,
} from '@boardsesh/db/schema/auth';
import { BATCH_SYSTEM_USER_COMMAND_ENV } from '@boardsesh/auth-protocol';
import { DEVICE_TOKEN_SECRET_ENV } from '@boardsesh/auth-protocol/device-token';
import { logger } from '../utils/logger';
import { getPostgresErrorCode } from '../utils/postgres-errors';
import { normalizeAccountEmail } from './normalize-email';
import { DELETED_EMAIL_KEY_ENV } from './current-store/authority-configuration';
import { WEB_AUTH_COMMAND_IDENTIFIER_PREFIX } from './current-store/command-context';

/**
 * Per-account password guess limit (#7656): the counter and nothing else. The
 * compare sites reach it through `password-guess-limit.ts`, behind
 * `AUTH_ACCOUNT_GUESS_LIMIT_MODE`.
 *
 * Every function here fails open. If the store errors or does not answer in
 * 250 ms the result says `unavailable`, a metric and a rate-limited warning
 * record it, and the caller proceeds on its existing per-address limits.
 *
 * Unknown emails are counted like known ones, so every typed address can add
 * rows: the table's size is set by whoever sends sign-ins, which is why the
 * prune deletes in bounded batches.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Rejected passwords counted per subject, by fixed UTC window. */
export const PASSWORD_GUESS_LIMITS: Readonly<
  Record<PasswordGuessSubjectKind, readonly { readonly window: PasswordGuessWindowKind; readonly limit: number }[]>
> = Object.freeze({
  // 10 an hour and 20 a UTC day per email, from devices the account does not recognise.
  email_digest: Object.freeze([
    Object.freeze({ window: 'hour', limit: 10 }),
    Object.freeze({ window: 'day', limit: 20 }),
  ]),
  // An account's recognised devices share 20 rejected passwords an hour, then lose
  // their exemption for the rest of the hour. Per account, not per token id:
  // refresh and exchange mint a new id on every reply.
  account_digest: Object.freeze([Object.freeze({ window: 'hour', limit: 20 })]),
});

/** How long the store gets before a call fails open. */
export const PASSWORD_GUESS_DEADLINE_MS = 250;

/**
 * Maximum underlying counter transactions per process, including pool checkouts
 * still queued after their callers' deadlines. This bounds memory/queue growth,
 * not password guessing: shedding still fails open and enforcement stays gated.
 * Fixed independently of the pool size; no additional connection is opened.
 */
export const PASSWORD_GUESS_TRANSACTION_CAP = 32;
let transactionLifetimes = 0;

/** The actual lifetimes still occupying capacity, not callers still awaiting replies. */
export function __passwordGuessTransactionLifetimesForTests(): number {
  return transactionLifetimes;
}

/** Names the HMAC key for email digests. Unset means the limit is off. */
export const PASSWORD_GUESS_EMAIL_KEY_ENV = 'AUTH_ACCOUNT_GUESS_LIMIT_EMAIL_KEY';

const WINDOW_MS: Readonly<Record<PasswordGuessWindowKind, number>> = { hour: HOUR_MS, day: DAY_MS };
const WARNING_INTERVAL_MS = 60_000;

/** Whose guesses a call counts. Build one with `passwordGuessEmailSubject` or `passwordGuessAccountSubject`. */
export interface PasswordGuessSubject {
  readonly kind: PasswordGuessSubjectKind;
  readonly key: string;
}

/** The exact windows a reservation counted, so its give-back uncounts those and no others. */
export interface ReservedPasswordGuess {
  readonly subject: PasswordGuessSubject;
  readonly windows: readonly { readonly kind: PasswordGuessWindowKind; readonly start: Date }[];
}

/**
 * Why a call proceeded without the counter. Kept apart so an alert can tell
 * contention from an outage:
 * - `lock_wait`: Postgres gave up waiting for another attempt's row lock (a burst at one subject).
 * - `pool_wait`: no connection came free before the deadline (a busy or unreachable pool).
 * - `deadline`: the statement itself ran out of time.
 * - `store_error`: the store answered with an error (an outage, a missing table).
 * - `capacity`: this process already holds the bounded number of counter transaction lifetimes.
 */
export type PasswordGuessUnavailableReason =
  | 'not_configured'
  | 'store_error'
  | 'deadline'
  | 'lock_wait'
  | 'pool_wait'
  | 'capacity';

export type PasswordGuessReservation =
  | { readonly outcome: 'reserved'; readonly reservation: ReservedPasswordGuess }
  /** The subject is at its cap. Nothing was counted. */
  | { readonly outcome: 'refused'; readonly retryAfterSeconds: number; readonly window: PasswordGuessWindowKind }
  /** Fail open: proceed on today's limits. Nothing stays counted. */
  | { readonly outcome: 'unavailable'; readonly reason: PasswordGuessUnavailableReason };

export type PasswordGuessWriteResult = 'done' | 'unavailable';

/** The store the counter needs: the backend's primary database, or a test double. */
export type PasswordGuessStore = Pick<DbInstance, 'transaction'>;
type PasswordGuessTransaction = Parameters<Parameters<DbInstance['transaction']>[0]>[0];

type PasswordGuessOperation = 'reserve' | 'give_back' | 'clear' | 'prune';

export interface PasswordGuessMetrics {
  readonly unavailable: Readonly<
    Record<PasswordGuessOperation, Readonly<Record<PasswordGuessUnavailableReason, number>>>
  >;
}

function emptyCounts(): Record<PasswordGuessOperation, Record<PasswordGuessUnavailableReason, number>> {
  const reasons = () => ({ not_configured: 0, store_error: 0, deadline: 0, lock_wait: 0, pool_wait: 0, capacity: 0 });
  return { reserve: reasons(), give_back: reasons(), clear: reasons(), prune: reasons() };
}

let metrics = emptyCounts();
let sinceLastWarning = emptyCounts();
let lastWarningAt = Number.NEGATIVE_INFINITY;
let invalidKeyLogged = false;

/** Process counters of every fail-open, by operation and reason. Read by tests and dashboards. */
export function passwordGuessMetrics(): PasswordGuessMetrics {
  return {
    unavailable: Object.fromEntries(
      Object.entries(metrics).map(([operation, reasons]) => [operation, { ...reasons }]),
    ) as PasswordGuessMetrics['unavailable'],
  };
}

export function __resetPasswordGuessStateForTests(): void {
  metrics = emptyCounts();
  sinceLastWarning = emptyCounts();
  lastWarningAt = Number.NEGATIVE_INFINITY;
  invalidKeyLogged = false;
}

/**
 * Counts a fail-open and logs at most one warning a minute, carrying the counts
 * it covers. `not_configured` is counted but never warned: an unset key is the
 * intended off state, not a fault.
 */
function recordUnavailable(operation: PasswordGuessOperation, reason: PasswordGuessUnavailableReason): void {
  metrics[operation][reason] += 1;
  if (reason === 'not_configured') return;
  sinceLastWarning[operation][reason] += 1;
  const now = Date.now();
  if (now - lastWarningAt < WARNING_INTERVAL_MS) return;
  lastWarningAt = now;
  logger.warn('[PasswordGuess] Guess counter unavailable; sign-in proceeded on per-address limits', {
    type: 'password_guess_metrics',
    reserveStoreError: sinceLastWarning.reserve.store_error,
    reserveDeadline: sinceLastWarning.reserve.deadline,
    reserveLockWait: sinceLastWarning.reserve.lock_wait,
    reservePoolWait: sinceLastWarning.reserve.pool_wait,
    reserveCapacity: sinceLastWarning.reserve.capacity,
    giveBackStoreError: sinceLastWarning.give_back.store_error,
    giveBackDeadline: sinceLastWarning.give_back.deadline,
    giveBackCapacity: sinceLastWarning.give_back.capacity,
    clearStoreError: sinceLastWarning.clear.store_error,
    clearDeadline: sinceLastWarning.clear.deadline,
    clearCapacity: sinceLastWarning.clear.capacity,
    pruneStoreError: sinceLastWarning.prune.store_error,
    pruneDeadline: sinceLastWarning.prune.deadline,
    pruneCapacity: sinceLastWarning.prune.capacity,
  });
  sinceLastWarning = emptyCounts();
}

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * The email digest key, or null when the limit is off. Unset is off. A key
 * shorter than 32 bytes, with surrounding spaces, or equal to another auth
 * secret is also off, with one error log naming the variable (never its value):
 * a bad key must not stop the backend from starting.
 */
export function passwordGuessEmailKey(environment: Environment = process.env): string | null {
  const key = environment[PASSWORD_GUESS_EMAIL_KEY_ENV];
  if (!key) return null;
  const otherSecrets = [
    environment.NEXTAUTH_SECRET,
    environment.CRON_SECRET,
    environment.CURRENT_STORE_AUTH_RPC_SECRET,
    environment[BATCH_SYSTEM_USER_COMMAND_ENV.secret],
    environment[DELETED_EMAIL_KEY_ENV],
    environment[DEVICE_TOKEN_SECRET_ENV],
    environment.AUTH_BROWSER_SESSION_COOKIE_SECRET,
    environment.AUTH_BROWSER_ACCESS_TOKEN_SECRET,
    environment.AUTH_BRIDGE_TOKEN_SECRET,
  ];
  if (
    key !== key.trim() ||
    Buffer.byteLength(key, 'utf8') < 32 ||
    otherSecrets.some((otherSecret) => Boolean(otherSecret) && otherSecret === key)
  ) {
    if (!invalidKeyLogged) {
      invalidKeyLogged = true;
      logger.error(`Password guess limit off: ${PASSWORD_GUESS_EMAIL_KEY_ENV} is too short, padded or reused`);
    }
    return null;
  }
  return key;
}

/**
 * The subject for a typed email: HMAC-SHA256 of the normalised address under
 * the digest key, so the table never holds an address. Null when the limit is
 * off; pass it to `reservePasswordGuess` anyway, which answers `unavailable`.
 * Known and unknown addresses get a subject alike.
 */
export function passwordGuessEmailSubject(
  email: string,
  environment: Environment = process.env,
): PasswordGuessSubject | null {
  const key = passwordGuessEmailKey(environment);
  if (key === null) return null;
  return Object.freeze({ kind: 'email_digest', key: subjectDigest(key, 'email', normalizeAccountEmail(email)) });
}

/**
 * The subject every recognised device of one account shares: HMAC-SHA256 of
 * the user id under the same key. Null when the limit is off.
 */
export function passwordGuessAccountSubject(
  userId: string,
  environment: Environment = process.env,
): PasswordGuessSubject | null {
  const key = passwordGuessEmailKey(environment);
  if (key === null || !userId) return null;
  return Object.freeze({ kind: 'account_digest', key: subjectDigest(key, 'account', userId) });
}

/** The domain goes into the MAC, so an address and a user id with the same text never share a digest. */
function subjectDigest(key: string, domain: 'email' | 'account', value: string): string {
  return createHmac('sha256', key)
    .update(JSON.stringify(['boardsesh-password-guess', domain, value]), 'utf8')
    .digest('hex');
}

function windowStart(kind: PasswordGuessWindowKind, now: Date): Date {
  const length = WINDOW_MS[kind];
  return new Date(Math.floor(now.getTime() / length) * length);
}

class GuessRefused extends Error {
  constructor(
    readonly window: PasswordGuessWindowKind,
    readonly retryAfterSeconds: number,
  ) {
    super('Password guess refused');
  }
}

class DeadlinePassed extends Error {
  constructor() {
    super('Password guess deadline passed');
  }
}

type Deadlined<Result> =
  | { readonly kind: 'settled'; readonly value: Result }
  /** `started`: the transaction had a connection and had begun its work. */
  | { readonly kind: 'late'; readonly started: boolean };

/**
 * Postgres's lock timeout ends this much before the caller's deadline, so a
 * statement stuck behind another attempt's row lock fails as a lock wait
 * (`55P03`) rather than surfacing as a generic missed deadline.
 */
const LOCK_WAIT_MARGIN_MS = 40;

class CounterCapacityReached extends Error {}

type CounterWork<Result> = (transaction: PasswordGuessTransaction) => Promise<Result>;
type LateCompensation = (work: CounterWork<void>) => Promise<void>;

/** A transaction's own budget also covers time waiting for a connection. */
function startBudgetedTransaction<Result>(
  store: PasswordGuessStore,
  deadlineMs: number,
  work: CounterWork<Result>,
  onStarted: () => void = () => {},
): Promise<Result> {
  const startedAt = Date.now();
  return store.transaction(async (transaction) => {
    const remaining = deadlineMs - (Date.now() - startedAt);
    if (remaining <= 0) throw new DeadlinePassed();
    onStarted();
    const statementBudget = String(Math.max(1, Math.ceil(remaining)));
    const lockBudget = String(Math.max(1, Math.ceil(remaining) - LOCK_WAIT_MARGIN_MS));
    await transaction.execute(
      sql`SELECT set_config('statement_timeout', ${statementBudget}, true), set_config('lock_timeout', ${lockBudget}, true)`,
    );
    return work(transaction);
  });
}

/**
 * A caller gets its deadline even if its pool checkout/COMMIT is still pending.
 * The capacity slot belongs to the underlying transaction until it settles,
 * including compensation for a reservation that committed after the deadline.
 * Compensation reuses that slot: a full counter can still undo late writes.
 */
async function runWithDeadline<Result>(
  store: PasswordGuessStore,
  deadlineMs: number,
  work: CounterWork<Result>,
  onLate: (value: Result, compensate: LateCompensation) => void | Promise<unknown>,
  onSettled: (committed: boolean) => void = () => {},
): Promise<Deadlined<Result>> {
  if (transactionLifetimes >= PASSWORD_GUESS_TRANSACTION_CAP) {
    onSettled(false);
    throw new CounterCapacityReached();
  }
  transactionLifetimes += 1;
  let started = false;
  let late = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<Deadlined<Result>>((resolve) => {
    timer = setTimeout(() => {
      late = true;
      resolve({ kind: 'late', started });
    }, deadlineMs);
  });
  const run = (async () => {
    let committed = false;
    try {
      const result = await startBudgetedTransaction(store, deadlineMs, work, () => {
        started = true;
      });
      committed = true;
      if (late) {
        await onLate(result, (compensation) =>
          startBudgetedTransaction(store, PASSWORD_GUESS_DEADLINE_MS, compensation),
        );
      }
      return result;
    } finally {
      transactionLifetimes -= 1;
      onSettled(committed);
    }
  })();
  try {
    return await Promise.race([run.then((value): Deadlined<Result> => ({ kind: 'settled', value })), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Counts one password guess against every window of the subject, or refuses
 * without counting when any window is at its cap. One conditional upsert per
 * window, in a fixed order inside one transaction: the row lock serialises a
 * parallel burst, so a burst of N takes exactly the slots that are left and
 * the rest are refused.
 *
 * Call it before the compare. Give the reservation back for every outcome
 * except a rejected password.
 */
export async function reservePasswordGuess(
  store: PasswordGuessStore,
  subject: PasswordGuessSubject | null,
  options: { readonly now?: Date; readonly deadlineMs?: number } = {},
): Promise<PasswordGuessReservation> {
  if (subject === null) {
    recordUnavailable('reserve', 'not_configured');
    return { outcome: 'unavailable', reason: 'not_configured' };
  }
  const now = options.now ?? new Date();
  const limits = PASSWORD_GUESS_LIMITS[subject.kind];
  const windows = limits.map(({ window }) => ({ kind: window, start: windowStart(window, now) }));
  const reservation: ReservedPasswordGuess = Object.freeze({ subject, windows: Object.freeze(windows) });

  try {
    const outcome = await runWithDeadline(
      store,
      options.deadlineMs ?? PASSWORD_GUESS_DEADLINE_MS,
      async (transaction) => {
        for (const [index, { window, limit }] of limits.entries()) {
          const start = windows[index].start;
          const [counted] = await transaction
            .insert(authPasswordGuessWindows)
            .values({
              subjectKind: subject.kind,
              subjectKey: subject.key,
              windowKind: window,
              windowStart: start,
              failures: 1,
            })
            .onConflictDoUpdate({
              target: [
                authPasswordGuessWindows.subjectKind,
                authPasswordGuessWindows.subjectKey,
                authPasswordGuessWindows.windowKind,
                authPasswordGuessWindows.windowStart,
              ],
              set: { failures: sql`${authPasswordGuessWindows.failures} + 1` },
              setWhere: lt(authPasswordGuessWindows.failures, limit),
            })
            .returning({ failures: authPasswordGuessWindows.failures });
          if (!counted) {
            const secondsLeft = Math.ceil((start.getTime() + WINDOW_MS[window] - now.getTime()) / 1000);
            // Throwing rolls back the windows this reservation already counted.
            throw new GuessRefused(window, Math.max(1, secondsLeft));
          }
        }
      },
      // The caller already proceeded uncounted, so a reservation that commits late is taken back.
      async (_result, compensate) => {
        try {
          await compensate((transaction) => uncount(transaction, reservation));
        } catch (error) {
          recordUnavailable('give_back', unavailableReason(error));
        }
      },
    );
    if (outcome.kind === 'late') {
      const reason = outcome.started ? 'deadline' : 'pool_wait';
      recordUnavailable('reserve', reason);
      return { outcome: 'unavailable', reason };
    }
    return { outcome: 'reserved', reservation };
  } catch (error) {
    if (error instanceof GuessRefused) {
      return { outcome: 'refused', retryAfterSeconds: error.retryAfterSeconds, window: error.window };
    }
    // A database error can carry bound values; only the category is recorded.
    const reason = unavailableReason(error);
    recordUnavailable('reserve', reason);
    return { outcome: 'unavailable', reason };
  }
}

/** An account a typed email may sign in to, and when its password last changed. */
export interface PasswordGuessAccount {
  readonly userId: string;
  /** Null for an account with no password. */
  readonly passwordChangedAt: Date | null;
}

/** More accounts than password sign-in ever compares for one address (it stops at 8). */
const MAX_ACCOUNTS_PER_EMAIL = 9;

/**
 * The accounts a typed email names, for checking a presented device token
 * against. Runs under the same deadline as a reserve; `unavailable` means the
 * caller cannot tell whether the device is recognised. An unknown address
 * answers an empty list, after the same single read.
 */
export async function readPasswordGuessAccounts(
  store: PasswordGuessStore,
  email: string,
  options: { readonly deadlineMs?: number } = {},
): Promise<readonly PasswordGuessAccount[] | 'unavailable'> {
  const normalizedEmail = normalizeAccountEmail(email);
  try {
    const outcome = await runWithDeadline(
      store,
      options.deadlineMs ?? PASSWORD_GUESS_DEADLINE_MS,
      (transaction) =>
        transaction
          .select({ userId: users.id, passwordChangedAt: userCredentials.updatedAt })
          .from(users)
          .leftJoin(userCredentials, eq(userCredentials.userId, users.id))
          .where(sql`LOWER(${users.email}) = ${normalizedEmail}`)
          .limit(MAX_ACCOUNTS_PER_EMAIL),
      () => {},
    );
    if (outcome.kind === 'late') {
      recordUnavailable('reserve', outcome.started ? 'deadline' : 'pool_wait');
      return 'unavailable';
    }
    return outcome.value;
  } catch (error) {
    recordUnavailable('reserve', unavailableReason(error));
    return 'unavailable';
  }
}

/** A give-back that committed (`done`) or is running (its promise). A failed one is forgotten, so a retry writes. */
const giveBacks = new WeakMap<ReservedPasswordGuess, 'done' | Promise<PasswordGuessWriteResult>>();

/**
 * Uncounts a reservation: a right password, a shed or abandoned compare, or no
 * verdict at all. Only a rejected password stays counted. Never throws.
 * Uncounts the windows the reservation counted, even after the clock has moved
 * on; a window already pruned has nothing to uncount.
 *
 * Once it has succeeded, another call answers `done` and writes nothing; a call
 * while one is running shares its result, including after the caller's deadline.
 * Only a settled failure permits another write; a late commit is still done.
 */
export async function giveBackPasswordGuess(
  store: PasswordGuessStore,
  reservation: ReservedPasswordGuess,
  options: { readonly deadlineMs?: number } = {},
): Promise<PasswordGuessWriteResult> {
  const previous = giveBacks.get(reservation);
  if (previous !== undefined) return previous;
  let underlyingSettled = false;
  const running = writeGiveBack(store, reservation, options.deadlineMs, (committed) => {
    underlyingSettled = true;
    if (committed) giveBacks.set(reservation, 'done');
    else giveBacks.delete(reservation);
  }).then((result) => {
    if (result === 'done') giveBacks.set(reservation, 'done');
    else if (underlyingSettled && giveBacks.get(reservation) === running) giveBacks.delete(reservation);
    return result;
  });
  giveBacks.set(reservation, running);
  return running;
}

function writeGiveBack(
  store: PasswordGuessStore,
  reservation: ReservedPasswordGuess,
  deadlineMs: number | undefined,
  onSettled: (committed: boolean) => void,
): Promise<PasswordGuessWriteResult> {
  return runWrite('give_back', store, deadlineMs, (transaction) => uncount(transaction, reservation), onSettled);
}

async function uncount(transaction: PasswordGuessTransaction, reservation: ReservedPasswordGuess): Promise<void> {
  const { subject, windows } = reservation;
  for (const window of windows) {
    await transaction
      .update(authPasswordGuessWindows)
      .set({ failures: sql`${authPasswordGuessWindows.failures} - 1` })
      .where(
        and(
          eq(authPasswordGuessWindows.subjectKind, subject.kind),
          eq(authPasswordGuessWindows.subjectKey, subject.key),
          eq(authPasswordGuessWindows.windowKind, window.kind),
          eq(authPasswordGuessWindows.windowStart, window.start),
          gt(authPasswordGuessWindows.failures, 0),
        ),
      );
  }
}

/** A replay record outlives every window a reservation can count in (a day). */
const GIVE_BACK_CLAIM_LIFETIME_MS = 2 * DAY_MS;

/**
 * Gives back a reservation another request made, at most once per
 * `reservationId` (the id its reserve handed out). The claim and the uncount
 * commit together, so a retried, replayed or concurrent give-back of the same
 * reservation uncounts nothing more. The claim is a replay record the existing
 * cleanup removes after it expires.
 */
export async function giveBackPasswordGuessOnce(
  store: PasswordGuessStore,
  reservation: ReservedPasswordGuess,
  reservationId: string,
  options: { readonly deadlineMs?: number } = {},
): Promise<PasswordGuessWriteResult> {
  const claimHash = createHash('sha256').update(`password-guess-give-back-v1\0${reservationId}`).digest('hex');
  return runWrite('give_back', store, options.deadlineMs, async (transaction) => {
    const claimed = await transaction
      .insert(verificationTokens)
      .values({
        identifier: `${WEB_AUTH_COMMAND_IDENTIFIER_PREFIX}${claimHash}`,
        token: claimHash,
        expires: new Date(Date.now() + GIVE_BACK_CLAIM_LIFETIME_MS),
      })
      .onConflictDoNothing()
      .returning({ token: verificationTokens.token });
    if (claimed.length === 1) await uncount(transaction, reservation);
  });
}

/**
 * Forgets every counted guess for the subject. Call it when an emailed reset
 * completes: the owner has proved control of the address, so the guesses
 * charged to it no longer stand between them and a password sign-in.
 */
export async function clearPasswordGuesses(
  store: PasswordGuessStore,
  subject: PasswordGuessSubject | null,
  options: { readonly deadlineMs?: number } = {},
): Promise<PasswordGuessWriteResult> {
  if (subject === null) {
    recordUnavailable('clear', 'not_configured');
    return 'unavailable';
  }
  return runWrite('clear', store, options.deadlineMs, async (transaction) => {
    await transaction
      .delete(authPasswordGuessWindows)
      .where(
        and(
          eq(authPasswordGuessWindows.subjectKind, subject.kind),
          eq(authPasswordGuessWindows.subjectKey, subject.key),
        ),
      );
  });
}

/** How long the minute maintenance tick gives one prune, across all its batches. */
const PRUNE_BUDGET_MS = 5_000;
/** Rows one prune statement deletes at most. */
const PRUNE_BATCH_SIZE = 5_000;

export interface PasswordGuessPruneResult {
  /** `unavailable` when a batch failed or missed its deadline; earlier batches stay deleted. */
  readonly result: PasswordGuessWriteResult;
  readonly deleted: number;
  readonly batches: number;
  /** True when the last batch found fewer ended windows than it could delete. */
  readonly drained: boolean;
}

/**
 * Deletes every window that has ended: an hour window an hour after it began,
 * a day window a day after. Runs on the backend's minute auth maintenance tick
 * (`clearExpiredAuthRecords`). Each batch is its own short transaction of at
 * most `batchSize` rows, so a flood of distinct emails still makes progress
 * every tick; whatever is left after the time budget waits for the next one.
 */
export async function prunePasswordGuessWindows(
  store: PasswordGuessStore,
  options: { readonly now?: Date; readonly batchSize?: number; readonly budgetMs?: number } = {},
): Promise<PasswordGuessPruneResult> {
  const now = (options.now ?? new Date()).getTime();
  const batchSize = options.batchSize ?? PRUNE_BATCH_SIZE;
  const budgetMs = options.budgetMs ?? PRUNE_BUDGET_MS;
  const startedAt = Date.now();
  const ended = or(
    and(
      eq(authPasswordGuessWindows.windowKind, 'hour'),
      lte(authPasswordGuessWindows.windowStart, new Date(now - HOUR_MS)),
    ),
    and(
      eq(authPasswordGuessWindows.windowKind, 'day'),
      lte(authPasswordGuessWindows.windowStart, new Date(now - DAY_MS)),
    ),
  );
  let deleted = 0;
  let batches = 0;
  for (;;) {
    const remaining = budgetMs - (Date.now() - startedAt);
    if (remaining <= 0) return { result: 'done', deleted, batches, drained: false };
    let batchDeleted = 0;
    const result = await runWrite('prune', store, remaining, async (transaction) => {
      // `ctid` bounds one DELETE without a key to page on; the subquery re-checks `ended`.
      const removed = await transaction
        .delete(authPasswordGuessWindows)
        .where(
          inArray(
            sql`ctid`,
            transaction
              .select({ ctid: sql`ctid` })
              .from(authPasswordGuessWindows)
              .where(ended)
              .limit(batchSize),
          ),
        )
        .returning({ windowKind: authPasswordGuessWindows.windowKind });
      batchDeleted = removed.length;
    });
    if (result === 'unavailable') return { result, deleted, batches, drained: false };
    deleted += batchDeleted;
    batches += 1;
    if (batchDeleted < batchSize) return { result, deleted, batches, drained: true };
  }
}

async function runWrite(
  operation: PasswordGuessOperation,
  store: PasswordGuessStore,
  deadlineMs: number | undefined,
  work: (transaction: PasswordGuessTransaction) => Promise<void>,
  onSettled: (committed: boolean) => void = () => {},
): Promise<PasswordGuessWriteResult> {
  try {
    const outcome = await runWithDeadline(store, deadlineMs ?? PASSWORD_GUESS_DEADLINE_MS, work, () => {}, onSettled);
    if (outcome.kind === 'late') {
      recordUnavailable(operation, outcome.started ? 'deadline' : 'pool_wait');
      return 'unavailable';
    }
    return 'done';
  } catch (error) {
    recordUnavailable(operation, unavailableReason(error));
    return 'unavailable';
  }
}

/**
 * `55P03` is Postgres's lock timeout, `57014` its statement timeout. A
 * transaction that only got a connection after the deadline never ran.
 */
function unavailableReason(error: unknown): PasswordGuessUnavailableReason {
  if (error instanceof DeadlinePassed) return 'pool_wait';
  if (error instanceof CounterCapacityReached) return 'capacity';
  const code = getPostgresErrorCode(error);
  if (code === '55P03') return 'lock_wait';
  if (code === '57014') return 'deadline';
  return 'store_error';
}
