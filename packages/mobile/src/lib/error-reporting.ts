import { isBleWriteTimeoutError } from '@boardsesh/ble-protocol/connection-error';
import { captureToSentry, type ErrorReportContext } from './sentry';
import { isExpectedAuthError, isExpectedBetaValidationError } from './graphql/extract-error-message';

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
 * full `error` that drowns real bugs. RN's fetch rejects offline requests with
 * `TypeError: Network request failed`; graphql-request wraps a fetch failure in
 * a ClientError that carries no HTTP `response.status`.
 */
function isNetworkError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const response = (error as { response?: { status?: unknown } }).response;
  // A ClientError with a `response` but no numeric `status` is a transport
  // failure; one with a status is a real server error (4xx/5xx) we want to see.
  if (response !== undefined && typeof (response as { status?: unknown }).status !== 'number') return true;
  // RN's fetch rejects offline with `TypeError: Network request failed` — a
  // TypeError is an object with a `.message`, so the message check covers it
  // without a separate instanceof branch.
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' && /network request failed|fetch failed/i.test(message);
}

/**
 * Report a *handled* error — one the app caught and surfaced as UX (a toast,
 * inline message, or degraded state) rather than letting crash. Applies the
 * noise policy so error tracking stays signal-rich:
 *   - cancellations are dropped entirely,
 *   - expected auth-required GraphQL failures are dropped entirely,
 *   - expected beta-attach validation rejections are dropped entirely,
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
