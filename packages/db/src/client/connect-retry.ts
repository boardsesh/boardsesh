import type postgres from 'postgres';

/**
 * Bounded retry for Postgres *connect* failures.
 *
 * postgres.js attaches the first query of a fresh connection to the connect
 * attempt itself (`handler()` -> `connect(closed.shift(), query)`,
 * postgres/src/index.js:337). If that connect fails, the query is rejected
 * outright, so a single DNS blip or refused TCP connect turns into one
 * user-visible 500 even though the statement never reached the server.
 *
 * WRITE SAFETY. We retry only the error codes that are structurally impossible
 * once a statement has been dispatched. postgres.js starts `connectTimer` at
 * connection.js:343 and cancels it at connection.js:552, inside the
 * ReadyForQuery handler, *before* `execute(initial)` at connection.js:567. DNS
 * and TCP errors (ECONNREFUSED / EAI_AGAIN / EAI_NODATA / ENOTFOUND) come from
 * the socket before any protocol byte is written. So an error carrying one of
 * these codes proves the server never saw the statement, and re-running it
 * cannot double-execute a write.
 *
 * Everything else is rethrown unchanged — in particular CONNECTION_CLOSED and
 * `read ETIMEDOUT`, which postgres.js emits both for a socket that died while
 * connecting and for one that died with a query in flight. Those are
 * indistinguishable at the error object, so retrying them could re-run a write.
 */
const RETRYABLE_CONNECT_ERROR_CODES: ReadonlySet<string> = new Set([
  'CONNECT_TIMEOUT',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'EAI_NODATA',
  'ENOTFOUND',
]);

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 150;
const DEFAULT_MAX_DELAY_MS = 600;
/**
 * Wall-clock budget for the whole retry loop, checked *before* scheduling
 * another attempt. This is what stops the retry from amplifying a real outage:
 * `connect_timeout` is 30s, so a CONNECT_TIMEOUT already burned 30s and blew
 * the budget — it is rethrown immediately instead of doubling the user's wait
 * and holding a second pool slot. During a blip the DNS/TCP codes fail in
 * milliseconds and the retry does its job.
 *
 * The budget also bounds a second, less obvious cost. postgres.js paces its own
 * connect attempts with a pool-wide backoff: `options.shared.retries` increments
 * on every errored close (connection.js:455) and `connection.connect()` waits
 * `backoff(retries)` seconds — capped at 20 — before opening a socket
 * (connection.js:113-116 -> reconnect() at :362), resetting only on a success
 * (connection.js:568). So deep into an outage even an ECONNREFUSED costs
 * seconds, and issuing three connects per statement ramps that counter faster.
 * The budget check after each attempt is what keeps a single request from
 * absorbing more than roughly two of those. Details and measurements:
 * docs/db-connectivity.md.
 */
const DEFAULT_BUDGET_MS = 10_000;

export type DbConnectRetryEvent = {
  /** 1-based index of the attempt that just failed. */
  attempt: number;
  maxAttempts: number;
  /** Delay before the next attempt, after jitter. */
  delayMs: number;
  /** Milliseconds since the first attempt started. */
  elapsedMs: number;
  code: string;
};

export type DbConnectObserver = (event: DbConnectRetryEvent) => void;

/**
 * `packages/db` has no logger and no Sentry dependency, so the observer is how
 * a host process (the backend) gets structured visibility into retries without
 * this package reaching for `console.*`.
 */
let connectObserver: DbConnectObserver | null = null;

export function setDbConnectObserver(observer: DbConnectObserver | null): void {
  connectObserver = observer;
}

export type DbConnectRetryOptions = {
  /** Total attempts including the first. Defaults to `DB_CONNECT_ATTEMPTS` or 3. */
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Defaults to `DB_CONNECT_RETRY_BUDGET_MS` or 10000. */
  budgetMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
};

function readEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function connectErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const { code } = error as { code?: unknown };
  if (typeof code !== 'string') return null;
  return RETRYABLE_CONNECT_ERROR_CODES.has(code) ? code : null;
}

export function isRetryableConnectError(error: unknown): boolean {
  return connectErrorCode(error) !== null;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // Never hold a process open just to pace a retry.
    timer.unref?.();
  });
}

export function backoffDelayMs(attempt: number, baseDelayMs: number, maxDelayMs: number, random: () => number): number {
  const target = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  // Full ±50% jitter so a fleet of instances reconnecting after a blip does not
  // hit the database in lockstep.
  return Math.round(target * (0.5 + random()));
}

/**
 * Runs `execute` and retries it while it fails with a pre-dispatch connect
 * error. `execute` MUST be a single statement (or an otherwise re-runnable
 * unit) — never a multi-statement sequence or a transaction body, because a
 * later statement failing to connect would re-run the earlier ones.
 */
