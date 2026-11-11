import { drizzle } from 'drizzle-orm/postgres-js';
import type { Logger, SQLWrapper } from 'drizzle-orm';
import postgres from 'postgres';
import { getConnectionConfig, isLocalDevelopment } from './config';
import { withConnectRetry } from './connect-retry';
import * as schema from '../schema/index';
import * as relations from '../relations/index';

class QueryLogger implements Logger {
  logQuery(query: string, params: unknown[]): void {
    const timestamp = new Date().toISOString();
    console.info(`[SQL ${timestamp}] ${query}`);
    if (params.length > 0) {
      console.info(`[SQL params] ${JSON.stringify(params)}`);
    }
  }
}

const sqlLogger = process.env.DEBUG_SQL === 'true' ? new QueryLogger() : undefined;

const fullSchema = { ...schema, ...relations };

/**
 * Pool size when `DB_POOL_MAX` is unset. It was 10 until the 2026-09 connection
 * budget: postgres.js round-robins over every open connection, so a pool sits at
 * its `max` even though fleet-wide concurrency averages under one active
 * statement. 5 per process keeps the whole fleet well under
 * `max_connections`; see docs/db-connectivity.md, "Connection budget".
 */
export const DEFAULT_POOL_MAX = 5;
/** Seconds an idle connection is held when `DB_POOL_IDLE_TIMEOUT_S` is unset. */
export const DEFAULT_POOL_IDLE_TIMEOUT_S = 30;
/** Serverless (Vercel) pool defaults — smaller per-lambda footprint; see docs/db-connectivity.md § pool sizing. */
export const SERVERLESS_DEFAULT_POOL_MAX = 3;
export const SERVERLESS_DEFAULT_POOL_IDLE_TIMEOUT_S = 5;
/**
 * A climb page issues its climb and all-angle reads sequentially, and drizzle's
 * connect-retry can hold a slot while it re-dials. A pool of one serialises
 * every request behind a single connection. Clamp rather than trust a typo in
 * a dashboard.
 */
export const MIN_POOL_MAX = 2;
/**
 * The idle knob has no floor, on purpose. postgres.js reads a falsy
 * `idle_timeout` as "never close an idle connection" (`connection.js`'s
 * `timer()` returns a no-op pair for `!seconds`), which is a meaningful setting
 * and the pre-knob behaviour of several drivers. Clamping `0` up to `1` would
 * turn "hold connections open" into "tear one down a second after it goes idle"
 * — the opposite of the request, and a TCP+TLS+startup round trip on the front
 * of most requests.
 */
export const MIN_POOL_IDLE_TIMEOUT_S = 0;
/**
 * postgres.js builds one connection object per slot up front, so `max` is
 * memory before it is connections: 100000 took 736 MB of heap and 1000000 ran
 * out of memory. 100 is already past the whole database's `max_connections`.
 */
export const MAX_POOL_MAX = 100;

/**
 * Mirrors `readEnvInt` in connect-retry.ts: a missing or unparseable value falls
 * back, a parseable one is clamped to `minimum`, and to `maximum` with a warning
 * when one is given.
 */
function readPoolInt(name: string, fallback: number, minimum: number, maximum?: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  if (maximum !== undefined && parsed > maximum) {
    console.warn(`[db] ${name}=${raw} is above ${maximum}; using ${maximum}`);
    return maximum;
  }
  return Math.max(minimum, parsed);
}

/**
 * `DB_POOL_MAX` as every pool in a process should read it: unset or unparseable
 * gives `fallback`, anything else is clamped to `MIN_POOL_MAX` and, with a
 * warning, to `MAX_POOL_MAX`. Exported for the sync daemons, which build their
 * own postgres.js pools and keep their own default, so that one variable caps
 * them the same way it caps `createDb()`.
 */
export function resolvePoolMax(fallback: number = DEFAULT_POOL_MAX): number {
  return readPoolInt('DB_POOL_MAX', fallback, MIN_POOL_MAX, MAX_POOL_MAX);
}

/**
 * Per-deployment pool knobs. On Vercel the defaults are the serverless pair
 * above; everywhere else (backend, sync jobs, scripts) they are
 * `DEFAULT_POOL_MAX` / `DEFAULT_POOL_IDLE_TIMEOUT_S` unless the env var is set.
 *
 * The split exists because peak server-side connections scale with
 * *instance count* × held-idle connections, not with per-instance `max`.
 *
 * `prepare: false` is required when the target is PgBouncer in transaction
 * pooling mode (Railway's pooled URL): backends are reused across transactions
 * so per-connection prepared statement caches collide. The flag is a safe no-op
 * against direct PostgreSQL.
 *
 * Read at pool-construction time rather than module load so a process that
 * rebuilds its pool (tests, HMR) picks up the current environment.
 */
