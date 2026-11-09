import type { IncomingMessage, RequestListener, ServerResponse } from 'http';
import { logger } from '../utils/logger';

/** One replica logs the tally of refused requests at most this often. */
export const MALFORMED_REQUEST_LOG_INTERVAL_MS = 60_000;

const MALFORMED_REQUEST_BODY = JSON.stringify({ error: 'Bad request' });

/**
 * The parsed request URL, or null when `new URL` refuses it.
 *
 * Node's HTTP parser only checks that a target and a Host header are made of
 * legal bytes, which lets through plenty that `new URL` throws on: `GET //`,
 * `Host: x:abc`, `Host: ::1`, `Host: [::1`. An HTTP/1.0 request may have no Host
 * at all, and an empty one reaches here as `''`; both keep the `localhost` base.
 */
export function parseRequestUrl(req: IncomingMessage): URL | null {
  try {
    return new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  } catch {
    return null;
  }
}

/** Answers 400 and closes the connection, so nothing pipelined behind it is read. */
export function refuseMalformedRequest(res: ServerResponse): void {
  res.writeHead(400, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(MALFORMED_REQUEST_BODY),
    Connection: 'close',
  });
  res.end(MALFORMED_REQUEST_BODY);
}

/**
 * Returns a function to call once per refused request. It logs a tally at most
 * once per interval, so the sender cannot choose how much we log. The line is a
 * `warn` carrying only the count: `error` would become a Sentry event through
 * SentryWinstonTransport, and the target and Host are the sender's own bytes.
 */
export function createMalformedRequestRecorder(now: () => number = Date.now): () => void {
  let refusedSinceLastLog = 0;
  let lastLoggedAtMs = Number.NEGATIVE_INFINITY;

  return () => {
    refusedSinceLastLog += 1;
    const currentMs = now();
    if (currentMs - lastLoggedAtMs < MALFORMED_REQUEST_LOG_INTERVAL_MS) return;
    lastLoggedAtMs = currentMs;
    logger.warn('[HTTP] Refused requests with an unparseable target or Host', { refused: refusedSinceLastLog });
    refusedSinceLastLog = 0;
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
