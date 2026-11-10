import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import { loadPartnerAuthority } from '../auth/partner/load-authority';
import { readPartnerOAuthMode, type PartnerOAuthMode } from '../auth/partner/mode';
import {
  matchPartnerPreflight,
  matchPartnerRoute,
  requestTargetQuery,
  type PartnerRoute,
  type PartnerRouteKind,
} from '../auth/partner/routes';
import { getPartnerLimitIdentity, type PartnerLimitIdentity } from '../utils/client-ip';
import { logger } from '../utils/logger';
import { getPostgresErrorCode } from '../utils/postgres-errors';
import { isApiHost } from './api-host';
import { partnerPreflightHeaders, partnerResponseCorsHeaders, type PartnerCorsPolicy } from './partner-cors';
import {
  chargePartnerLimit,
  consumePerAddress,
  PartnerRateLimited,
  partnerRateLimitedHeaders,
  RateLimitLedger,
  WORKER_EGRESS_LIMIT_SUFFIX,
} from './partner-rate-limits';

type PartnerRuntime = NonNullable<Awaited<ReturnType<typeof loadPartnerAuthority>>>;
type PartnerRuntimeLoader = (mode: PartnerOAuthMode) => Promise<PartnerRuntime | null>;

const HOLD_RETRY_AFTER_SECONDS = '60';
const UNAVAILABLE_RETRY_AFTER_SECONDS = '2';

/** `docs/partner-api.md` section 6 and `docs/integration-platform.md` "Limits". */
const MAX_BODY_BYTES = 64 * 1024;
const BODY_READ_DEADLINE_MS = 5000;
const MAX_BODY_READS = 256;
const MAX_BODY_READS_PER_IP = 8;
/** Every Worker zone together, from Cloudflare's one Worker egress address: an eighth of all body reads. */
const MAX_BODY_READS_PER_WORKER_EGRESS = 32;

const AUTHORIZE_PER_IP = 60;
const CONSENT_PER_IP = 60;
const TOKEN_PER_APP_AND_IP = 60;
const TOKEN_PER_APP = 6000;
const REFRESH_PER_CONNECTION = 10;
/** Not in the doc, which asks only for "an IP bound". One egress IP refreshing hourly at this rate serves 36,000 climbers. */
const REFRESH_PER_APP_AND_IP = 600;
const BODY_READS_PER_IP = 1200;

/** Only these reach Better Auth; anything else could change how it reads the request. */
const FORWARDED_REQUEST_HEADERS = [
  'accept',
  'authorization',
  'content-type',
  'origin',
  'referer',
  'sec-fetch-dest',
  'sec-fetch-mode',
  'sec-fetch-site',
  'user-agent',
] as const;
/** Token and revoke authenticate the client, so a browser's cookies mean nothing there. */
const COOKIE_READING_ROUTES: ReadonlySet<PartnerRouteKind> = new Set(['authorize', 'consent', 'consent-details']);
/** The routes the www consent screen calls with the climber's cookie. JSON bodies, no app credentials. */
const CONSENT_ROUTES: ReadonlySet<PartnerRouteKind> = new Set(['consent', 'consent-details']);
const NEXTAUTH_SESSION_COOKIE = /(?:^|;\s*)(?:__Secure-)?next-auth\.session-token(?:\.\d+)?=/;
const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

class PartnerBodyRefused extends Error {
  constructor(readonly status: 408 | 413 | 503) {
    super('Partner OAuth request body refused');
  }
}

/**
 * Reads the whole body before any database work, so a slow or endless sender
 * costs a timer and at most 64 KB, never one of the three connections.
 */
