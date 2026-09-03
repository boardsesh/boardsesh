import { isBleWriteTimeoutError } from '@boardsesh/ble-protocol/connection-error';
import { getErrorStatus, isNetworkError as isSharedNetworkError } from '@boardsesh/offline-sync/error-classification';
import { addBreadcrumbToSentry, captureToSentry, type ErrorReportContext } from './sentry';
import { captureToObserve } from './observe-runtime';
import {
  isExpectedAuthError,
  isExpectedBetaValidationError,
  isGraphqlRateLimitedError,
  readDuplicateBoardError,
} from './graphql/extract-error-message';

// Re-exported so the public reporting surface (`{ ErrorReportContext }` from
// './error-reporting') is unchanged; the type itself lives in './sentry' to keep
// the dependency one-directional.
export type { ErrorReportContext };

/**
 * Report an error to Sentry if it is active, and to xprem's Observe. No-op for
 * either destination that is inactive. The optional context lets callers attach
 * triage data such as source, board path, or HTTP status.
 *
 * Both destinations hang off this one funnel deliberately. Everything the
 * filters in `reportHandledError` already dropped (cancellations, expected auth
 * and validation rejections) stays dropped for both, so the two can never
 * disagree about what counted as an error. Observe takes no context — it records
 * the error against the OTA update id that produced it, which is the question
 * Sentry cannot answer; Sentry keeps the triage detail.
 */
export function reportError(error: unknown, context?: ErrorReportContext): void {
  captureToSentry(error, context);
  captureToObserve(error);
}

/**
 * Leave a breadcrumb on the trail Sentry attaches to the next reported error.
 * No-op when Sentry is inactive, the same guard `reportError` gets through
 * `captureToSentry`.
 *
 * Use it for a repeating failure whose REPORT is rate-limited: the once-per-kind
 * guard on `reportError` is what stops a storm, and it also throws away every
 * occurrence after the first. A breadcrumb costs nothing, is bounded by Sentry's
 * own ring buffer, and keeps the sequence readable on whatever does get
 * reported. Keep the message low-cardinality and free of filenames — it is read
 * as a trail, not grouped on.
 */
export function addErrorBreadcrumb(breadcrumb: {
  category: string;
  message: string;
  level?: 'fatal' | 'error' | 'warning' | 'info' | 'debug';
  data?: Record<string, unknown>;
}): void {
  addBreadcrumbToSentry(breadcrumb);
}

/**
 * A request the user (or an unmounting screen) cancelled. Not a failure — the
 * app did exactly what was asked — so it must never reach error tracking.
 * Covers our own AbortController signals and TanStack Query's CancelledError.
 */
function isCancellation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const name = (error as { name?: unknown }).name;
  return name === 'AbortError' || name === 'CancelledError';
}

/**
 * An offline / transport failure (no server response). Expected on flaky mobile
 * networks, so we keep it filterable as a low-severity breadcrumb rather than a
 * full `error` that drowns real bugs. Three shapes:
 *   - graphql-request wraps a fetch failure in a ClientError that carries no HTTP
 *     `response.status` (a `response` present but with a non-numeric status);
 *   - our GraphQL client throws a typed `GraphQLEmptyResponseError` (see
 *     `./graphql/client.ts`) when a nominally-2xx response body arrives empty or
 *     truncated; the shared classifier treats its stable name as transport-shaped;
 *   - every other transport rejection — RN's `TypeError: Network request failed`,
 *     the WinterCG `Error: "fetch failed: <cause>"` wrapper (graphql-ws HTTP),
 *     Android `UnknownHostException`, and bare iOS NSURLError descriptions — is
 *     classified by the shared status-aware network predicate. A resolved
 *     HTTP/GraphQL status beats the best-effort English prose fallback, keeping
 *     telemetry in step with the offline drainer.
 */
function isNetworkError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const response = (error as { response?: unknown }).response;
  // Preserve statusless ClientError as a transport signal while allowing a
  // status nested in response.errors[].extensions to win over message prose.
  if (response !== undefined && getErrorStatus(error) === null) return true;
  return isSharedNetworkError(error);
}

