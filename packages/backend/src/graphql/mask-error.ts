import { GraphQLError } from 'graphql';
import * as Sentry from '@sentry/node';
import { getPostgresErrorCode } from '../utils/postgres-errors';
import { markErrorReported, wasErrorReported } from '../utils/sentry-dedupe';

// drizzle-orm surfaces a driver failure as an Error whose message is the raw
// SQL ("Failed query: select ...") with the real PostgresError on `.cause`.
// graphql-js then wraps the resolver throw, so the leaking text can arrive as
// the top-level error or on its GraphQL `originalError`.
const FAILED_QUERY_PREFIX = 'Failed query:';

// Upper bound on the SQL we attach to a Sentry event. Long enough to identify
// the plan shape, short enough that a pathological IN (...) list can't bloat the
// payload past Sentry's per-event limit and get the whole event dropped.
const MAX_REPORTED_QUERY_LENGTH = 2000;

function getOriginalError(error: unknown): unknown {
  if (error && typeof error === 'object' && 'originalError' in error) {
    return (error as { originalError?: unknown }).originalError;
  }
  return undefined;
}

function messageLeaksQuery(error: unknown): boolean {
  return error instanceof Error && typeof error.message === 'string' && error.message.startsWith(FAILED_QUERY_PREFIX);
}

/**
 * True when this error (or its GraphQL `originalError`) is a raw database/driver
 * failure whose message would leak SQL to the client — either drizzle's
 * "Failed query: ..." wrapper or anything carrying a PostgresError code on its
 * cause chain.
 */
export function isDatabaseLeakError(error: unknown): boolean {
  for (const candidate of [error, getOriginalError(error)]) {
    if (candidate === undefined || candidate === null) continue;
    if (messageLeaksQuery(candidate)) return true;
    if (getPostgresErrorCode(candidate) !== undefined) return true;
  }
  return false;
}

/**
 * The GraphQL field path of a located error ("searchClimbs", "user.ticks"), or
 * undefined for an error that never reached graphql-js. This is what names the
 * offending resolver on an otherwise anonymous driver error.
 */
function getGraphqlPath(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'path' in error) {
    const { path } = error as { path?: unknown };
    if (Array.isArray(path) && path.length > 0) {
      return path.join('.');
    }
  }
  return undefined;
}

/**
 * drizzle's "Failed query: ..." wrapper message, truncated. `unwrapCause` reports
 * the driver error (see below), which deliberately drops this — so we re-attach
 * it as event context instead of losing the only copy of the SQL.
 */
function getFailedQuery(error: unknown): string | undefined {
  for (const candidate of [error, getOriginalError(error)]) {
    if (candidate instanceof Error && messageLeaksQuery(candidate)) {
      return candidate.message.slice(0, MAX_REPORTED_QUERY_LENGTH);
    }
  }
  return undefined;
}

// A numeric segment in a GraphQL error path is a list index ("userTicks.3.climb").
// It names one row, not one failure mode, and it is unbounded — putting it in a
// grouping key mints a fresh Sentry issue per array position.
const LIST_INDEX_SEGMENT = /^\d+$/;

/**
 * The Sentry grouping key for a masked database failure: the SQLSTATE (or driver
 * code) plus the resolver it came from, with list indices normalised away.
 *
 * Sentry's default grouping fingerprints on the captured exception's type and
 * stack. Every error here is a `PostgresError` thrown from the same two frames
 * inside postgres.js, so the default collapses *every* database failure in the
 * service into one issue — BOARDSESH-AK, which by 2026-09 pooled 34 distinct
 * (code, resolver) pairs behind whichever sample event Sentry chose as the title.
 * That is not merely untidy: issue #4737 was filed as a P2 "presence_seq column
 * missing, 32 users" against a bucket whose 32 users were really 53100 disk-full
 * failures, while the six 42703 events that supplied the title came from one
 * developer's local backend. A bucket that mixes causes reports every cause's
 * impact as every other cause's impact.
 *
 * The message is deliberately excluded. It carries per-event noise — the shared
 * memory segment id and byte count in `could not resize shared memory segment
 * "/PostgreSQL.523119486" to 1048576 bytes` differ on every occurrence — and
 * grouping on it would replace one giant issue with thousands of singletons.
 * Code plus resolver is stable across occurrences and distinct across causes,
 * which is exactly what a fingerprint has to be.
 */
export function databaseErrorFingerprint(pgCode: string | undefined, graphqlPath: string | undefined): string[] {
  const resolverPath = (graphqlPath ?? '')
    .split('.')
    .filter((segment) => segment.length > 0 && !LIST_INDEX_SEGMENT.test(segment))
    .join('.');
  return ['graphql-yoga-mask', pgCode ?? 'unknown', resolverPath || 'unknown'];
}

function unwrapCause(error: unknown): unknown {
  const original = getOriginalError(error) ?? error;
  if (original instanceof Error && original.cause !== undefined && original.cause !== null) {
    return original.cause;
  }
  return original;
}

