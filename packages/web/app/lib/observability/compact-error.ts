import { extractGraphQLErrorMessage } from '@/app/lib/graphql/extract-error-message';

/**
 * A safe-to-log, safe-to-return summary of an unknown thrown value.
 *
 * Two shapes are dangerously verbose by default and need special handling
 * before anything touches a log line or an HTTP response:
 *
 *  - graphql-request's `ClientError` embeds the entire request (query +
 *    variables) and the entire response body in `.message`. Its actual
 *    resolver-authored message lives one level down, at
 *    `error.response.errors[0].message` — exactly what
 *    {@link extractGraphQLErrorMessage} extracts. We trust that message
 *    because it comes from our own resolvers.
 *  - drizzle-orm's `DrizzleQueryError` embeds the full SQL statement and every
 *    bound parameter in its own `.message`. The underlying driver failure
 *    (e.g. a postgres `CONNECT_TIMEOUT`) is the useful, SQL-free signal, and
 *    it lives on `.cause`.
 *
 * Anything else falls back to `name: message` (or `String(error)` for a
 * non-Error throw) — but that fallback is itself hardened against a future
 * error that embeds SQL/PII in its message with no `.cause` to unwrap to (see
 * the guards inline below), and the result is always truncated so a single
 * error cannot blow out a log event's size.
 */
export function compactErrorMessage(error: unknown, maxLength = 200): string {
  const graphQLMessage = extractGraphQLErrorMessage(error);
  if (graphQLMessage !== null) {
    return graphQLMessage.slice(0, maxLength);
  }

  if (error instanceof Error && error.cause instanceof Error) {
    return `${error.name}: ${error.cause.message}`.slice(0, maxLength);
  }

  if (error instanceof Error) {
    // Defense in depth: the branches above strip SQL/PII by construction (a
    // trusted resolver message, or the cause's message), but this generic
    // fallback runs for ANY Error with no `.cause` — including a future
    // driver/query error that embeds SQL and has no cause to unwrap to. Two
    // guards specifically for that gap:
    //  - `Failed query:` is drizzle-orm's own prefix for a query failure
    //    message (`Failed query: <sql>\nparams: <params>`); if it shows up
    //    here (no cause set) the SQL is right there in `.message`, so drop it
    //    entirely rather than truncate it.
    //  - Otherwise, cut at the first newline before the length cap: a
    //    multi-line message (stack-trace-shaped, or `<summary>\nparams: ...`)
    //    is far more likely to have its useful part on line one than to need
    //    everything after it.
    if (error.message.includes('Failed query:')) {
      return `${error.name}: query failed`.slice(0, maxLength);
    }
    const firstLine = error.message.split('\n')[0];
    return `${error.name}: ${firstLine}`.slice(0, maxLength);
  }

  return String(error).slice(0, maxLength);
}
