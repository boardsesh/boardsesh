import type { IncomingMessage, ServerResponse } from 'http';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { isClientAbortError } from '../utils/http-errors';
import { logger } from '../utils/logger';

/**
 * Read a request body as a UTF-8 string, rejecting (and destroying the socket)
 * once it exceeds `maxBytes`. Shared by the JWT-authed session handlers so the
 * streaming read + body cap live in one place.
 */
export function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalLength = 0;

    req.on('data', (chunk: Buffer) => {
      totalLength += chunk.length;
      if (totalLength > maxBytes) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Write a JSON response with the standard headers for per-user session data:
 * `Cache-Control: no-store` (never cache a personal payload) and
 * `X-Content-Type-Options: nosniff`. Extra headers (e.g. `Retry-After`) merge
 * on top.
 */
export function sendJson(
  res: ServerResponse,
  statusCode: number,
  body: unknown,
  extraHeaders?: Record<string, string>,
): void {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

/** Where the bytes came from, so a failure is triageable from one log line. */
export type StreamPipeContext = {
  /** Request path being served, e.g. `/static/beta-link-thumbnails/instagram/abc.jpg`. */
  route: string;
  /** Object key or local file path the bytes were read from. */
  source: string;
};

/**
 * Stream a body (an S3 object, a local file) to the response with both ends
 * guarded.
 *
 * `readable.pipe(res)` attaches an `'error'` listener to the *destination
 * only*, so a source that fails mid-body emits an unhandled `'error'` — which
 * Node throws from a `nextTick`, landing on `process.on('uncaughtException')`
 * and killing the process along with every graphql-ws session on the replica
 * (issue #5307). The request handler's `try/catch` can't help: its `await`
 * resolved when the *headers* arrived, long before the body died.
 *
 * `pipeline` listens on both streams and destroys both on failure, which also
 * closes the reverse leak — a client that disconnects mid-download no longer
 * leaves the upstream S3 socket draining into a dead response.
 *
 * Never resolves before the body is fully flushed (or has failed), and never
 * rejects: callers keep their existing control flow.
 */
export async function pipeStreamToResponse(
  source: Readable,
  res: ServerResponse,
  context: StreamPipeContext,
): Promise<void> {
  try {
    await pipeline(source, res);
  } catch (error) {
    const clientAborted = isClientAbortError(error, {
      responseDestroyed: res.destroyed,
      socketDestroyed: res.socket?.destroyed,
    });

    // A client walking away is routine; anything else is an upstream read we
    // could not finish, and someone got a truncated file.
    const details = { route: context.route, source: context.source, headersSent: res.headersSent };
    if (clientAborted) {
      logger.info('Stream to client aborted', details);
    } else {
      logger.warn('Stream to client failed', details, error);
    }

    // Past the headers there is no status left to send: `writeHead` would throw
    // ERR_HTTP_HEADERS_SENT (a second crash) and `res.end()` would hand back a
    // short body as if it were complete. Destroying truncates the response below
    // its Content-Length, so the client's parser errors and no cache stores it.
    if (!res.headersSent) {
      sendJson(res, 502, { error: 'Upstream read failed' });
    } else {
      res.destroy();
    }
  }
}