/**
 * Postgres NOTICE frames, deduplicated per process.
 *
 * postgres.js `console.log`s every notice when `onnotice` is unset, and
 * `CheckMyDatabase` emits one on EVERY new backend connection. On Vercel,
 * where instances are short-lived and the pool idles out in seconds, that
 * approximates one log line per request: production carries a standing
 * `collation version mismatch` notice that accounted for roughly a quarter of
 * all function invocations' log output.
 *
 * Swallowing notices outright would hide a genuinely new one, so keep the
 * first of each kind and drop the repeats. Per process is the right lifetime —
 * a fresh instance reports once, and a condition that clears stops being
 * reported when instances cycle.
 */
const reportedNoticeKeys = new Set<string>();

/** Exported for tests: the dedupe is the whole behaviour, so it needs to be observable. */
export function handlePostgresNotice(
  notice: { code?: string; message?: string },
  log: (message: string) => void = console.warn,
): void {
  const key = notice.code ?? notice.message ?? 'unknown';
  if (reportedNoticeKeys.has(key)) return;
  reportedNoticeKeys.add(key);
  log(`[db] postgres notice ${notice.code ?? '(no code)'}: ${notice.message ?? '(no message)'}`);
}

/** Test seam: the dedupe set is process-global, so a test that asserts on it must reset it. */
export function resetReportedPostgresNotices(): void {
  reportedNoticeKeys.clear();
}

function basePoolOptions() {
  const isServerless = Boolean(process.env.VERCEL);
  return {
    max: resolvePoolMax(isServerless ? SERVERLESS_DEFAULT_POOL_MAX : DEFAULT_POOL_MAX),
    idle_timeout: readPoolInt(
      'DB_POOL_IDLE_TIMEOUT_S',
      isServerless ? SERVERLESS_DEFAULT_POOL_IDLE_TIMEOUT_S : DEFAULT_POOL_IDLE_TIMEOUT_S,
      MIN_POOL_IDLE_TIMEOUT_S,
    ),
    connect_timeout: 30,
    prepare: false,
    onnotice: handlePostgresNotice,
    ...startupParameterOptions(),
  };
}

const IDLE_IN_TRANSACTION_TIMEOUT_VARIABLE = 'DB_IDLE_IN_TRANSACTION_TIMEOUT_MS';

/**
 * `DB_STATEMENT_TIMEOUT_MS` as it has always been read: `parseInt`, so `8000ms`
 * is 8000; nothing when unset, unparseable or not positive.
 */
function readStatementTimeoutMs(): number | undefined {
  const raw = process.env.DB_STATEMENT_TIMEOUT_MS;
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed;
}

/** Below a second is almost certainly seconds typed as milliseconds. */
export const MIN_IDLE_IN_TRANSACTION_TIMEOUT_MS = 1_000;
/** PostgreSQL's own ceiling for the setting; above it every connection fails. */
export const MAX_IDLE_IN_TRANSACTION_TIMEOUT_MS = 2_147_483_647;

/**
 * `DB_IDLE_IN_TRANSACTION_TIMEOUT_MS`, strictly. Unset or empty means nothing to
 * send, and `0` means off. Anything else must be whole milliseconds from
 * `MIN_IDLE_IN_TRANSACTION_TIMEOUT_MS` to `MAX_IDLE_IN_TRANSACTION_TIMEOUT_MS`,
 * or the process fails at boot: `60` (seconds by mistake) would end nearly every
 * transaction, `99999999999` would fail every connection, and `60s` has no
 * reading we could trust.
 */
function readIdleInTransactionTimeoutMs(): number | undefined {
  const raw = process.env[IDLE_IN_TRANSACTION_TIMEOUT_VARIABLE]?.trim();
  if (!raw || raw === '0') return undefined;
  const parsed = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < MIN_IDLE_IN_TRANSACTION_TIMEOUT_MS ||
    parsed > MAX_IDLE_IN_TRANSACTION_TIMEOUT_MS
  ) {
    throw new Error(
      `${IDLE_IN_TRANSACTION_TIMEOUT_VARIABLE} must be 0 (off) or whole milliseconds from ${MIN_IDLE_IN_TRANSACTION_TIMEOUT_MS} to ${MAX_IDLE_IN_TRANSACTION_TIMEOUT_MS}; got ${JSON.stringify(raw)}.`,
    );
  }
  return parsed;
}

