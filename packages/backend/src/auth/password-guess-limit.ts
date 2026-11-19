import { randomUUID } from 'node:crypto';
import { readDeviceTokenSecret } from '@boardsesh/auth-protocol/device-token';
import { logger } from '../utils/logger';
import { verifyPresentedDeviceToken } from './device-token';
import { passwordGuessDatabase, passwordGuessPoolMax } from './password-guess-pool';
import {
  clearPasswordGuesses,
  giveBackPasswordGuess,
  giveBackPasswordGuessOnce,
  PASSWORD_GUESS_DEADLINE_MS,
  passwordGuessAccountSubject,
  passwordGuessEmailKey,
  passwordGuessEmailSubject,
  readPasswordGuessAccounts,
  reservePasswordGuess,
  type PasswordGuessReservation,
  type PasswordGuessStore,
  type PasswordGuessSubject,
  type ReservedPasswordGuess,
} from './password-guess-windows';

/**
 * The per-account password guess limit at the compare sites (#7656, PR 4).
 *
 * Before a password compare, a sign-in reserves one guess:
 * - With a device token valid for one of the accounts the email names, issued
 *   after that account's password last changed, it charges that account's
 *   shared device bucket (20 an hour) and is never refused for the email.
 *   A device bucket at its cap only suspends the exemption: the attempt then
 *   counts against the email like any other.
 * - Otherwise it charges the email (10 an hour, 20 a UTC day). Known and
 *   unknown addresses are counted and refused alike.
 * A right password, or no verdict, gives the guess back.
 *
 * `observe` counts and logs what it would refuse; only `enforce` refuses.
 * Every failure to count fails open: the sign-in proceeds on the per-address
 * limits and the fail-open is counted (`password-guess-windows.ts`).
 */

export const ACCOUNT_GUESS_LIMIT_MODE_ENV = 'AUTH_ACCOUNT_GUESS_LIMIT_MODE';
export type AccountGuessLimitMode = 'off' | 'observe' | 'enforce';

/**
 * Code gates that keep `enforce` from starting. No environment value removes
 * one; a reviewed change empties the list. Tests build a limiter in `enforce`
 * directly instead.
 */
export const ACCOUNT_GUESS_LIMIT_ENFORCE_BLOCKERS: readonly string[] = Object.freeze([
  // The in-flight cap and the dedicated pool should stop an attacker forcing
  // the counter to fail open. Production `observe` data has to show they do
  // (reserve deadlines, lock waits and pool waits near zero under real load)
  // before refusals start.
  'FORCED_FAIL_OPEN_CLOSURE_UNPROVEN_IN_PRODUCTION_OBSERVE',
  // A reset voids the phone's device token and its refresh tokens, so a native
  // owner signs in unrecognised and an attacker can refill the cleared email
  // bucket first. Needs a design decision recorded on #7656.
  'RESET_DOES_NOT_RESCUE_NATIVE_OWNER',
  // The 5 s rule reads `user_credentials.updated_at`; under the Better Auth
  // authority the password lives in `auth_account`. Needs an authority-aware read.
  'PASSWORD_CHANGE_TIME_IGNORES_AUTHORITY',
  // The in-flight cap is per subject: a burst over many emails can still fill
  // the counter's pool, so the target's reserves end as pool waits and run
  // uncounted. Needs a global bound or proof under a many-email burst.
  'CROSS_SUBJECT_POOL_SATURATION',
]);

/** Reserves one subject may have running at once in this process; the next is refused without touching the store. */
export const PASSWORD_GUESS_IN_FLIGHT_CAP = 4;
/** A device token issued this long before the password changed still counts as issued after it (clock difference). */
export const DEVICE_TOKEN_PASSWORD_CHANGE_TOLERANCE_MS = 5_000;

type Environment = Readonly<Record<string, string | undefined>>;

/** Unset or empty is `off`. Any other unknown value is a startup error. */
export function parseAccountGuessLimitMode(environment: Environment = process.env): AccountGuessLimitMode {
  const mode = environment[ACCOUNT_GUESS_LIMIT_MODE_ENV];
  if (mode === undefined || mode === '' || mode === 'off') return 'off';
  if (mode === 'observe' || mode === 'enforce') return mode;
  throw new Error(`Invalid ${ACCOUNT_GUESS_LIMIT_MODE_ENV}`);
}

