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
 * non-Error throw), and the result is always truncated so a single error
 * cannot blow out a log event's size.
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
    return `${error.name}: ${error.message}`.slice(0, maxLength);
  }

  return String(error).slice(0, maxLength);
}
