import { webLogger, type JsonLogger, type LogFields } from './logger';
import { RAILWAY_REQUEST_ID_HEADER } from './sentry-tracing';

/**
 * A logger with `requestId`, `route` and `method` bound, so every line one
 * handler writes correlates without each call site repeating them.
 *
 * `requestId` is Railway's own `x-railway-request-id`, which the edge stamps on
 * the request into the container and logs against its HTTP entry.
 * `sentry.server.config.ts` promotes the same header to the `railway_request_id`
 * tag on every Sentry event (see `tagRailwayRequestId`), so the three systems —
 * Railway's HTTP log, our app log, and Sentry — all key off one value.
 */
export type RequestLogger = JsonLogger & {
  /** Railway's request id, or `undefined` off Railway (local dev, tests). */
  readonly requestId: string | undefined;
  /** Path the handler is serving, e.g. `/api/internal/ws-auth`. */
  readonly route: string;
};

export type RequestLoggerOptions = {
  /**
   * Route label. Defaults to the request's pathname, which for a dynamic
   * segment is the resolved value (`/api/v1/kilter/climb-stats/abc`); pass the
   * template (`/api/v1/[board_name]/climb-stats/[climb_uuid]`) when you want
   * lines from one handler to aggregate.
   */
  route?: string;
  /** Underlying logger. Injected by tests; defaults to the app logger. */
  logger?: JsonLogger;
};

/**
 * Pathname of a request URL, falling back to the raw string.
 *
 * `request.url` is absolute in Next, but a hand-built `new Request('/x')` in a
 * test is not, and a logger must never throw on its own input.
 */
function resolveRoute(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    const queryStart = url.indexOf('?');
    return queryStart === -1 ? url : url.slice(0, queryStart);
  }
}

/**
 * Bind a request's correlation fields to a logger, once per handler.
 *
 * The request is an explicit argument rather than an `AsyncLocalStorage` read
 * or a `next/headers` call, for two reasons:
 *
 *  - `headers()` is async in Next 16. Sourcing the request id from it would
 *    make every `log.info(...)` an `await`, in catch blocks and `after()`
 *    callbacks included.
 *  - There is no middleware hook to seed a store from. `packages/web/middleware.ts`
 *    matches only `/api/v1/:path*`, `/api/auth/:path*` and `/api/internal/ws-auth`
 *    under `/api`; its page matcher excludes `api/` outright via the
 *    `(?!api/…)` lookahead. That narrowing was deliberate (~50k/day board-render
 *    fetches were paying for middleware that did nothing for them), so most
 *    `/api/**` handlers never run middleware at all.
 */
export function createRequestLogger(request: Request, options: RequestLoggerOptions = {}): RequestLogger {
  const requestId = request.headers.get(RAILWAY_REQUEST_ID_HEADER) ?? undefined;
  const route = options.route ?? resolveRoute(request.url);
  const logger = options.logger ?? webLogger;

  const boundFields: LogFields = {
    route,
    method: request.method,
    ...(requestId ? { requestId } : {}),
  };

  const merge = (fields?: LogFields): LogFields => (fields ? { ...boundFields, ...fields } : boundFields);

  return {
    requestId,
    route,
    info: (message, fields) => logger.info(message, merge(fields)),
    warn: (message, fields) => logger.warn(message, merge(fields)),
    error: (message, fields) => logger.error(message, merge(fields)),
  };
}