/** The mode the process may run in: `enforce` is refused while any code gate is open. */
export function accountGuessLimitMode(
  environment: Environment = process.env,
  enforceBlockers: readonly string[] = ACCOUNT_GUESS_LIMIT_ENFORCE_BLOCKERS,
): AccountGuessLimitMode {
  const mode = parseAccountGuessLimitMode(environment);
  if (mode === 'enforce' && enforceBlockers.length > 0) throw new Error('ACCOUNT_GUESS_LIMIT_ENFORCE_BLOCKED');
  return mode;
}

/** Called before the backend listens, like the neighbouring auth modes. */
export function assertAccountGuessLimitConfiguration(environment: Environment = process.env): void {
  accountGuessLimitMode(environment);
  passwordGuessPoolMax(environment);
}

/** What the compare site learns before it compares. */
export type PasswordGuessAdmission =
  | {
      readonly outcome: 'refused';
      /** Seconds until the refusing window ends, at least 1. */
      readonly retryAfterSeconds: number;
    }
  | {
      readonly outcome: 'proceed';
      /** What was counted, for a caller in another process to give back (the web, through the private command). */
      readonly counted?: CountedGuess;
      /** `observe` would have refused this attempt; nothing was counted. */
      readonly wouldRefuse?: true;
      /**
       * Call once with the verdict: `accepted` (right password) and
       * `no_verdict` (an error, a shed or abandoned compare) give the guess
       * back; `rejected` keeps it counted. Never throws.
       */
      settle(verdict: 'accepted' | 'rejected' | 'no_verdict'): Promise<void>;
    };

/** A reservation described by what it counted, so another request can give it back. */
export interface CountedGuess {
  /** Random per reservation: a give-back through the private command uncounts once per id. */
  readonly id: string;
  readonly bucket: 'email' | 'account';
  readonly userId?: string;
  readonly windows: ReservedPasswordGuess['windows'];
}

export interface PasswordGuessLimiter {
  readonly mode: AccountGuessLimitMode;
  admit(attempt: {
    readonly email: string;
    readonly deviceToken?: unknown;
    /** When set, a device token counts only for this account (the web's own lookup). */
    readonly candidateUserId?: string;
  }): Promise<PasswordGuessAdmission>;
  /** Settles an admission made in another request, from what it reported. Never throws. */
  settleCounted(
    email: string,
    counted: CountedGuess | undefined,
    verdict: 'accepted' | 'no_verdict',
    wouldRefuse: boolean,
  ): Promise<void>;
  /** After an emailed reset completes: the owner proved the inbox. Never throws. */
  clearEmail(email: string): Promise<void>;
}

/** Process counters, read by tests and reported in the warning log. */
export interface PasswordGuessLimitMetrics {
  readonly refused: number;
  readonly wouldRefuse: number;
  readonly wouldRefuseThenAccepted: number;
  readonly inFlightCapped: number;
  readonly deviceRecognised: number;
  readonly deviceSuspended: number;
  readonly failOpen: number;
}

type MutableMetrics = { -readonly [Key in keyof PasswordGuessLimitMetrics]: number };
const emptyMetrics = (): MutableMetrics => ({
  refused: 0,
  wouldRefuse: 0,
  wouldRefuseThenAccepted: 0,
  inFlightCapped: 0,
  deviceRecognised: 0,
  deviceSuspended: 0,
  failOpen: 0,
});
let metrics = emptyMetrics();
let sinceLastLog = emptyMetrics();
let lastLogAt = Number.NEGATIVE_INFINITY;
const LOG_INTERVAL_MS = 60_000;

export function passwordGuessLimitMetrics(): PasswordGuessLimitMetrics {
  return { ...metrics };
}

function count(name: keyof MutableMetrics, mode: AccountGuessLimitMode): void {
  metrics[name] += 1;
  sinceLastLog[name] += 1;
  const now = Date.now();
  if (now - lastLogAt < LOG_INTERVAL_MS) return;
  lastLogAt = now;
  logger.info('[PasswordGuess] Account guess limit activity', {
    type: 'password_guess_limit',
    mode,
    ...sinceLastLog,
  });
  sinceLastLog = emptyMetrics();
}

const inFlight = new Map<string, number>();

export function __resetPasswordGuessLimitStateForTests(): void {
  metrics = emptyMetrics();
  sinceLastLog = emptyMetrics();
  lastLogAt = Number.NEGATIVE_INFINITY;
  inFlight.clear();
}

/**
 * Bounds the queue on one subject's row lock: a burst at one email holds at
 * most this many reserves per process, far inside the deadline, instead of
 * piling up until every later reserve fails open.
 */
