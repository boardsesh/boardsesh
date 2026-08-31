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

/** Pool size when `DB_POOL_MAX` is unset — unchanged from before the knob existed. */
export const DEFAULT_POOL_MAX = 10;
/** Seconds an idle connection is held when `DB_POOL_IDLE_TIMEOUT_S` is unset. */
export const DEFAULT_POOL_IDLE_TIMEOUT_S = 30;
/** Serverless (Vercel) pool defaults — smaller per-lambda footprint; see docs/db-connectivity.md § pool sizing. */
export const SERVERLESS_DEFAULT_POOL_MAX = 3;
export const SERVERLESS_DEFAULT_POOL_IDLE_TIMEOUT_S = 5;
/**
 * `getClimb` issues two sequential statements and drizzle's connect-retry can
 * hold a slot while it re-dials, so a pool of one serialises everything behind
 * a single connection. Clamp rather than trust a typo in a dashboard.
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
 * Mirrors `readEnvInt` in connect-retry.ts: a missing or unparseable value falls
 * back, a parseable one is clamped to `minimum`.
 */
function readPoolInt(name: string, fallback: number, minimum: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, parsed);
}

/**
 * Per-deployment pool knobs. On Vercel the defaults are the serverless pair
 * above; everywhere else (backend, sync jobs, scripts) they stay the values
 * that were hard-coded here before, so nothing changes unless the env var is
 * set. The split exists because peak server-side connections scale with
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
    max: readPoolInt('DB_POOL_MAX', isServerless ? SERVERLESS_DEFAULT_POOL_MAX : DEFAULT_POOL_MAX, MIN_POOL_MAX),
    idle_timeout: readPoolInt(
      'DB_POOL_IDLE_TIMEOUT_S',
      isServerless ? SERVERLESS_DEFAULT_POOL_IDLE_TIMEOUT_S : DEFAULT_POOL_IDLE_TIMEOUT_S,
      MIN_POOL_IDLE_TIMEOUT_S,
    ),
    connect_timeout: 30,
    prepare: false,
    onnotice: handlePostgresNotice,
    ...statementTimeoutOption(),
  };
}

/**
 * `DB_STATEMENT_TIMEOUT_MS` emits a `statement_timeout` startup parameter.
 * Deliberately OFF by default: PgBouncer in transaction-pooling mode rejects
 * startup parameters that are not in `ignore_startup_parameters`, and
 * `statement_timeout` is not allowed there by default — so turning this on
 * against a pooled URL fails *every* connection rather than bounding one query.
 * Against a pooler, set it on the role instead:
 * `ALTER ROLE <app_role> SET statement_timeout = '8s'`. See docs/db-connectivity.md.
 */
function statementTimeoutOption(): { connection?: { statement_timeout: number } } {
  const raw = process.env.DB_STATEMENT_TIMEOUT_MS;
  if (!raw) return {};
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return {};
  // Unitless `statement_timeout` is milliseconds to PostgreSQL.
  return { connection: { statement_timeout: parsed } };
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
  // postgres-js does not enforce TLS unless told. Force SSL for non-local
  // hosts so a misconfigured DATABASE_URL (missing `?sslmode=require`) cannot
  // silently degrade to plaintext against Railway. Local docker and generated
  // tailnet dev DB URLs stay plain.
  const isLocal = LOCAL_HOST_PATTERN.test(connectionString) || isPlaintextDevelopmentDatabase(connectionString);
  const options = basePoolOptions();
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
