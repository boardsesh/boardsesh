import type { IncomingMessage, ServerResponse } from 'http';
import { gunzipSync } from 'node:zlib';
import { ANALYTICS_CAPTURE_PATH, ANALYTICS_CONSENT_HEADER, ANALYTICS_CONSENT_HEADER_GRANTED } from '@boardsesh/consent';
import { applyCorsHeaders } from './cors';
import { logger } from '../utils/logger';
import { resolveEdgeVisitorIp, resolveFlagCountry } from '../utils/flag-country';

const POSTHOG_UPSTREAM = 'https://us.i.posthog.com';
const MAX_BODY_BYTES = 64 * 1024;
const UPSTREAM_TIMEOUT_MS = 5000;
const PROXY_PATH_PREFIX = '/api/posthog';

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
 * binary, not text). GET is allowed only for the SDK's public project config
 * endpoint, so flag/replay configuration uses the same privacy boundary.
 *
 * Forwards the visitor IP (X-Forwarded-For) only on capture paths
 * (`ANALYTICS_CAPTURE_PATH` from `@boardsesh/consent`) from a client that says it holds a current Allow
 * (`x-boardsesh-analytics-consent: granted`), and only the `cf-connecting-ip` a
 * trusted Cloudflare edge reports, so PostHog geolocates consented events to the
 * visitor rather than to our egress. Everything else is stripped: every other
 * path, capture without the header (the anonymous OTA health event, kiosk
 * telemetry, an older client), and requests that did not come through a
 * Cloudflare edge. A missing header can only lose location, never add it.
 * Never forwards the HTTP User-Agent: consented analytics registers
 * `$raw_user_agent` in its event payload instead (#5653).
 */
export async function handlePosthogProxy(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (!applyCorsHeaders(req, res)) return;

  const rest = url.pathname.slice(PROXY_PATH_PREFIX.length);
  const isPublicConfigRequest = req.method === 'GET' && /^\/array\/phc_[A-Za-z0-9_-]+\/config\/?$/.test(rest);
  if (req.method !== 'POST' && !isPublicConfigRequest) {
    res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'POST, OPTIONS' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  if (!rest || !rest.startsWith('/')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  let body = isPublicConfigRequest ? undefined : await readBody(req, MAX_BODY_BYTES);
  if (body && 'tooLarge' in body) {
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
  if (
    req.method === 'POST' &&
    ANALYTICS_CAPTURE_PATH.test(rest) &&
    req.headers[ANALYTICS_CONSENT_HEADER] === ANALYTICS_CONSENT_HEADER_GRANTED
  ) {
    // Only the address Cloudflare vouches for. Earlier X-Forwarded-For entries
    // are caller-controlled, and the socket peer is our own ingress.
    const visitorIp = resolveEdgeVisitorIp(req);
    if (visitorIp) headers['X-Forwarded-For'] = visitorIp;
  }
  if (/^\/(flags|decide)\/?$/.test(rest) && body) {
    // Flag evaluation is functional without consent. Supply only a coarse
    // edge-verified country, and prohibit upstream inference from our host IP
    // or an account's stale location. Capture/replay bodies remain byte-exact.
    try {
      if (contentEncoding && contentEncoding !== 'gzip' && contentEncoding !== 'identity') {
        res.writeHead(415, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unsupported flag encoding' }));
        return;
      }
      const decoded = contentEncoding === 'gzip' ? gunzipSync(body, { maxOutputLength: MAX_BODY_BYTES }) : body;
      const payload: unknown = JSON.parse(decoded.toString('utf8'));
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid flag payload');
      const flagPayload = payload as Record<string, unknown>;
      const properties = flagPayload.person_properties;
      const personProperties =
        properties && typeof properties === 'object' && !Array.isArray(properties)
          ? Object.fromEntries(
              Object.entries(properties).filter(
                ([key]) =>
                  !key.startsWith('$geoip_') && !key.startsWith('$initial_geoip_') && key !== '$ip' && key !== 'ip',
              ),
            )
          : {};
      delete flagPayload.ip;
      delete flagPayload.$ip;
      body = Buffer.from(
        JSON.stringify({
          ...flagPayload,
          geoip_disable: true,
          person_properties: { ...personProperties, $geoip_country_code: resolveFlagCountry(req) },
        }),
      );
      delete headers['Content-Encoding'];
      headers['Content-Type'] = 'application/json';
    } catch (error) {
      const oversized = error instanceof Error && 'code' in error && error.code === 'ERR_BUFFER_TOO_LARGE';
      res.writeHead(oversized ? 413 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: oversized ? 'Payload too large' : 'Invalid flag payload' }));
      return;
    }
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
      method: isPublicConfigRequest ? 'GET' : 'POST',
      headers,
      ...(body ? { body: body as unknown as BodyInit } : {}),
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
