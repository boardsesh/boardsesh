import type { IncomingMessage, ServerResponse } from 'http';
import type { Readable } from 'node:stream';
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

/**
 * Stream an object-store body to the client, destroying the response if the
 * read fails partway through.
 *
 * `stream.pipe(res)` on its own is a trap for a body that is already streaming:
 * the status line and `Content-Length` went out before the first byte was read,
 * so a mid-stream S3 error has no way left to become an error status. Without
 * an `error` listener the failure is an unhandled `'error'` event — which
 * crashes the process — and, if it did not, the pipe would simply stop and the
 * client would sit on a truncated body that looks complete until it is opened.
 *
 * Destroying the response with the error is the honest answer: the connection
 * is reset, so the client sees a broken transfer rather than a short file, and
 * the operator sees the reason in the log.
 */
export function pipeObjectStream(stream: Readable, res: ServerResponse, context: Record<string, unknown>): void {
  stream.on('error', (error: Error) => {
    logger.error('[http] object stream failed mid-response', { ...context, error });
    res.destroy(error);
  });
  // A client that hangs up mid-download leaves the S3 read open; closing it
  // keeps a cancelled download from holding a connection in the SDK's pool.
  res.on('close', () => {
    if (!stream.destroyed) stream.destroy();
  });
  stream.pipe(res);
}
