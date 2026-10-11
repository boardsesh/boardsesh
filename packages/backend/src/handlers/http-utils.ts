import type { IncomingMessage, ServerResponse } from 'http';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
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

/** Which upload part a per-file stream belongs to, so a failure is triageable. */
export type UploadStreamContext = {
  /** Request path handling the upload, e.g. `/api/avatars`. */
  route: string;
  /** Multipart field name busboy reported for the part. */
  field: string;
};

/**
 * Guard the per-file stream busboy hands to `busboy.on('file')`.
 *
 * `req.pipe(busboy)` involves three streams and only two of them are safe. `req`
 * is an `IncomingMessage`, whose `_destroy` suppresses an error with no
 * listeners; the busboy parser has an explicit `'error'` listener in every
 * upload handler. The per-file `FileStream` has neither — it `extends Readable`
 * with no suppression (busboy 1.6.0 `lib/types/multipart.js:174`) and the
 * handlers only ever attach `data`/`end`/`limit`. busboy destroys it *with an
 * error* whenever the parse ends mid-part: `checkEndState` (:603-613) and
 * `_destroy` (:572-583) both call `fileStream.destroy(new Error(...))`.
 *
 * A complete, ordinary `POST` — well-formed prologue, correct `Content-Length`,
 * no closing boundary — is enough to reach that. With no `'error'` listener Node
 * rethrows from a `nextTick`, and the backend installs no
 * `process.on('uncaughtException')`, so the process exits and drops every
 * graphql-ws session on the replica: the blast radius of #5307, reachable by any
 * logged-in user (#5359).
 *
 * Log-only on purpose. busboy emits its own `'error'` for the same failure and
 * each handler's `busboy.on('error')` already answers the client with a 400;
 * writing a second response from here would make that `writeHead` throw
 * ERR_HTTP_HEADERS_SENT from inside an event listener — one crash traded for
 * another. `warn`, not `error`: a truncated body is the client's doing, so it
 * belongs in the log rather than in Sentry.
 */
export function guardUploadFileStream(stream: NodeJS.ReadableStream, context: UploadStreamContext): void {
  stream.on('error', (error: Error) => {
    logger.warn('Upload file stream failed', { route: context.route, field: context.field }, error);
  });
}

/** Where the bytes came from, so a failure is triageable from one log line. */
export type StreamPipeContext = {
  /** Request path being served, e.g. `/static/beta-link-thumbnails/instagram/abc.jpg`. */
  route: string;
  /** Object key or local file path the bytes were read from. */
  source: string;
};

/**
 * Report a body we could not read from upstream (S3/R2, or a local file) and
 * close the request out.
 *
 * Logged at `error` on purpose. `SentryWinstonTransport` is constructed with
 * `level: 'error'` (`utils/sentry-transport.ts`), so `warn` and `info` stay in
 * the Railway log and never reach Sentry — an upstream media failure that only
 * warns is a degradation nobody is paged for (#5359).
 *
 * Before the headers there is still a status to send, so the client gets a 502
 * (the `?size=` buffered read reaches this branch). Past them there is not:
 * `writeHead` would throw ERR_HTTP_HEADERS_SENT — a second failure — and
 * `res.end()` would hand back a short body as if it were complete. Destroying
 * truncates the response below its Content-Length, so the client's parser
 * errors and no cache stores a partial object.
 */
export function failUpstreamRead(res: ServerResponse, context: StreamPipeContext, error: unknown): void {
  logger.error(
    'Upstream read failed',
    { route: context.route, source: context.source, headersSent: res.headersSent },
    error,
  );

  if (!res.headersSent) {
    sendJson(res, 502, { error: 'Upstream read failed' });
    return;
  }
  res.destroy();
}

/**
 * Stream a body (an S3 object, a local file) to the response with both ends
 * guarded.
 *
 * `readable.pipe(res)` attaches an `'error'` listener to the *destination
 * only*, so a source that fails mid-body emits an unhandled `'error'` — which
 * Node rethrows from a `nextTick`. The backend installs no
 * `process.on('uncaughtException')`, so that exits the process along with every
 * graphql-ws session on the replica (issue #5307). The request handler's
 * `try/catch` can't help: its `await` resolved when the *headers* arrived, long
 * before the body died.
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
  // Which side died has to be observed while it happens. `pipeline` destroys
  // *both* streams with the same error, so afterwards `source.errored` is set
  // either way, and the error itself is no help: `isClientAbortError` whitelists
  // the bare message `aborted` plus ECONNRESET and ERR_STREAM_PREMATURE_CLOSE,
  // which is the whole realistic vocabulary of a failed backend→R2 read. Using
  // it here filed every upstream failure as a routine client abort (#5359).
  //
  // The source failing while the response is still writable is the upstream
  // case; the response being gone already means the client left and `pipeline`
  // is only tearing the read down behind them.
  let upstreamFailed = false;
  source.on('error', () => {
    if (!res.destroyed && !res.writableEnded) upstreamFailed = true;
  });

  try {
    await pipeline(source, res);
  } catch (error) {
    if (upstreamFailed) {
      failUpstreamRead(res, context, error);
      return;
    }

    // A client walking away is routine and stays out of Sentry.
    logger.info('Stream to client aborted', {
      route: context.route,
      source: context.source,
      headersSent: res.headersSent,
    });
    res.destroy();
  }
}
