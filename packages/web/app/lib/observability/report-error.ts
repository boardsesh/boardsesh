import * as Sentry from '@sentry/nextjs';
import { compactErrorMessage } from './compact-error';
import { webLogger, type JsonLogger, type LogFields } from './logger';

/**
 * Report an error to Railway's log stream *and* to Sentry in one call.
 *
 * One converted `console.error` therefore yields both a searchable JSON line
 * and a Sentry event, and the two carry the same `traceId` — the log line
 * stamps it from the current propagation context (see `readTraceId`), and the
 * Sentry event is built from that same context. Given a slow or failing
 * request found in Railway, that is what gets you to the stack trace.
 *
 * Mirrors `packages/mobile/src/lib/error-reporting.ts`: `reportError` is the
 * raw funnel for a caller that already owns the severity decision, and
 * `reportHandledError` applies the noise policy.
 */
/**
 * Sentry indexes tags, so they are primitives only — the SDK's own `Primitive`
 * minus `symbol`/`bigint`, neither of which survives JSON serialisation into a
 * log line either. Anything structured belongs in `extra`.
 */
export type ReportTagValue = string | number | boolean | null | undefined;

export type ErrorReportContext = {
  level?: 'fatal' | 'error' | 'warning' | 'info' | 'debug';
  tags?: Record<string, ReportTagValue>;
  extra?: Record<string, unknown>;
  /**
   * Log-line message. Defaults to the error's own compacted message; pass one
   * when the call site has context the error lacks ("Failed to send password
   * reset email").
   */
  message?: string;
  /**
   * Logger to write the line with — pass a `createRequestLogger` result so the
   * line carries `requestId` and `route`. Defaults to the app logger.
   */
  logger?: JsonLogger;
};

// The same depth cap `describeError` uses: fetch → undici → socket is three.
const MAX_CAUSE_DEPTH = 3;

/**
 * Node/undici error codes that mean "the request never reached a server".
 * These are transport failures, not application faults.
 */
const NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/**
 * Transport-failure messages, anchored so they can only match a bare rejection.
 * `fetch failed` is undici's, `Failed to fetch` the browser's, `terminated` the
 * one undici raises when a response body is cut off mid-stream.
 */
const NETWORK_ERROR_MESSAGES = [/^fetch failed$/i, /^failed to fetch$/i, /^network request failed$/i, /^terminated$/i];

/**
 * A request the caller (or an unmounting render) cancelled. Not a failure — the
 * app did exactly what was asked — so it must never reach error tracking.
 * Covers our own `AbortController` signals and TanStack Query's `CancelledError`.
 */
function isCancellation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const name = (error as { name?: unknown }).name;
  return name === 'AbortError' || name === 'CancelledError';
}

/**
 * An offline / transport failure (no server response). Expected against Aurora
 * and during a backend restart, so it stays a filterable `warning` rather than
 * a full `error` that drowns real bugs.
 *
 * The cause chain is walked because `fetch` rejects with a bare `fetch failed`
 * and hides `ECONNREFUSED` one or two links down — the same reason
 * `describeError` unwraps it.
 */
function isNetworkError(error: unknown): boolean {
  let candidate: unknown = error;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH && candidate instanceof Error; depth += 1) {
    const link: Error = candidate;
    const code = (link as { code?: unknown }).code;
    if (typeof code === 'string' && NETWORK_ERROR_CODES.has(code)) return true;
    if (NETWORK_ERROR_MESSAGES.some((pattern) => pattern.test(link.message))) return true;
    candidate = link.cause;
  }
  return false;
}

/** Sentry severities that should land on stderr as an `error` log line. */
const STDERR_ERROR_LEVELS = new Set(['fatal', 'error']);

function logReport(error: unknown, context: ErrorReportContext | undefined): void {
  const logger = context?.logger ?? webLogger;
  const level = context?.level ?? 'error';
  // `compactErrorMessage`, not `describeError`: this funnel is where a
  // graphql-request `ClientError` (whole query + variables in `.message`) and a
  // drizzle `DrizzleQueryError` (whole SQL + bound params) arrive, and neither
  // belongs in a log line.
  const errorSummary = compactErrorMessage(error);
  const fields: LogFields = {
    error: errorSummary,
    ...context?.tags,
    ...context?.extra,
  };
  const message = context?.message ?? errorSummary;

  if (STDERR_ERROR_LEVELS.has(level)) {
    logger.error(message, fields);
  } else if (level === 'warning') {
    logger.warn(message, fields);
  } else {
    logger.info(message, fields);
  }
}

/**
 * Log and capture an error at the caller's chosen severity, with no filtering.
 * Use `reportHandledError` unless you already know this one is worth an event.
 */
export function reportError(error: unknown, context?: ErrorReportContext): void {
  logReport(error, context);
  Sentry.captureException(error, {
    level: context?.level ?? 'error',
    tags: context?.tags,
    extra: context?.extra,
  });
}

/**
 * Report an error the handler caught and turned into a response, applying the
 * noise policy so Sentry stays signal-rich:
 *   - cancellations are dropped entirely (neither logged nor captured),
 *   - offline/network failures are downgraded to `warning` and tagged
 *     `network: true`,
 *   - everything else reports at the caller's level (default `error`).
 */
export function reportHandledError(error: unknown, context?: ErrorReportContext): void {
  if (isCancellation(error)) return;

  if (isNetworkError(error)) {
    reportError(error, {
      ...context,
      level: 'warning',
      tags: { ...context?.tags, network: true },
    });
    return;
  }

  reportError(error, { level: 'error', ...context });
}