// Board-account credential codes the app already surfaces as UX — the integrations
// screen maps each to a localized toast ("That username or password didn't work.",
// plus the account-already-linked / rate-limited copy) and the climber resolves it
// by retyping or backing off. They carry no engineering signal, so error tracking
// drops them, mirroring `isExpectedAuthError`. `not_allowed` / `unauthorized` /
// `request_failed` are deliberately excluded: a 403, a bare 401, or a non-OK
// response can be a real fault worth seeing.
const EXPECTED_BOARD_ACCOUNT_CODES = new Set(['invalid_credentials', 'account_already_linked', 'rate_limited']);

/**
 * An *expected* board-account link rejection (`BoardAccountError`). Matched
 * structurally by name + code rather than by importing `BoardAccountError`, which
 * would create a cycle: error-reporting → aurora-credentials → auth-interceptor →
 * error-reporting.
 */
function isExpectedBoardAccountError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  if ((error as { name?: unknown }).name !== 'BoardAccountError') return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && EXPECTED_BOARD_ACCOUNT_CODES.has(code);
}

/**
 * `createBoard`'s BOARD_DUPLICATE_CONFIG refusal, which is a routing decision
 * rather than a fault: the rejection names the board that already exists, and
 * every caller either offers it to the user (the create screen's prompt) or
 * adopts it outright (a deep link resolving a board someone made on another
 * device). Nothing is lost and nobody needs paging, so it must not reach error
 * tracking — but it arrives through `MutationCache.onError`, which reports every
 * mutation rejection, so the drop has to happen here.
 */
function isExpectedDuplicateBoardError(error: unknown): boolean {
  return readDuplicateBoardError(error) !== null;
}

/**
 * Report a *handled* error — one the app caught and surfaced as UX (a toast,
 * inline message, or degraded state) rather than letting crash. Applies the
 * noise policy so error tracking stays signal-rich:
 *   - cancellations are dropped entirely,
 *   - expected auth-required GraphQL failures are dropped entirely,
 *   - expected beta-attach validation rejections are dropped entirely,
 *   - expected board-account credential rejections (wrong password, already
 *     linked, rate-limited) are dropped entirely — already surfaced as a toast,
 *   - duplicate-board create refusals are dropped entirely — the rejection names
 *     the existing board and the caller uses it,
 *   - GraphQL rate-limit rejections (RATE_LIMITED) are downgraded to `warning`
 *     and tagged `rate_limited` — expected backpressure from typing/panning
 *     discovery searches too fast, not a bug (#3285),
 *   - offline/network failures are downgraded to `warning` and tagged `network`,
 *   - BLE write-resume timeouts are downgraded to `warning` and tagged
 *     `ble_write_timeout` (the native layer auto-recovers them by cycling the
 *     connection — #3181 — so they're transient, not hard failures),
 *   - everything else reports at the caller's level (default `error`).
 * Use this from React Query caches, GraphQL-WS, and catch blocks; use the raw
 * `reportError` only when the caller already owns the severity decision.
 */
export function reportHandledError(error: unknown, context?: ErrorReportContext): void {
  if (isCancellation(error)) return;
  if (isExpectedAuthError(error)) return;
  if (isExpectedBetaValidationError(error)) return;
  if (isExpectedBoardAccountError(error)) return;
  if (isExpectedDuplicateBoardError(error)) return;
  if (isGraphqlRateLimitedError(error)) {
    reportError(error, {
      ...context,
      level: 'warning',
      tags: { ...context?.tags, rate_limited: true },
    });
    return;
  }
  if (isNetworkError(error)) {
    reportError(error, {
      ...context,
      level: 'warning',
      tags: { ...context?.tags, network: true },
    });
    return;
  }
  if (isBleWriteTimeoutError(error)) {
    reportError(error, {
      ...context,
      level: 'warning',
      tags: { ...context?.tags, ble_write_timeout: true },
    });
    return;
  }
  reportError(error, { level: 'error', ...context });
}