function readBoundedBody(req: IncomingMessage, deadlineMs: number): Promise<Buffer> {
  const declaredLength = Number(req.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return Promise.reject(new PartnerBodyRefused(413));
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    const finish = (outcome: Buffer | Error) => {
      clearTimeout(deadline);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('close', onClose);
      if (outcome instanceof Buffer) resolve(outcome);
      else reject(outcome);
    };
    const deadline = setTimeout(() => finish(new PartnerBodyRefused(408)), deadlineMs);
    deadline.unref();
    const onData = (chunk: Buffer) => {
      receivedBytes += chunk.length;
      if (receivedBytes > MAX_BODY_BYTES) finish(new PartnerBodyRefused(413));
      else chunks.push(chunk);
    };
    const onEnd = () => finish(Buffer.concat(chunks));
    const onError = () => finish(new PartnerBodyRefused(408));
    const onClose = () => finish(new PartnerBodyRefused(408));
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('close', onClose);
  });
}

/**
 * Parsed for limits and CORS only. The token and revoke endpoints accept nothing
 * but a form, so anything else fails in the provider and bills the invalid bucket.
 */
function formFields(body: Buffer): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(body.toString('utf8')));
}

/**
 * The client a request names, as a bucket key: the Basic credential first, then
 * the form, decoded the way the provider does. It proves nothing until the
 * provider authenticates it. A name outside this alphabet cannot be a real
 * client, and could otherwise be written to collide with another limit's key.
 */