async function reserveCapped(
  store: PasswordGuessStore,
  subject: PasswordGuessSubject | null,
  mode: AccountGuessLimitMode,
  timing: { readonly now?: Date; readonly deadlineMs?: number },
): Promise<PasswordGuessReservation | { readonly outcome: 'capped' }> {
  if (subject === null) return reservePasswordGuess(store, null);
  const key = `${subject.kind}:${subject.key}`;
  const running = inFlight.get(key) ?? 0;
  if (running >= PASSWORD_GUESS_IN_FLIGHT_CAP) {
    count('inFlightCapped', mode);
    return { outcome: 'capped' };
  }
  inFlight.set(key, running + 1);
  try {
    return await reservePasswordGuess(store, subject, timing);
  } finally {
    const left = (inFlight.get(key) ?? 1) - 1;
    if (left <= 0) inFlight.delete(key);
    else inFlight.set(key, left);
  }
}

const NOTHING_TO_SETTLE: PasswordGuessAdmission = { outcome: 'proceed', settle: async () => {} };

function proceedWith(
  store: PasswordGuessStore,
  reservation: ReservedPasswordGuess,
  counted: CountedGuess,
  writeOptions: { readonly deadlineMs?: number },
): PasswordGuessAdmission {
  return {
    outcome: 'proceed',
    counted,
    async settle(verdict) {
      if (verdict !== 'rejected') await giveBackPasswordGuess(store, reservation, writeOptions);
    },
  };
}

/**
 * Counted into the once-a-minute activity line, never logged per attempt: any
 * account holder can produce one (wrong passwords to the cap, then the right
 * one), so a line each would let them flood the log.
 */
function countWouldRefuseAccepted(mode: AccountGuessLimitMode): void {
  count('wouldRefuseThenAccepted', mode);
}

type Recognition =
  | { readonly kind: 'none' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'capped' }
  | { readonly kind: 'recognised'; readonly userId: string };

