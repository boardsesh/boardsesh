import { isBleWriteTimeoutError } from '@boardsesh/ble-protocol/connection-error';
import { isTransportNetworkError } from '@boardsesh/offline-sync/error-classification';
import { captureToSentry, type ErrorReportContext } from './sentry';
import {
  isExpectedAuthError,
  isExpectedBetaValidationError,
  isGraphqlRateLimitedError,
} from './graphql/extract-error-message';

// Re-exported so the public reporting surface (`{ ErrorReportContext }` from
// './error-reporting') is unchanged; the type itself lives in './sentry' to keep
// the dependency one-directional.
export type { ErrorReportContext };

/**
 * Report an error to Sentry if it is active. No-op otherwise. The optional
 * context lets callers attach triage data such as source, board path, or HTTP
 * status.
 */
export function reportError(error: unknown, context?: ErrorReportContext): void {
  captureToSentry(error, context);
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
 *     truncated — the same offline blip signature, just caught a layer up (#3190);
 *   - every other transport rejection — RN's `TypeError: Network request failed`,
 *     the WinterCG `Error: "fetch failed: <cause>"` wrapper (graphql-ws HTTP),
 *     Android `UnknownHostException`, and bare iOS NSURLError descriptions — is
 *     classified by the shared, locale-independent `isTransportNetworkError`
 *     (message markers, error codes, `.cause` recursion). Sharing that matcher
 *     with the offline drainer's dead-letter classifier keeps the two in agreement
 *     on what counts as "offline" (#3610).
 */
function isNetworkError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const name = (error as { name?: unknown }).name;
  if (name === 'GraphQLEmptyResponseError') return true;
  const response = (error as { response?: { status?: unknown } }).response;
  // A ClientError with a `response` but no numeric `status` is a transport
  // failure; one with a status is a real server error (4xx/5xx) we want to see.
  if (response !== undefined && typeof (response as { status?: unknown }).status !== 'number') return true;
  return isTransportNetworkError(error);
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
 * Report a *handled* error — one the app caught and surfaced as UX (a toast,
 * inline message, or degraded state) rather than letting crash. Applies the
 * noise policy so error tracking stays signal-rich:
 *   - cancellations are dropped entirely,
 *   - expected auth-required GraphQL failures are dropped entirely,
 *   - expected beta-attach validation rejections are dropped entirely,
 *   - expected board-account credential rejections (wrong password, already
 *     linked, rate-limited) are dropped entirely — already surfaced as a toast,
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