// Postgres SQLSTATE classes and driver codes that mean "the database could not
// be reached or is out of capacity" — the outage shape #4862 is about — as
// opposed to a verdict on one statement. Class 08 is connection_exception,
// class 53 is insufficient_resources (53300 too_many_connections is the one the
// 2026-08-29 incident produced), 57P01-57P04 are the operator-intervention
// shutdown / cannot-connect / database-dropped codes. The rest are postgres.js and Node socket codes
// for a connect that never completed (see packages/db connect-retry.ts and
// docs/db-connectivity.md). 57014 query_canceled is deliberately NOT here: a
// statement timeout on one heavy query is that query's problem.
const UNAVAILABLE_DRIVER_CODES = new Set([
  'CONNECT_TIMEOUT',
  'CONNECTION_CLOSED',
  'CONNECTION_ENDED',
  'CONNECTION_DESTROYED',
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'EPIPE',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
  'EAI_NODATA',
  'ENOTFOUND',
]);

export function isDatabaseUnavailableCode(pgCode: string | undefined): boolean {
  if (!pgCode) return false;
  if (UNAVAILABLE_DRIVER_CODES.has(pgCode)) return true;
  const sqlStateClass = pgCode.slice(0, 2);
  if (sqlStateClass === '08' || sqlStateClass === '53') return true;
  // admin_shutdown, crash_shutdown, cannot_connect_now, database_dropped.
  return pgCode === '57P01' || pgCode === '57P02' || pgCode === '57P03' || pgCode === '57P04';
}

/**
 * graphql-yoga `maskError` that sanitizes ONLY the raw-database-error class so
 * internal SQL and schema never reach clients (issue #3183), while every other
 * error passes through untouched.
 *
 * We deliberately do NOT flip on global masking: that would turn the many
 * intentional `throw new Error(message)` sites across the resolvers into a
 * useless generic string for clients. This targeted mask fixes the info-leak
 * without that regression.
 *
 * The real cause is captured to Sentry (deduped against a resolver-level catch
 * that may have already reported it), then a generic GraphQLError is returned.
 */
export function maskDatabaseError(error: unknown): Error {
  if (isDatabaseLeakError(error)) {
    // Resolve the pg code through the GraphQL `originalError` wrapper too, so
    // it lands on the Sentry tag even when the top-level error is the located
    // GraphQLError (whose own cause chain doesn't reach the driver error), and
    // so the response status below can tell an outage from a bad statement.
    const pgCode = getPostgresErrorCode(getOriginalError(error) ?? error);
    if (!wasErrorReported(error)) {
      // We still capture the unwrapped driver error so the event carries the real
      // pg cause. #4105 attached the field path and the SQL as context, which made
      // an individual event readable but left grouping alone — and tags and extra
      // do not affect grouping, so every resolver's DB failures stayed in one
      // anonymous bucket. `fingerprint` is the half that was missing (#4737): it
      // splits that bucket by cause, so an issue's title and its impact count
      // finally describe the same failure. This is server-side only; the client
      // still gets the generic message below, so #3183's info-leak fix holds.
      const graphqlPath = getGraphqlPath(error);
      const failedQuery = getFailedQuery(error);
      Sentry.captureException(unwrapCause(error), {
        // The raw path keeps its list indices here: as a tag it is a search key
        // for one bad row, and only the fingerprint needs the normalised shape.
        tags: {
          source: 'graphql-yoga-mask',
          pgCode: pgCode ?? 'unknown',
          ...(graphqlPath ? { graphqlPath } : {}),
        },
        fingerprint: databaseErrorFingerprint(pgCode, graphqlPath),
        ...(failedQuery ? { extra: { failedQuery } } : {}),
      });
      markErrorReported(error);
    }
    // A database that could not be reached is an honest 503 on the wire, not a
    // 200 with an error body: graphql-yoga reads `extensions.http.status` when
    // it builds the response (issue #4862), the mobile outbox drainer classifies
    // a 503 as "server unavailable, stop the cycle" rather than a verdict on the
    // queued write, and reachability probes get a status they can act on without
    // parsing bodies. The status is deliberately scoped to connection-class
    // failures: a constraint, data or syntax error is a permanent verdict on THAT
    // request, and a 503 there would tell every client to retry it forever
    // (the drainer would never dead-letter it). Those keep the plain masked 200.
    // Clients read the same `extensions.code` either way; graphql-request wraps
    // a non-2xx GraphQL body in the same ClientError shape as a 2xx one.
    const statusOverride = isDatabaseUnavailableCode(pgCode) ? { http: { status: 503 } } : {};
    return new GraphQLError('Something went wrong on our end. Please try again.', {
      extensions: { code: 'INTERNAL_SERVER_ERROR', ...statusOverride },
    });
  }

  // Not a DB leak — preserve the pre-existing pass-through behaviour so
  // intentional resolver messages still reach the client verbatim.
  if (error instanceof Error) return error;
  if (typeof error === 'string') return new GraphQLError(error);
  return new GraphQLError(String(error));
}
