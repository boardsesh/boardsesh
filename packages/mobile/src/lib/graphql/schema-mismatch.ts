import {
  hasGraphqlErrorCode,
  isServerUnavailableError,
} from '@boardsesh/offline-sync/error-classification';

/**
 * The GraphQL `extensions.code` a server attaches when it refuses to run a
 * document at all: the query names a field, or passes an argument, that its
 * schema does not have. Yoga answers HTTP 400 and never reaches a resolver.
 */
export const GRAPHQL_VALIDATION_FAILED_CODE = 'GRAPHQL_VALIDATION_FAILED';

/**
 * Did the server reject this request because the document does not match its
 * schema?
 *
 * This is a different animal from every other GraphQL failure the app sees, and
 * the difference is what the rest of this module is built on: the answer cannot
 * change while this JS bundle is running. The bundle's query text is fixed and
 * the schema is whatever the deployed backend has, so a retry, a reconnect, or
 * a pull-to-refresh all buy exactly the same 400. Both live instances are the
 * OTA/backend ordering hazard from docs/mobile-ota-updates.md:
 *
 *   - JS ahead of backend — an OTA carrying a new argument reaches phones before
 *     the backend that understands it deploys (`recentBetaLinks(layoutId:)`,
 *     #5283, Sentry BOARDSESH-CJ);
 *   - backend ahead of JS — a field is removed while installed builds still ask
 *     for it (`otaPreviewChannels`, #4792, Sentry BOARDSESH-7H).
 *
 * Read the code, not the message: the message is English prose from graphql-js
 * and changes with the field name. `hasGraphqlErrorCode` is the SAME reader the
 * offline-sync mutation classifier uses for this code (it lists
 * GRAPHQL_VALIDATION_FAILED in PERMANENT_GRAPHQL_ERROR_CODES since #5344), so
 * queries and queued mutations cannot drift on what counts as a schema refusal.
 *
 * A 404 / 502 / 503 / 504 is excluded for the reason `isServerUnavailableError`
 * gives: that is an edge or proxy talking about routing, its body is an error
 * page rather than a server's verdict on this document, and the request is as
 * replayable as a dropped connection. Without that exclusion a gateway serving
 * a canned body could mute a real outage behind a permanent-looking "degraded"
 * state.
 */
export function isSchemaMismatchError(error: unknown): boolean {
  if (isServerUnavailableError(error)) return false;
  return hasGraphqlErrorCode(error, GRAPHQL_VALIDATION_FAILED_CODE);
}

/**
 * Run a GraphQL request, resolving to `fallback` if — and only if — the server
 * refuses the document as a schema mismatch.
 *
 * Opt-in per query, never global. For a query whose answer is a LIST, "the
 * server does not understand this request" and "there is nothing to show" look
 * the same to the climber, and the empty state is strictly better than an error
 * card with a Retry button that can never work: the Home beta shelf renders
 * exactly that card today off `isError`/`onRetry`. For a query whose payload the
 * screen cannot do without, a fabricated empty answer would be a lie the screen
 * then renders as fact — so those keep throwing, and the once-only report plus
 * `retry: false` in the query provider still apply to them.
 *
 * EVERYTHING else re-throws, transport failures first among them. A dropped
 * connection, a timeout, a 5xx and an offline short-circuit are all things that
 * can succeed on the next attempt, and swallowing one here would paint an empty
 * shelf over a network the app is about to get back — the exact failure this
 * helper exists to avoid being mistaken for.
 */
export async function withSchemaMismatchFallback<T>(run: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (isSchemaMismatchError(error)) return fallback;
    throw error;
  }
}

type GraphqlErrorLike = { message?: unknown };

/**
 * What makes two schema-mismatch failures the same failure: the validator's own
 * sentence, which names the offending field or argument
 * (`Unknown argument "layoutId" on field "Query.recentBetaLinks".`). It is
 * low-cardinality by construction — one per broken element in the document, not
 * one per request, per screen or per user.
 */
function schemaMismatchSignature(error: unknown): string {
  if (typeof error !== 'object' || error === null) return 'unknown';
  const response = (error as { response?: { errors?: unknown } }).response;
  const errors = Array.isArray(response?.errors) ? (response.errors as GraphqlErrorLike[]) : [];
  const messages = errors.map((entry) => (typeof entry?.message === 'string' ? entry.message : '')).filter(Boolean);
  if (messages.length > 0) return messages.join(' | ');
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' && message.length > 0 ? message : 'unknown';
}

const reportedSchemaMismatches = new Set<string>();

/**
 * Should THIS occurrence of a schema mismatch be reported, or has the signature
 * already been reported in this app session?
 *
 * The mismatch is per bundle, not per request: every affected screen re-issues
 * the same doomed query on every mount, focus refetch and pull-to-refresh, so a
 * report per occurrence is a stream with no extra information in it. That is how
 * BOARDSESH-CJ and BOARDSESH-7H reached 819 events between them from 79 people —
 * enough volume to bury real regressions, and not one event past the first said
 * anything the first had not.
 *
 * One per signature per launch keeps the discovery signal (a bad deploy still
 * files an issue, with the field name in the title) at a cost proportional to
 * the number of broken elements rather than to how long people keep using the
 * app. Deliberately process-local and unbounded-in-time: it must not reset on
 * reconnect or navigation, because the mismatch does not change when those do.
 */
export function shouldReportSchemaMismatch(error: unknown): boolean {
  const signature = schemaMismatchSignature(error);
  if (reportedSchemaMismatches.has(signature)) return false;
  reportedSchemaMismatches.add(signature);
  return true;
}

/** Clears the once-per-launch report memory. Tests only. */
export function resetSchemaMismatchReportsForTests(): void {
  reportedSchemaMismatches.clear();
}