/**
 * Session timeouts sent as startup parameters. Unitless values are milliseconds
 * to PostgreSQL.
 *
 * - `DB_STATEMENT_TIMEOUT_MS` → `statement_timeout`. Deliberately OFF by
 *   default: PgBouncer in transaction-pooling mode rejects startup parameters
 *   that are not in `ignore_startup_parameters`, and `statement_timeout` is not
 *   allowed there by default — so turning this on against a pooled URL fails
 *   *every* connection rather than bounding one query. Against a pooler, set it
 *   on the role instead: `ALTER ROLE <app_role> SET statement_timeout = '8s'`.
 * - `DB_IDLE_IN_TRANSACTION_TIMEOUT_MS` → `idle_in_transaction_session_timeout`.
 *   Unset here, so scripts, workers and daemons keep the server default (off).
 *   Request-serving processes set it through `applyRequestPoolDefaults()`. It
 *   has the same PgBouncer hazard.
 *
 * See docs/db-connectivity.md.
 */
function startupParameterOptions(): {
  connection?: { statement_timeout?: number; idle_in_transaction_session_timeout?: number };
} {
  const statementTimeout = readStatementTimeoutMs();
  const idleInTransactionTimeout = readIdleInTransactionTimeoutMs();
  if (statementTimeout === undefined && idleInTransactionTimeout === undefined) return {};
  return {
    connection: {
      ...(statementTimeout === undefined ? {} : { statement_timeout: statementTimeout }),
      ...(idleInTransactionTimeout === undefined
        ? {}
        : { idle_in_transaction_session_timeout: idleInTransactionTimeout }),
    },
  };
}

/**
 * How long a request-serving process lets a session sit idle inside an open
 * transaction before Postgres ends the session. The reasoning for 60 s is in
 * docs/db-connectivity.md, "Idle transactions end after 60 s on request pools".
 */
export const REQUEST_POOL_IDLE_IN_TRANSACTION_TIMEOUT_MS = 60_000;

/**
 * Marks this process as one that serves requests (the backend's HTTP/GraphQL
 * server, the web server), so every pool it builds from here on sends
 * `idle_in_transaction_session_timeout`. An explicit
 * `DB_IDLE_IN_TRANSACTION_TIMEOUT_MS` wins; unset or empty gets the 60 s
 * default; `0` turns it off. A value out of range throws here, at boot.
 *
 * Call it before the first `createDb()`. The shared pools are built once per
 * process, so one built earlier would keep running without the timeout; this
 * throws instead of letting that pass silently. A pool built with the same
 * setting (Next.js re-evaluating a module in dev) is fine.
 */
export function applyRequestPoolDefaults(): void {
  if (!process.env[IDLE_IN_TRANSACTION_TIMEOUT_VARIABLE]?.trim()) {
    process.env[IDLE_IN_TRANSACTION_TIMEOUT_VARIABLE] = String(REQUEST_POOL_IDLE_IN_TRANSACTION_TIMEOUT_MS);
  }
  const expected = readIdleInTransactionTimeoutMs();
  for (const pool of [cache.client, cache.readClient]) {
    if (pool && pool.options.connection.idle_in_transaction_session_timeout !== expected) {
      throw new Error(
        'applyRequestPoolDefaults(): a shared Postgres pool already exists with a different idle_in_transaction_session_timeout. Call it before anything that calls createDb(), and restart the process after changing DB_IDLE_IN_TRANSACTION_TIMEOUT_MS.',
      );
    }
  }
}

const LOCAL_HOST_PATTERN = /@(localhost|127\.0\.0\.1|\[::1\]|postgres|postgres-test)(:|\/|$)/;
const TAILSCALE_IPV4_PATTERN = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./;

function connectionHostname(connectionString: string): string | null {
  try {
    const parsedUrl = new URL(connectionString);
    return parsedUrl.hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1');
  } catch {
    return null;
  }
}

function isPlaintextDevelopmentDatabase(connectionString: string): boolean {
  if (!isLocalDevelopment()) return false;

  const hostname = connectionHostname(connectionString);
  if (!hostname) return false;

  const generatedDevDbHost = process.env.BOARDSESH_DEV_DB_HOST?.toLowerCase();
  if (process.env.BOARDSESH_DEV_DB_PLAINTEXT === 'true' && generatedDevDbHost === hostname) {
    return true;
  }

  return hostname.endsWith('.ts.net') || TAILSCALE_IPV4_PATTERN.test(hostname) || hostname.startsWith('fd7a:');
}

