import type { IncomingMessage, RequestListener, ServerResponse } from 'http';
import { parseRequestTarget } from '../lib/request-url';
import { logger } from '../utils/logger';

/** One replica logs the tally of refused requests at most this often. */
export const MALFORMED_REQUEST_LOG_INTERVAL_MS = 60_000;

const MALFORMED_REQUEST_BODY = JSON.stringify({ error: 'Bad request' });

/** The parsed request URL, or null when the target or Host cannot be parsed. */
export function parseRequestUrl(req: IncomingMessage): URL | null {
  return parseRequestTarget(req.url, req.headers.host);
}

/**
 * Answers 400 and closes the connection. A request pipelined in the same packet
 * may already be dispatched by then, but its response is dropped with the socket.
 */
export function refuseMalformedRequest(res: ServerResponse): void {
  res.writeHead(400, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(MALFORMED_REQUEST_BODY),
    Connection: 'close',
  });
  res.end(MALFORMED_REQUEST_BODY);
}

/**
 * Counts refused requests and logs the tally once per interval, so the sender
 * cannot choose how much we log and a burst that stops is still reported. The
 * line is a `warn` carrying only the count: `error` would become a Sentry event
 * through SentryWinstonTransport, and the target and Host are the sender's own
 * bytes. The timer is unref'd so it never holds the process open.
 */
export function createMalformedRequestRecorder(): { record: () => void; flushTimer: NodeJS.Timeout } {
  let refusedSinceLastLog = 0;

  const flushTimer = setInterval(() => {
    if (refusedSinceLastLog === 0) return;
    const refused = refusedSinceLastLog;
    refusedSinceLastLog = 0;
    try {
      logger.warn('[HTTP] Refused requests with an unparseable target or Host', { refused });
    } catch {
      // A timer callback that throws would exit the process over a log line.
    }
  }, MALFORMED_REQUEST_LOG_INTERVAL_MS);
  flushTimer.unref();

  return {
    record: () => {
      refusedSinceLastLog += 1;
    },
    flushTimer,
  };
}

/**
 * Closes the connection of a response that can no longer be completed, which is
 * the only signal left once a status line has gone out. A response that already
 * ended is left alone, so its last bytes still flush.
 */
export function dropUnfinishedResponse(res: ServerResponse): void {
  if (!res.writableEnded) res.destroy();
}

/**
 * The outermost layer of the HTTP server. `http` ignores the promise a listener
 * returns, so a rejection here would be unhandled: with Sentry off that exits
 * the process, and with Sentry on it leaves the client waiting on a socket no
 * timeout will close, because Node sets none once a request has been read.
 *
 * Reached only when the dispatcher's own error handling failed, so the response
 * goes first and the logger, which may be what failed, comes after it.
 */
export function guardRequestHandler(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
): RequestListener {
  return (req, res) => {
    handler(req, res).catch((error: unknown) => {
      dropUnfinishedResponse(res);
      try {
        logger.error('[HTTP] Request failed while handling its own error:', error);
      } catch {
        // Logging is what failed, so there is nowhere left to report it.
      }
    });
  };
}