export function createPasswordGuessLimiter(options: {
  readonly mode: AccountGuessLimitMode;
  /** Read on each use, so a limiter that stays `off` never opens a pool. */
  readonly store: () => PasswordGuessStore;
  readonly environment?: Environment;
  readonly now?: () => Date;
  /** Tests on a loaded machine pass a longer one; production keeps the 250 ms default. */
  readonly deadlineMs?: number;
}): PasswordGuessLimiter {
  const { mode } = options;
  const environment = options.environment ?? process.env;
  const writeOptions = options.deadlineMs ? { deadlineMs: options.deadlineMs } : {};

  /** The account a valid, still-current device token names; `unavailable` when it cannot be told. */
  async function recognisedAccount(
    email: string,
    deviceToken: unknown,
    candidateUserId: string | undefined,
    deadlineMs: number,
  ): Promise<Recognition> {
    if (typeof deviceToken !== 'string' || deviceToken.length === 0) return { kind: 'none' };
    // Without both keys no token can be recognised: skip the read.
    if (!('secret' in readDeviceTokenSecret(environment)) || passwordGuessEmailKey(environment) === null)
      return { kind: 'none' };
    const subject = passwordGuessEmailSubject(email, environment);
    if (subject === null) return { kind: 'none' };
    // Recognition itself reads the store. Bound that work before a forged or
    // genuine token can queue unlimited lookups ahead of the reserve cap.
    const lookupKey = `recognition:${subject.key}`;
    const running = inFlight.get(lookupKey) ?? 0;
    if (running >= PASSWORD_GUESS_IN_FLIGHT_CAP) {
      count('inFlightCapped', mode);
      return { kind: 'capped' };
    }
    inFlight.set(lookupKey, running + 1);
    let accounts: Awaited<ReturnType<typeof readPasswordGuessAccounts>>;
    try {
      accounts = await readPasswordGuessAccounts(options.store(), email, { deadlineMs });
    } finally {
      const left = (inFlight.get(lookupKey) ?? 1) - 1;
      if (left <= 0) inFlight.delete(lookupKey);
      else inFlight.set(lookupKey, left);
    }
    if (accounts === 'unavailable') return { kind: 'unavailable' };
    for (const account of accounts) {
      if (candidateUserId !== undefined && account.userId !== candidateUserId) continue;
      const claims = await verifyPresentedDeviceToken(deviceToken, account.userId, environment);
      if (!claims) continue;
      // A password change voids every token issued before it. With no timestamp
      // to check against, the token cannot be shown to be newer: it counts as absent.
      if (
        !account.passwordChangedAt ||
        claims.issuedAt.getTime() < account.passwordChangedAt.getTime() - DEVICE_TOKEN_PASSWORD_CHANGE_TOLERANCE_MS
      )
        continue;
      return { kind: 'recognised', userId: account.userId };
    }
    return { kind: 'none' };
  }

  function atCap(retryAfterSeconds: number): PasswordGuessAdmission {
    if (mode === 'enforce') {
      count('refused', mode);
      return { outcome: 'refused', retryAfterSeconds };
    }
    // Every request enforce would refuse must retain its successful-password
    // verdict in observe, including a burst that reaches an in-flight cap.
    count('wouldRefuse', mode);
    return {
      outcome: 'proceed',
      wouldRefuse: true,
      async settle(verdict) {
        if (verdict === 'accepted') countWouldRefuseAccepted(mode);
      },
    };
  }

  return {
    mode,
    async admit({ email, deviceToken, candidateUserId }) {
      if (mode === 'off') return NOTHING_TO_SETTLE;
      const store = options.store();
      // One deadline for the whole admission: however many store calls it makes,
      // a sign-in waits at most this long before its compare.
      const deadlineAt = Date.now() + (options.deadlineMs ?? PASSWORD_GUESS_DEADLINE_MS);
      const remaining = () => deadlineAt - Date.now();
      const timing = () => ({
        ...(options.now ? { now: options.now() } : {}),
        deadlineMs: Math.max(1, remaining()),
      });

      const recognised = await recognisedAccount(email, deviceToken, candidateUserId, Math.max(1, remaining()));
      if (recognised.kind === 'capped') return atCap(1);
      if (recognised.kind === 'unavailable') {
        // The device may be the owner's; never count or refuse it on a guess.
        count('failOpen', mode);
        return NOTHING_TO_SETTLE;
      }
      if (recognised.kind === 'recognised') {
        if (remaining() <= 0) {
          count('failOpen', mode);
          return NOTHING_TO_SETTLE;
        }
        const device = await reserveCapped(
          store,
          passwordGuessAccountSubject(recognised.userId, environment),
          mode,
          timing(),
        );
        if (device.outcome === 'reserved') {
          count('deviceRecognised', mode);
          return proceedWith(
            store,
            device.reservation,
            {
              id: randomUUID(),
              bucket: 'account',
              userId: recognised.userId,
              windows: device.reservation.windows,
            },
            writeOptions,
          );
        }
        if (device.outcome === 'unavailable') {
          count('failOpen', mode);
          return NOTHING_TO_SETTLE;
        }
        // The account's devices used their 20 this hour (or have 4 reserves
        // running): count against the email instead.
        count('deviceSuspended', mode);
      }

      if (remaining() <= 0) {
        count('failOpen', mode);
        return NOTHING_TO_SETTLE;
      }
      const byEmail = await reserveCapped(store, passwordGuessEmailSubject(email, environment), mode, timing());
      if (byEmail.outcome === 'reserved')
        return proceedWith(
          store,
          byEmail.reservation,
          { id: randomUUID(), bucket: 'email', windows: byEmail.reservation.windows },
          writeOptions,
        );
      if (byEmail.outcome === 'unavailable') {
        count('failOpen', mode);
        return NOTHING_TO_SETTLE;
      }
      const retryAfterSeconds = byEmail.outcome === 'capped' ? 1 : Math.max(1, byEmail.retryAfterSeconds);
      return atCap(retryAfterSeconds);
    },
    async settleCounted(email, counted, verdict, wouldRefuse) {
      if (mode === 'off') return;
      if (wouldRefuse && verdict === 'accepted') countWouldRefuseAccepted(mode);
      if (!counted) return;
      const subject =
        counted.bucket === 'account'
          ? passwordGuessAccountSubject(counted.userId ?? '', environment)
          : passwordGuessEmailSubject(email, environment);
      if (subject === null) return;
      await giveBackPasswordGuessOnce(options.store(), { subject, windows: counted.windows }, counted.id, writeOptions);
    },
    async clearEmail(email) {
      if (mode === 'off') return;
      await clearPasswordGuesses(options.store(), passwordGuessEmailSubject(email, environment), writeOptions);
    },
  };
}

let processLimiter: PasswordGuessLimiter | undefined;
let testLimiter: PasswordGuessLimiter | undefined;

/** The process limiter, from the environment checked at startup, on the counter's own pool. */
export function passwordGuessLimiter(): PasswordGuessLimiter {
  if (testLimiter) return testLimiter;
  processLimiter ??= createPasswordGuessLimiter({ mode: accountGuessLimitMode(), store: passwordGuessDatabase });
  return processLimiter;
}

/** Tests build `enforce` here; the environment cannot reach it while a code gate is open. */
export function __setPasswordGuessLimiterForTests(limiter: PasswordGuessLimiter | undefined): void {
  testLimiter = limiter;
  processLimiter = undefined;
}