function buildPoolOptions(connectionString: string) {
  const options = basePoolOptions();
  // Explicit verification must win over the legacy encryption-only default,
  // including for localhost. An object also keeps NODE_TLS_REJECT_UNAUTHORIZED
  // from weakening this pool. Both primary and replica use this factory.
  const tlsModes = new URL(connectionString).searchParams.getAll('sslmode');
  if (tlsModes.length > 1) throw new Error('Database URL must not repeat sslmode');
  if (tlsModes.includes('verify-full')) {
    return { ...options, ssl: { rejectUnauthorized: true } };
  }
  // postgres-js does not enforce TLS unless told. Force SSL for non-local
  // hosts so a misconfigured DATABASE_URL (missing `?sslmode=require`) cannot
  // silently degrade to plaintext against Railway. Local docker and generated
  // tailnet dev DB URLs stay plain.
  const isLocal = LOCAL_HOST_PATTERN.test(connectionString) || isPlaintextDevelopmentDatabase(connectionString);
  return isLocal ? options : { ...options, ssl: 'require' as const };
}

// Cache the pool/db on globalThis so Next.js HMR re-evaluating this module in
// dev does not orphan TCP pools and exhaust `max` after a few file saves.
type DbCache = {
  client?: ReturnType<typeof postgres>;
  db?: ReturnType<typeof drizzle>;
  readClient?: ReturnType<typeof postgres>;
  readDb?: ReturnType<typeof drizzle>;
};

const globalForDb = globalThis as unknown as { __boardseshDb?: DbCache };
const cache: DbCache = (globalForDb.__boardseshDb ??= {});

export function createDb() {
  if (!cache.db) {
    const { connectionString } = getConnectionConfig();
    cache.client = postgres(connectionString, buildPoolOptions(connectionString));
    // drizzle gets a retry-wrapped view of the pool: every statement it issues
    // goes through `unsafe()`, and a statement that dies before it was
    // dispatched (DNS/TCP connect failure) is retried instead of surfacing as a
    // 500. See connect-retry.ts for why that is write-safe. drizzle mutates
    // `client.options.parsers` on construction; the proxy forwards `options` to
    // the real pool object, so the parser GUARANTEE below still holds.
    cache.db = drizzle(withConnectRetry(cache.client), { schema: fullSchema, logger: sqlLogger });
  }
  return cache.db;
}

/**
 * Raw postgres.js pool for the primary. GUARANTEE: the drizzle wrapper is always
 * constructed before the pool is handed out (createDb runs first), so drizzle's
 * transparent timestamp/date parsers (OIDs 1114/1184/…) are installed on
 * `client.options.parsers` and raw queries return pg-text timestamps, not JS
 * Dates. Consumers that stream raw rows and expect resolver-shaped values (e.g.
 * the board-snapshot export) rely on this — never return a pool from here
 * without constructing drizzle over it first.
 *
 * This is the raw pool, without the connect-retry wrapper drizzle gets: tagged
 * templates and cursors compose in ways a re-runnable single statement does
 * not. Raw callers that want the retry can wrap one statement in
 * `withDbConnectRetry`.
 */
export function createPool() {
  if (!cache.client) {
    createDb();
  }
  return cache.client!;
}

/**
 * What a dedicated pool may set for itself. These take effect only here:
 * postgres.js copies `connect_timeout` when it builds each connection, so writing
 * `pool.options` afterwards does nothing. TLS and pooler handling stay shared.
 */
export type DedicatedPoolOverrides = {
  /** Seconds to open a connection, in place of the shared 30. */
  connect_timeout?: number;
  /** Startup parameters, merged over the shared ones and over the same names in the URL. */
  connection?: Partial<postgres.ConnectionParameters>;
};

/**
 * postgres.js lets a URL query parameter beat the same startup parameter given
 * in options, so `?statement_timeout=45000` in DATABASE_URL would undo an
 * override. Removes only the parameters the caller overrides.
 */
function withoutOverriddenUrlParameters(connectionString: string, overriddenNames: readonly string[]): string {
  const url = new URL(connectionString);
  const conflictingNames = overriddenNames.filter((name) => url.searchParams.has(name));
  if (conflictingNames.length === 0) return connectionString;
  for (const name of conflictingNames) url.searchParams.delete(name);
  return url.href;
}