function claimedClientId(req: IncomingMessage, fields: Record<string, string>): string | undefined {
  const basicCredential = req.headers.authorization?.match(/^Basic +(.*)$/i)?.[1];
  let basicClientId: string | undefined;
  if (basicCredential !== undefined) {
    const decoded = Buffer.from(basicCredential, 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    if (separator > 0) basicClientId = new URLSearchParams(`v=${decoded.slice(0, separator)}`).get('v') ?? undefined;
  }
  const clientId = basicClientId ?? fields.client_id;
  return clientId && CLIENT_ID_PATTERN.test(clientId) ? clientId : undefined;
}

/**
 * Refresh errors the provider only reaches after the client has authenticated
 * and the family guard holds the lock. Everything else, a malformed request, a
 * wrong media type or `invalid_client`, is refused before authentication and
 * before any lock, so an outsider could send it at will.
 */
const ERRORS_AFTER_CLIENT_AUTHENTICATION: ReadonlySet<string> = new Set([
  'invalid_grant',
  'invalid_scope',
  'invalid_target',
]);

/** Whether a refresh got far enough to have authenticated its client. */
async function reachedAfterClientAuthentication(response: Response): Promise<boolean> {
  if (response.ok) return true;
  try {
    const body: unknown = await response.clone().json();
    const error = typeof body === 'object' && body !== null ? (body as { error?: unknown }).error : undefined;
    return typeof error === 'string' && ERRORS_AFTER_CLIENT_AUTHENTICATION.has(error);
  } catch {
    return false;
  }
}

function jsonError(status: number, error: string, description: string, headers: Record<string, string> = {}) {
  return Response.json(
    { error, error_description: description },
    { status, headers: { 'cache-control': 'no-store', ...headers } },
  );
}

function holdResponse(): Response {
  return jsonError(503, 'temporarily_unavailable', 'Partner OAuth is paused. Try again shortly.', {
    'retry-after': HOLD_RETRY_AFTER_SECONDS,
  });
}

function unavailableResponse(): Response {
  return jsonError(503, 'temporarily_unavailable', 'The server is busy. Try again shortly.', {
    'retry-after': UNAVAILABLE_RETRY_AFTER_SECONDS,
  });
}

function rateLimitedResponse(limited: PartnerRateLimited): Response {
  return jsonError(
    429,
    'rate_limited',
    'Too many requests. Slow down and try again.',
    partnerRateLimitedHeaders(limited),
  );
}

function bodyRefusedResponse({ status }: PartnerBodyRefused): Response {
  if (status === 413) return jsonError(413, 'payload_too_large', 'The request body is over 64 KB.');
  if (status === 503) return unavailableResponse();
  return jsonError(408, 'request_timeout', 'The request body did not arrive in time.');
}

/** The page the provider sends a browser to when it must not send it to the app. Reads no table. */
function errorPageResponse(requestTarget: string | undefined): Response {
  const rawCode = new URLSearchParams(requestTargetQuery(requestTarget)).get('error');
  // Only an OAuth error code is printed, never the free-text description.
  const code = rawCode && /^[a-z_]{1,64}$/.test(rawCode) ? rawCode : 'invalid_request';
  const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>This connection didn't start</title>
<style>body{font-family:system-ui,sans-serif;margin:3rem auto;max-width:32rem;padding:0 1rem;line-height:1.5}code{font-size:.9em}</style>
</head>
<body>
<h1>This connection didn't start</h1>
<p>The app that sent you here asked for something Boardsesh can't approve. Go back to the app and try again, or tell its developer what you saw.</p>
<p>Error: <code>${code}</code></p>
<p><a href="https://www.boardsesh.com">Back to Boardsesh</a></p>
</body>
</html>
`;
  return new Response(page, {
    status: 400,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'x-robots-tag': 'noindex',
    },
  });
}

function corsPolicyFor(kind: PartnerRouteKind): PartnerCorsPolicy | null {
  if (CONSENT_ROUTES.has(kind)) return 'first-party';
  return kind === 'token' || kind === 'revoke' ? 'credential-free' : null;
}

/**
 * Bounds how many bodies are being buffered: overall, for one address (or one
 * Worker zone), and for every Worker zone together.
 */
function createBodyReadSlots() {
  let total = 0;
  const held = new Map<string, number>();
  const take = (key: string) => held.set(key, (held.get(key) ?? 0) + 1);
  const give = (key: string) => {
    const remaining = (held.get(key) ?? 1) - 1;
    if (remaining === 0) held.delete(key);
    else held.set(key, remaining);
  };
  return {
    tryAcquire({ key, sharedEgress }: PartnerLimitIdentity): (() => void) | null {
      // Its own map key, so the zones' count never mixes with the address's header-less requests.
      const egressKey = sharedEgress === undefined ? undefined : `${WORKER_EGRESS_LIMIT_SUFFIX}:${sharedEgress}`;
      if (total >= MAX_BODY_READS || (held.get(key) ?? 0) >= MAX_BODY_READS_PER_IP) return null;
      if (egressKey && (held.get(egressKey) ?? 0) >= MAX_BODY_READS_PER_WORKER_EGRESS) return null;
      total += 1;
      take(key);
      if (egressKey) take(egressKey);
      return () => {
        total -= 1;
        give(key);
        if (egressKey) give(egressKey);
      };
    },
  };
}

function buildPartnerRequest(req: IncomingMessage, route: PartnerRoute, issuer: string, body: Buffer | null): Request {
  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = req.headers[name];
    if (typeof value === 'string') headers.set(name, value);
  }
  if (COOKIE_READING_ROUTES.has(route.kind) && typeof req.headers.cookie === 'string') {
    headers.set('cookie', req.headers.cookie);
  }
  // The URL comes from the matched route, never from what the client sent, and
  // only authorize takes a query. The fixed origin keeps a Host header out of
  // every URL Better Auth derives.
  const search = route.kind === 'authorize' ? requestTargetQuery(req.url) : '';
  const url = new URL(`${route.pathname}${search}`, issuer);
  return new Request(url, { method: route.method, headers, body: body ? new Uint8Array(body) : undefined });
}

interface PartnerResponseMetadata {
  requestId: string;
  policy: PartnerCorsPolicy | null;
  clientId: string | undefined;
  rateLimitHeaders: Record<string, string>;
  closeConnection: boolean;
}

async function writePartnerResponse(
  req: IncomingMessage,
  res: ServerResponse,
  response: Response,
  runtime: PartnerRuntime | null,
  metadata: PartnerResponseMetadata,
): Promise<void> {
  const { requestId, policy, clientId, rateLimitHeaders, closeConnection } = metadata;
  const headers = new Headers(response.headers);
  headers.set('boardsesh-request-id', requestId);
  if (!headers.has('cache-control')) headers.set('cache-control', 'no-store');
  // A 429 already names the limit it hit.
  if (!headers.has('ratelimit-limit')) {
    for (const [name, value] of Object.entries(rateLimitHeaders)) headers.set(name, value);
  }
  if (policy && runtime) {
    const corsHeaders = await partnerResponseCorsHeaders({
      policy,
      origin: req.headers.origin,
      webOrigin: runtime.configuration.webOrigin,
      directory: runtime.registeredOrigins,
      status: response.status,
      clientId,
    });
    for (const [name, value] of Object.entries(corsHeaders)) headers.set(name, value);
  }
  if (closeConnection) headers.set('connection', 'close');

  const responseBody = Buffer.from(await response.arrayBuffer());
  const responseHeaders = Object.fromEntries(headers.entries());
  delete responseHeaders['set-cookie'];
  res.writeHead(response.status, responseHeaders);
  for (const cookie of response.headers.getSetCookie()) res.appendHeader('set-cookie', cookie);
  res.end(responseBody);
}

export interface PartnerAuthHandlerOptions {
  mode?: PartnerOAuthMode;
  loadRuntime?: PartnerRuntimeLoader;
  bodyReadDeadlineMs?: number;
}

export type PartnerAuthHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

/**
 * Serves the exact partner OAuth routes on the API host. Answers `false` for
 * anything else so the API host filter's 404 stands, and the server carries on
 * as if this were not here. The mode is read once, here, from the environment:
 * no header, cookie or query can select it. With `off` the returned handler
 * only ever answers `false`, and nothing has loaded Better Auth.
 */
export function createPartnerAuthHandler({
  mode = readPartnerOAuthMode(),
  loadRuntime = loadPartnerAuthority,
  bodyReadDeadlineMs = BODY_READ_DEADLINE_MS,
}: PartnerAuthHandlerOptions = {}): PartnerAuthHandler {
  if (mode === 'off') return async () => false;

  const bodyReadSlots = createBodyReadSlots();

  async function loadRuntimeForRequest(): Promise<PartnerRuntime | null> {
    try {
      return await loadRuntime(mode);
    } catch (error) {
      logger.error('Partner OAuth could not start', {
        errorName: error instanceof Error ? error.name : 'unknown',
      });
      return null;
    }
  }

  async function bufferedBody(
    req: IncomingMessage,
    identity: PartnerLimitIdentity,
    ledger: RateLimitLedger,
  ): Promise<Buffer> {
    await consumePerAddress(ledger, identity, 'oauth-body-ip', BODY_READS_PER_IP);
    const releaseSlot = bodyReadSlots.tryAcquire(identity);
    if (!releaseSlot) throw new PartnerBodyRefused(503);
    try {
      return await readBoundedBody(req, bodyReadDeadlineMs);
    } finally {
      releaseSlot();
    }
  }

  /**
   * Every limit that can refuse a token or revoke, before a transaction or a
   * permit is taken. The whole-app count is only checked here. It is charged
   * after a token response succeeds, because a public client_id is no secret and
   * charging it by name would let anyone spend one app's whole budget.
   */
  async function applyTokenLimits(
    kind: PartnerRouteKind,
    fields: Record<string, string>,
    clientId: string | undefined,
    identity: PartnerLimitIdentity,
    ledger: RateLimitLedger,
  ): Promise<void> {
    const bucketClientId = clientId ?? 'invalid';
    const perApp = (address: string) => `${bucketClientId}:${address}`;
    if (kind === 'token' && fields.grant_type === 'refresh_token') {
      await consumePerAddress(ledger, identity, 'oauth-refresh-ip', REFRESH_PER_APP_AND_IP, perApp);
    } else {
      await consumePerAddress(ledger, identity, 'oauth-client', TOKEN_PER_APP_AND_IP, perApp);
    }
    if (kind === 'token' && clientId) await ledger.check(clientId, 'oauth-client', TOKEN_PER_APP);
  }

  /**
   * Only a token response proves the caller held a live code or refresh token.
   * Revoke does not count: RFC 7009 answers 200 for an unknown token too.
   */
  async function chargeWholeAppBudget(
    kind: PartnerRouteKind,
    clientId: string | undefined,
    response: Response,
  ): Promise<void> {
    if (kind === 'token' && clientId && response.ok) await chargePartnerLimit(clientId, 'oauth-client');
  }

  async function serveBodyRoute(
    req: IncomingMessage,
    route: PartnerRoute,
    runtime: PartnerRuntime,
    identity: PartnerLimitIdentity,
    ledger: RateLimitLedger,
    requestId: string,
  ): Promise<{ response: Response; clientId: string | undefined }> {
    const isConsent = CONSENT_ROUTES.has(route.kind);
    // One bucket for both: the screen reads the details once and posts once.
    if (isConsent) await consumePerAddress(ledger, identity, 'oauth-consent', CONSENT_PER_IP);
    const body = await bufferedBody(req, identity, ledger);
    // Consent posts JSON and carries no client credentials to bill.
    const fields = isConsent ? {} : formFields(body);
    const clientId = isConsent ? undefined : claimedClientId(req, fields);
    if (!isConsent) await applyTokenLimits(route.kind, fields, clientId, identity, ledger);

    const permit = await runtime.admission.acquire('token');
    if (!permit) return { response: unavailableResponse(), clientId };
    let response: Response;
    try {
      // Keyed by the connection of a current token, and only checked here,
      // before the transaction: the request is not authenticated yet. A consumed
      // token gets only the address bound, because the first authenticated
      // replay of it closes the family anyway.
      let connectionBucket: string | undefined;
      let tokenClientId: string | undefined;
      if (route.kind === 'token' && fields.grant_type === 'refresh_token' && fields.refresh_token) {
        const connection = await findRefreshConnectionSafely(runtime, fields.refresh_token, requestId);
        if (connection === 'unavailable') return { response: unavailableResponse(), clientId };
        if (connection) {
          connectionBucket = `${connection.clientId}:${connection.connectionId}`;
          tokenClientId = connection.clientId;
          await ledger.check(connectionBucket, 'oauth-refresh', REFRESH_PER_CONNECTION);
        }
      }
      response = await runtime.handleRequest(buildPartnerRequest(req, route, runtime.configuration.issuer, body), {
        logContext: { requestId, clientId },
      });
      // Charged only when the token's own app authenticated and the provider got
      // past that, so someone holding a confidential app's token without its
      // secret cannot spend the connection's budget: not with a malformed
      // request, and not by naming some public app instead, which is refused
      // before any lock. A public app authenticates by client_id alone, so
      // every authenticated attempt it makes is charged. Charged before the
      // permit is released: at most PARTNER_POOL_MAX requests are ever between
      // this check and their charge on one instance.
      if (connectionBucket && clientId === tokenClientId && (await reachedAfterClientAuthentication(response))) {
        await chargePartnerLimit(connectionBucket, 'oauth-refresh');
      }
    } finally {
      permit.release();
    }
    await chargeWholeAppBudget(route.kind, clientId, response);
    return { response, clientId };
  }

  /**
   * This query runs outside `handlePartnerRequest`, so it needs its own guard: a
   * Drizzle error's message and params carry the token hash, and an uncaught one
   * would reach the server's error log and Sentry. Name and code only.
   */
  async function findRefreshConnectionSafely(runtime: PartnerRuntime, refreshToken: string, requestId: string) {
    try {
      return await runtime.findRefreshConnection(refreshToken);
    } catch (error) {
      logger.error('Partner OAuth refresh lookup failed', {
        requestId,
        errorName: error instanceof Error ? error.name : 'unknown',
        postgresCode: getPostgresErrorCode(error),
      });
      return 'unavailable' as const;
    }
  }

  async function serveAuthorize(
    req: IncomingMessage,
    route: PartnerRoute,
    runtime: PartnerRuntime,
    identity: PartnerLimitIdentity,
    ledger: RateLimitLedger,
    requestId: string,
  ): Promise<Response> {
    await consumePerAddress(ledger, identity, 'oauth-authorize', AUTHORIZE_PER_IP);
    const permit = await runtime.admission.acquire('authorize');
    if (!permit) return unavailableResponse();
    try {
      // The session is known only inside the provider's hooks, but one can only
      // come from a NextAuth cookie. Without the cookie this is signed out, and
      // the plan keeps only a signed-in authorize in a transaction.
      const mayHaveSession = NEXTAUTH_SESSION_COOKIE.test(req.headers.cookie ?? '');
      return await runtime.handleRequest(buildPartnerRequest(req, route, runtime.configuration.issuer, null), {
        transaction: mayHaveSession,
        logContext: { requestId },
      });
    } finally {
      permit.release();
    }
  }

  async function servePreflight(req: IncomingMessage, res: ServerResponse, route: PartnerRoute): Promise<void> {
    const runtime = await loadRuntimeForRequest();
    const policy = corsPolicyFor(route.kind);
    if (!runtime || !policy) {
      res.writeHead(503, { 'Cache-Control': 'no-store', 'Retry-After': UNAVAILABLE_RETRY_AFTER_SECONDS });
      res.end();
      return;
    }
    const headers = await partnerPreflightHeaders({
      policy,
      origin: req.headers.origin,
      webOrigin: runtime.configuration.webOrigin,
      directory: runtime.registeredOrigins,
    });
    res.writeHead(204, headers);
    res.end();
  }

  async function serveRoute(req: IncomingMessage, res: ServerResponse, route: PartnerRoute): Promise<void> {
    const requestId = `req_${randomBytes(12).toString('base64url')}`;
    const ledger = new RateLimitLedger();
    const identity = getPartnerLimitIdentity(req);
    const policy = corsPolicyFor(route.kind);
    let runtime: PartnerRuntime | null = null;
    let clientId: string | undefined;
    let closeConnection = false;

    let response: Response;
    try {
      if (route.kind === 'error') {
        response = errorPageResponse(req.url);
      } else {
        runtime = await loadRuntimeForRequest();
        if (!runtime) response = unavailableResponse();
        else if (route.kind === 'discovery') response = await runtime.discoveryResponse({ requestId });
        else if (route.kind === 'authorize') {
          response = await serveAuthorize(req, route, runtime, identity, ledger, requestId);
        } else {
          const outcome = await serveBodyRoute(req, route, runtime, identity, ledger, requestId);
          response = outcome.response;
          clientId = outcome.clientId;
        }
      }
    } catch (error) {
      if (error instanceof PartnerRateLimited) response = rateLimitedResponse(error);
      else if (error instanceof PartnerBodyRefused) {
        response = bodyRefusedResponse(error);
        // The sender may still be sending, so the socket goes after the reply.
        closeConnection = true;
      } else throw error;
    }

    await writePartnerResponse(req, res, response, runtime, {
      requestId,
      policy,
      clientId,
      rateLimitHeaders: ledger.headers(),
      closeConnection,
    });
    logger.info('Partner OAuth request', { requestId, clientId, route: route.kind, status: response.status });
  }

  return async function handlePartnerAuth(req, res): Promise<boolean> {
    if (!isApiHost(req.headers.host)) return false;
    const route = matchPartnerRoute(req.method, req.url);
    const preflight = route ? undefined : matchPartnerPreflight(req.method, req.url);
    if (!route && !preflight) return false;

    if (mode === 'hold') {
      const held = holdResponse();
      res.writeHead(held.status, Object.fromEntries(held.headers.entries()));
      res.end(await held.text());
      return true;
    }

    if (preflight) await servePreflight(req, res, preflight);
    else if (route) await serveRoute(req, res, route);
    return true;
  };
}
