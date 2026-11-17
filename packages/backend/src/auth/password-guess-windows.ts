import { createHmac } from 'node:crypto';
import { and, eq, gt, lt, lte, or, sql } from 'drizzle-orm';
import type { DbInstance } from '@boardsesh/db/client';
import {
  authPasswordGuessWindows,
  type PasswordGuessSubjectKind,
  type PasswordGuessWindowKind,
} from '@boardsesh/db/schema/auth';
import { BATCH_SYSTEM_USER_COMMAND_ENV } from '@boardsesh/auth-protocol';
import { logger } from '../utils/logger';
import { getPostgresErrorCode } from '../utils/postgres-errors';
import { normalizeAccountEmail } from './normalize-email';
import { DELETED_EMAIL_KEY_ENV } from './current-store/authority-configuration';

/**
 * Per-account password guess limit (#7656): the counter and nothing else. No
 * sign-in consults it yet; a later change wires it into the compare sites
 * behind `AUTH_ACCOUNT_GUESS_LIMIT_MODE`.
 *
 * Every function here fails open. If the store errors or does not answer in
 * 250 ms the result says `unavailable`, a metric and a rate-limited warning
 * record it, and the caller proceeds on its existing per-address limits.
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
  // A recognised device loses its exemption for the hour after 20 rejected passwords.
  device_token: Object.freeze([Object.freeze({ window: 'hour', limit: 20 })]),
});

/** How long the store gets before a call fails open. */
export const PASSWORD_GUESS_DEADLINE_MS = 250;

/** Names the HMAC key for email digests. Unset means the limit is off. */
export const PASSWORD_GUESS_EMAIL_KEY_ENV = 'AUTH_ACCOUNT_GUESS_LIMIT_EMAIL_KEY';

const WINDOW_MS: Readonly<Record<PasswordGuessWindowKind, number>> = { hour: HOUR_MS, day: DAY_MS };
const DEVICE_TOKEN_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const WARNING_INTERVAL_MS = 60_000;

/** Whose guesses a call counts. Build one with `passwordGuessEmailSubject` or `passwordGuessDeviceSubject`. */
export interface PasswordGuessSubject {
  readonly kind: PasswordGuessSubjectKind;
  readonly key: string;
}

/** The exact windows a reservation counted, so its give-back uncounts those and no others. */
export interface ReservedPasswordGuess {
  readonly subject: PasswordGuessSubject;
  readonly windows: readonly { readonly kind: PasswordGuessWindowKind; readonly start: Date }[];
}

/** Why a call proceeded without the counter. */
export type PasswordGuessUnavailableReason = 'not_configured' | 'store_error' | 'deadline';

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
  const reasons = () => ({ not_configured: 0, store_error: 0, deadline: 0 });
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
    giveBackStoreError: sinceLastWarning.give_back.store_error,
    giveBackDeadline: sinceLastWarning.give_back.deadline,
    clearStoreError: sinceLastWarning.clear.store_error,
    clearDeadline: sinceLastWarning.clear.deadline,
    pruneStoreError: sinceLastWarning.prune.store_error,
    pruneDeadline: sinceLastWarning.prune.deadline,
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
    environment.AUTH_DEVICE_TOKEN_SECRET,
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
  const digest = createHmac('sha256', key).update(normalizeAccountEmail(email), 'utf8').digest('hex');
  return Object.freeze({ kind: 'email_digest', key: digest });
}

