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

function unwrapCause(error: unknown): unknown {
  const original = getOriginalError(error) ?? error;
  if (original instanceof Error && original.cause !== undefined && original.cause !== null) {
    return original.cause;
  }
  return original;
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
    if (!wasErrorReported(error)) {
      // Resolve the pg code through the GraphQL `originalError` wrapper too, so
      // it lands on the tag even when the top-level error is the located
      // GraphQLError (whose own cause chain doesn't reach the driver error).
      const pgCode = getPostgresErrorCode(getOriginalError(error) ?? error);
      // We still capture the unwrapped driver error, so Sentry's fingerprint (and
      // therefore the existing issue's history) is unchanged — tags and extra do
      // not affect grouping. But reporting the cause alone is what made
      // BOARDSESH-AK an anonymous bucket that every resolver's DB failures fell
      // into, with no way to tell which query blew up (#4105). Attach the field
      // path and the SQL as event context. This is server-side only; the client
      // still gets the generic message below, so #3183's info-leak fix holds.
      const graphqlPath = getGraphqlPath(error);
      const failedQuery = getFailedQuery(error);
      Sentry.captureException(unwrapCause(error), {
        tags: {
          source: 'graphql-yoga-mask',
          pgCode: pgCode ?? 'unknown',
          ...(graphqlPath ? { graphqlPath } : {}),
        },
        ...(failedQuery ? { extra: { failedQuery } } : {}),
      });
      markErrorReported(error);
    }
    // `http.status: 503` makes the masked failure an honest Service Unavailable
    // on the wire instead of a 200 with an error body. graphql-yoga reads
    // `extensions.http.status` when it builds the response (issue #4862): the
    // mobile outbox drainer classifies a 503 as "server unavailable, stop the
    // cycle" rather than a verdict on the queued write, and the web/mobile
    // reachability probes get a status they can act on without parsing bodies.
    // Clients keep reading the same `extensions.code`; graphql-request wraps a
    // non-2xx GraphQL body in the same ClientError shape as a 2xx one.
    return new GraphQLError('Something went wrong on our end. Please try again.', {
      extensions: { code: 'INTERNAL_SERVER_ERROR', http: { status: 503 } },
    });
  }

  // Not a DB leak — preserve the pre-existing pass-through behaviour so
  // intentional resolver messages still reach the client verbatim.
  if (error instanceof Error) return error;
  if (typeof error === 'string') return new GraphQLError(error);
  return new GraphQLError(String(error));
}