export async function withDbConnectRetry<T>(
  execute: () => PromiseLike<T>,
  options: DbConnectRetryOptions = {},
): Promise<T> {
  const maxAttempts = Math.max(1, options.attempts ?? readEnvInt('DB_CONNECT_ATTEMPTS', DEFAULT_ATTEMPTS));
  const budgetMs = options.budgetMs ?? readEnvInt('DB_CONNECT_RETRY_BUDGET_MS', DEFAULT_BUDGET_MS);
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;

  const startedAt = now();
  let attempt = 1;

  for (;;) {
    try {
      return await execute();
    } catch (error) {
      const code = connectErrorCode(error);
      const elapsedMs = now() - startedAt;
      if (code === null || attempt >= maxAttempts || elapsedMs >= budgetMs) {
        // Rethrow untouched: on a genuine outage the caller sees exactly the
        // error it sees today, just a little later.
        throw error;
      }

      const delayMs = backoffDelayMs(attempt, baseDelayMs, maxDelayMs, random);
      notifyObserver({ attempt, maxAttempts, delayMs, elapsedMs, code });
      await sleep(delayMs);
      attempt += 1;
    }
  }
}

function notifyObserver(event: DbConnectRetryEvent): void {
  if (!connectObserver) return;
  try {
    connectObserver(event);
  } catch {
    // Observability must never turn a recoverable blip into a hard failure.
  }
}

type Pool = ReturnType<typeof postgres>;
type UnsafeArgs = Parameters<Pool['unsafe']>;
type UnsafeQuery = ReturnType<Pool['unsafe']>;

type LazyQuery = {
  values(): unknown;
  raw(): unknown;
  then(onFulfilled?: unknown, onRejected?: unknown): Promise<unknown>;
  catch(onRejected?: unknown): Promise<unknown>;
  finally(onFinally?: unknown): Promise<unknown>;
};

type Settle = ((value: unknown) => unknown) | null | undefined;

/**
 * Builds a lazy stand-in for a postgres.js query that re-creates the query on
 * every retry. postgres.js only dispatches a query when it is awaited
 * (`Query.handle()` runs from `then`/`catch`/`finally`/`execute`), so building
 * one per attempt costs nothing and a rejected query is never re-awaited.
 */
function createRetryingUnsafe(client: Pool, options?: DbConnectRetryOptions) {
  return (...args: UnsafeArgs): UnsafeQuery => {
    let mode: 'rows' | 'values' | 'raw' = 'rows';
    let materialized: UnsafeQuery | undefined;

    const build = (): PromiseLike<unknown> => {
      const query = client.unsafe(...args);
      if (mode === 'values') return query.values();
      if (mode === 'raw') return query.raw();
      return query;
    };

    const run = (): Promise<unknown> => withDbConnectRetry(build, options);

    const lazy: LazyQuery = {
      values() {
        mode = 'values';
        return proxy;
      },
      raw() {
        mode = 'raw';
        return proxy;
      },
      then(onFulfilled?: unknown, onRejected?: unknown) {
        return run().then(onFulfilled as Settle, onRejected as Settle);
      },
      catch(onRejected?: unknown) {
        return run().catch(onRejected as Settle);
      },
      finally(onFinally?: unknown) {
        return run().finally(onFinally as (() => void) | null | undefined);
      },
    };

    const proxy = new Proxy(lazy, {
      get(target, property, receiver) {
        if (property in target) {
          return Reflect.get(target, property, receiver);
        }
        // Anything outside the awaited surface (cursor, stream, describe,
        // forEach, …) gets the stock postgres.js query with no retry: those
        // shapes dispatch and consume incrementally, so re-running them is not
        // the single-statement unit this wrapper is safe for.
        materialized ??= client.unsafe(...args);
        const value = Reflect.get(materialized as object, property);
        return typeof value === 'function' ? value.bind(materialized) : value;
      },
    }) as unknown as UnsafeQuery;

    return proxy;
  };
}

/**
 * Wraps a postgres.js pool so that every *single statement* issued through
 * `unsafe()` retries pre-dispatch connect failures. `unsafe()` is the only path
 * drizzle uses for statements (drizzle-orm/postgres-js/session.js:33,43,65,103,106),
 * so wrapping it covers all drizzle traffic.
 *
 * Deliberately NOT wrapped:
 * - the tagged-template call itself, because `sql(...)` also builds fragments
 *   and helpers whose return value is not an awaitable query;
 * - `begin()` / `savepoint()`, because drizzle runs transaction bodies against
 *   the scoped client postgres.js hands the callback. A transaction that loses
 *   its connection must fail as a whole, never replay half its statements.
 */
export function withConnectRetry<T extends Pool>(client: T, options?: DbConnectRetryOptions): T {
  const retryingUnsafe = createRetryingUnsafe(client, options);

  return new Proxy(client, {
    get(target, property, receiver) {
      if (property === 'unsafe') return retryingUnsafe;
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as T;
}
