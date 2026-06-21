import type { IncomingMessage, ServerResponse } from 'http';
import { applyCorsHeaders } from './cors';
import { logger } from '../utils/logger';

const POSTHOG_UPSTREAM = 'https://us.i.posthog.com';
const MAX_BODY_BYTES = 64 * 1024;
const UPSTREAM_TIMEOUT_MS = 5000;
const PROXY_PATH_PREFIX = '/api/posthog';

function getClientIp(req: IncomingMessage): string | null {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? null;
}

function readBody(req: IncomingMessage, limitBytes: number): Promise<Buffer | { tooLarge: true }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > limitBytes) {
        resolve({ tooLarge: true });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Reverse proxy for PostHog ingestion.
 *
 * Forwards POST /api/posthog/<rest> → https://us.i.posthog.com/<rest>, preserving
 * the query string, request body bytes, and Content-Encoding header (the JS SDK
 * gzips the /batch/ payload when CompressionStream is available, so the body is
 * binary, not text).
 *
 * Also forwards the browser's User-Agent. PostHog derives `$raw_user_agent` (and
 * its bot/traffic classification + device parsing) from the request UA header;
 * Node's fetch sends none by default, so without this every proxied event lands
 * with an empty UA and PostHog flags it as a bot.
 */
export async function handlePosthogProxy(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (!applyCorsHeaders(req, res)) return;

  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'POST, OPTIONS' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  const rest = url.pathname.slice(PROXY_PATH_PREFIX.length);
  if (!rest || !rest.startsWith('/')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  const body = await readBody(req, MAX_BODY_BYTES);
  if ('tooLarge' in body) {
    res.writeHead(413, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Payload too large' }));
    return;
  }

  const upstreamUrl = `${POSTHOG_UPSTREAM}${rest}${url.search}`;
  const headers: Record<string, string> = {
    'Content-Type': typeof req.headers['content-type'] === 'string' ? req.headers['content-type'] : 'application/json',
  };
  const contentEncoding = req.headers['content-encoding'];
  if (typeof contentEncoding === 'string' && contentEncoding.length > 0) {
    headers['Content-Encoding'] = contentEncoding;
  }
  const clientIp = getClientIp(req);
  if (clientIp) headers['X-Forwarded-For'] = clientIp;
  const userAgent = req.headers['user-agent'];
  if (typeof userAgent === 'string' && userAgent.length > 0) {
    headers['User-Agent'] = userAgent;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  const startedAt = Date.now();

  try {
    // Forward the raw bytes — the SDK may have gzipped the payload, in which
    // case UTF-8 decoding would corrupt it. Buffer is a Uint8Array at runtime
    // and undici accepts it; the cast is just to satisfy @types/node's
    // BodyInit (which excludes Buffer for SharedArrayBuffer-vs-ArrayBuffer
    // reasons).
    const upstream = await fetch(upstreamUrl, {
      method: 'POST',
      headers,
      body: body as unknown as BodyInit,
      signal: controller.signal,
    });
    const responseBody = Buffer.from(await upstream.arrayBuffer());
    const contentType = upstream.headers.get('content-type') ?? 'application/json';

    res.writeHead(upstream.status, { 'Content-Type': contentType });
    res.end(responseBody);

    logger.info('[posthog-proxy]', { status: upstream.status, durationMs: Date.now() - startedAt, path: rest });
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    logger.error('[posthog-proxy] upstream error', {
      aborted,
      durationMs: Date.now() - startedAt,
      path: rest,
      message: err instanceof Error ? err.message : String(err),
    });
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Upstream unavailable' }));
    }
  } finally {
    clearTimeout(timeoutId);
  }
}