/** The subject for a verified device token's id (16 random bytes, base64url). */
export function passwordGuessDeviceSubject(tokenId: string): PasswordGuessSubject {
  if (!DEVICE_TOKEN_ID_PATTERN.test(tokenId)) throw new Error('Invalid device token id');
  return Object.freeze({ kind: 'device_token', key: tokenId });
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

type Deadlined<Result> = { readonly kind: 'settled'; readonly value: Result } | { readonly kind: 'late' };

/**
 * Runs one transaction under the deadline. Postgres is told the same deadline
 * (`statement_timeout`, `lock_timeout`), so a statement still waiting when the
 * caller gives up is cancelled and rolls back. A transaction that only starts
 * after the deadline (a slow pool checkout) rolls back before writing.
 * `onLate` receives a result that arrives after the caller was answered.
 */
async function runWithDeadline<Result>(
  store: PasswordGuessStore,
  deadlineMs: number,
  work: (transaction: PasswordGuessTransaction) => Promise<Result>,
  onLate: (value: Result) => void,
): Promise<Deadlined<Result>> {
  const startedAt = Date.now();
  const run = store.transaction(async (transaction) => {
    const remaining = deadlineMs - (Date.now() - startedAt);
    if (remaining <= 0) throw new DeadlinePassed();
    const budget = String(Math.max(1, Math.ceil(remaining)));
    await transaction.execute(sql`SELECT set_config('statement_timeout', ${budget}, true)`);
    await transaction.execute(sql`SELECT set_config('lock_timeout', ${budget}, true)`);
    return work(transaction);
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<Deadlined<Result>>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'late' }), deadlineMs);
  });
  try {
    const outcome = await Promise.race([
      run.then((value): Deadlined<Result> => ({ kind: 'settled', value })),
      deadline,
    ]);
    if (outcome.kind === 'late') run.then(onLate, () => {});
    return outcome;
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
      () => void giveBackPasswordGuess(store, reservation),
    );
    if (outcome.kind === 'late') {
      recordUnavailable('reserve', 'deadline');
      return { outcome: 'unavailable', reason: 'deadline' };
    }
    return { outcome: 'reserved', reservation };
  } catch (error) {
    if (error instanceof GuessRefused) {
      return { outcome: 'refused', retryAfterSeconds: error.retryAfterSeconds, window: error.window };
    }
    // A database error can carry bound values; only the category is recorded.
    const reason = error instanceof DeadlinePassed || isPostgresTimeout(error) ? 'deadline' : 'store_error';
    recordUnavailable('reserve', reason);
    return { outcome: 'unavailable', reason };
  }
}

const givenBack = new WeakSet<ReservedPasswordGuess>();

/**
 * Uncounts a reservation: a right password, a shed or abandoned compare, or no
 * verdict at all. Only a rejected password stays counted. Safe to call twice;
 * never throws. Uncounts the windows the reservation counted, even after the
 * clock has moved on; a window already pruned has nothing to uncount.
 */
export async function giveBackPasswordGuess(
  store: PasswordGuessStore,
  reservation: ReservedPasswordGuess,
  options: { readonly deadlineMs?: number } = {},
): Promise<PasswordGuessWriteResult> {
  if (givenBack.has(reservation)) return 'done';
  givenBack.add(reservation);
  const { subject, windows } = reservation;
  return runWrite('give_back', store, options.deadlineMs, async (transaction) => {
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

/** How long the minute maintenance tick gives one prune. */
const PRUNE_DEADLINE_MS = 5_000;

/**
 * Deletes every window that has ended: an hour window an hour after it began,
 * a day window a day after. Runs on the backend's minute auth maintenance tick
 * (`clearExpiredAuthRecords`), so a window is gone within a minute of ending.
 */
export async function prunePasswordGuessWindows(
  store: PasswordGuessStore,
  options: { readonly now?: Date; readonly deadlineMs?: number } = {},
): Promise<PasswordGuessWriteResult> {
  const now = (options.now ?? new Date()).getTime();
  return runWrite('prune', store, options.deadlineMs ?? PRUNE_DEADLINE_MS, async (transaction) => {
    await transaction
      .delete(authPasswordGuessWindows)
      .where(
        or(
          and(
            eq(authPasswordGuessWindows.windowKind, 'hour'),
            lte(authPasswordGuessWindows.windowStart, new Date(now - HOUR_MS)),
          ),
          and(
            eq(authPasswordGuessWindows.windowKind, 'day'),
            lte(authPasswordGuessWindows.windowStart, new Date(now - DAY_MS)),
          ),
        ),
      );
  });
}

async function runWrite(
  operation: PasswordGuessOperation,
  store: PasswordGuessStore,
  deadlineMs: number | undefined,
  work: (transaction: PasswordGuessTransaction) => Promise<void>,
): Promise<PasswordGuessWriteResult> {
  try {
    const outcome = await runWithDeadline(store, deadlineMs ?? PASSWORD_GUESS_DEADLINE_MS, work, () => {});
    if (outcome.kind === 'late') {
      recordUnavailable(operation, 'deadline');
      return 'unavailable';
    }
    return 'done';
  } catch (error) {
    recordUnavailable(
      operation,
      error instanceof DeadlinePassed || isPostgresTimeout(error) ? 'deadline' : 'store_error',
    );
    return 'unavailable';
  }
}

/** `57014` statement timeout and `55P03` lock timeout: Postgres enforcing our deadline. */
function isPostgresTimeout(error: unknown): boolean {
  const code = getPostgresErrorCode(error);
  return code === '57014' || code === '55P03';
}