/**
 * A pool of its own for work that must not compete with the shared one for
 * connections. Same TLS and pooler handling as the primary, but never cached:
 * the caller owns it, closes it, and wraps it in drizzle before reading through it.
 */
export function createDedicatedPool(max: number, overrides: DedicatedPoolOverrides = {}): PoolInstance {
  const { connectionString } = getConnectionConfig();
  const sharedOptions = buildPoolOptions(connectionString);
  const dedicatedConnectionString = withoutOverriddenUrlParameters(
    connectionString,
    Object.keys(overrides.connection ?? {}),
  );
  return postgres(dedicatedConnectionString, {
    ...sharedOptions,
    ...overrides,
    max,
    connection: { ...sharedOptions.connection, ...overrides.connection },
  });
}

/**
 * The full-schema drizzle handle `createDb()` builds, over a pool the caller
 * owns (usually a `createDedicatedPool`), with the same connect retry. Closing
 * the pool is still the caller's job.
 */
export function createDbOnPool(pool: PoolInstance): DbInstance {
  return drizzle(withConnectRetry(pool), { schema: fullSchema, logger: sqlLogger });
}

export async function closePool(): Promise<void> {
  try {
    if (cache.client) {
      await cache.client.end();
    }
  } finally {
    cache.client = undefined;
    cache.db = undefined;
  }
}

function ensureReadConnection(readReplicaUrl: string) {
  if (!cache.readClient || !cache.readDb) {
    cache.readClient = postgres(readReplicaUrl, buildPoolOptions(readReplicaUrl));
    cache.readDb = drizzle(withConnectRetry(cache.readClient), { schema: fullSchema, logger: sqlLogger });
  }
  return { readClient: cache.readClient, readDb: cache.readDb };
}

/**
 * Returns a drizzle instance pointed at READ_REPLICA_URL. When the env var is
 * unset, returns the primary `db` so call sites don't need to branch — this
 * makes wiring the seam in safe before a replica exists.
 */
export function createReadDb() {
  const { readReplicaUrl } = getConnectionConfig();
  if (!readReplicaUrl) {
    return createDb();
  }
  return ensureReadConnection(readReplicaUrl).readDb;
}

/**
 * Raw postgres.js pool for reads. Same parser GUARANTEE as createPool: both
 * branches construct the drizzle wrapper before returning the raw pool (no
 * replica → createPool → createDb; replica → ensureReadConnection creates
 * readClient and readDb together), so callers get drizzle's transparent
 * timestamp parsers without having to call createReadDb() themselves.
 */
export function createReadPool() {
  const { readReplicaUrl } = getConnectionConfig();
  if (!readReplicaUrl) {
    return createPool();
  }
  return ensureReadConnection(readReplicaUrl).readClient;
}

export async function closeReadPool(): Promise<void> {
  try {
    if (cache.readClient) {
      await cache.readClient.end();
    }
  } finally {
    cache.readClient = undefined;
    cache.readDb = undefined;
  }
}

type ExecuteConnection = {
  execute(query: SQLWrapper | string): PromiseLike<unknown>;
};

type CommandCountResult = {
  count?: number | bigint;
  rowCount?: number | bigint;
};

export function rowsFromResult<T>(result: unknown): T[] {
  if (Array.isArray(result)) {
    return result as T[];
  }

  throw new TypeError('Expected postgres-js query result to be a row array');
}

export function firstRowFromResult<T>(result: unknown): T | undefined {
  return rowsFromResult<T>(result)[0];
}

export async function executeRows<T>(conn: ExecuteConnection, query: SQLWrapper | string): Promise<T[]> {
  return rowsFromResult<T>(await conn.execute(query));
}

export async function executeFirstRow<T>(conn: ExecuteConnection, query: SQLWrapper | string): Promise<T | undefined> {
  return firstRowFromResult<T>(await conn.execute(query));
}

export function commandCountFromResult(result: unknown): number | undefined {
  if (!result || typeof result !== 'object') {
    return undefined;
  }

  const raw = result as CommandCountResult;
  const value = raw.count ?? raw.rowCount;
  if (value === undefined) {
    return undefined;
  }

  return Number(value);
}

export async function executeCommandCount(
  conn: ExecuteConnection,
  query: SQLWrapper | string,
): Promise<number | undefined> {
  return commandCountFromResult(await conn.execute(query));
}

export type DbInstance = ReturnType<typeof createDb>;
export type PoolInstance = ReturnType<typeof postgres>;
