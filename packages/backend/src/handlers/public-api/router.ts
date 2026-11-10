import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import { loadPartnerAuthority } from '../../auth/partner/load-authority';
import { readPartnerOAuthMode, type PartnerOAuthMode } from '../../auth/partner/mode';
import { getMediaPublicBaseUrl } from '../../storage/s3';
import { getTrustedClientIp } from '../../utils/client-ip';
import { logger } from '../../utils/logger';
import { getPostgresErrorCode } from '../../utils/postgres-errors';
import { isApiHost } from '../api-host';
import { partnerPreflightHeaders, partnerResponseCorsHeaders } from '../partner-cors';
import {
  isPartnerLimitReached,
  PartnerRateLimited,
  partnerRateLimitedHeaders,
  RateLimitLedger,
} from '../partner-rate-limits';
import {
  apiErrorBody,
  matchPublicApiPreflight,
  matchPublicApiRoute,
  parseBearerAuthorization,
  presentMe,
  type PublicApiErrorCode,
  type PublicApiRoute,
} from './http';

type PartnerRuntime = NonNullable<Awaited<ReturnType<typeof loadPartnerAuthority>>>;
type PartnerRuntimeLoader = (mode: PartnerOAuthMode) => Promise<PartnerRuntime | null>;
type PartnerApiPrincipal = Parameters<PartnerRuntime['api']['readClimber']>[0];

/** `docs/integration-platform.md`, "Operations" → "Limits". */
const API_PER_CONNECTION = 120;
const API_PER_APP = 6000;
/**
 * Token lookups that found nothing, per client address. Charged, and refused
 * with 429, only after a lookup has failed: never before one. Many partners
 * share one address (every Cloudflare Worker reaches us as the same
 * `CF-Connecting-IP`, and carrier and cloud NAT do the same), so a check before
 * the lookup would let one sender of junk lock every neighbour's valid token
 * out. The database work junk can cause is bounded by the `/v1` admission lane
 * instead. One address refreshing every climber's hourly token at this rate
 * serves 36,000 climbers, the sizing of the token endpoint's refresh bound.
 */
const INVALID_TOKENS_PER_IP = 600;
/**
 * Failed lookups in the current minute after which an address's `/v1` requests
 * wait in the `api-flagged` lane: one permit and a queue of four, so its junk
 * can never fill the lane everyone else uses. Routing, not refusal: a valid
 * token from that address is still served there. Far below the 429 limit on
 * purpose, because a junk sender fills the shared lane long before it has
 * failed 600 times: about 30 lookups and the 16 already queued reach it first.
 */
const FAILED_LOOKUPS_BEFORE_OWN_LANE = 30;

const HOLD_RETRY_AFTER_SECONDS = '60';
const UNAVAILABLE_RETRY_AFTER_SECONDS = '2';

/** RFC 6750 section 3. A request with no credentials gets the scheme alone. */
const CHALLENGE_NO_TOKEN = 'Bearer';
const CHALLENGE_INVALID_TOKEN = 'Bearer error="invalid_token"';

interface ApiOutcome {
  status: number;
  /** Already checked against the contract. Absent for a 204. */
  body?: object;
  headers?: Record<string, string>;
  /** For the log line only. */
  refusal?: string;
}

function errorOutcome(
  status: number,
  error: PublicApiErrorCode,
  message: string,
  requestId: string,
  headers: Record<string, string> = {},
  refusal?: string,
): ApiOutcome {
  return { status, body: apiErrorBody(error, message, requestId), headers, refusal };
}

function unauthorized(requestId: string, challenge: string, refusal: string): ApiOutcome {
  return errorOutcome(
    401,
    'invalid_token',
    'The access token is missing, expired or revoked. Refresh once and retry.',
    requestId,
    { 'www-authenticate': challenge },
    refusal,
  );
}

function unavailable(requestId: string, retryAfterSeconds = UNAVAILABLE_RETRY_AFTER_SECONDS): ApiOutcome {
  return errorOutcome(503, 'server_error', 'The server is busy. Try again shortly.', requestId, {
    'retry-after': retryAfterSeconds,
  });
}

function serverError(requestId: string): ApiOutcome {
  return errorOutcome(500, 'server_error', 'Something went wrong on our side. Retry with backoff.', requestId);
}

function requestHasBody(req: IncomingMessage): boolean {
  const declaredLength = Number(req.headers['content-length'] ?? 0);
  return req.headers['transfer-encoding'] !== undefined || (Number.isFinite(declaredLength) && declaredLength > 0);
}

export interface PublicApiHandlerOptions {
  mode?: PartnerOAuthMode;
  loadRuntime?: PartnerRuntimeLoader;
  /** Where uploaded avatars are served from. Read per request, like the `/static` redirect. */
  mediaBaseUrl?: () => string | null;
}

export type PublicApiHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

/**
 * Serves the public `/v1` API on the API host: `GET /v1/me` and
 * `DELETE /v1/connection`. Shares `PARTNER_OAUTH_MODE` with the OAuth routes,
 * read once here from the environment. With `off` the returned handler only
 * ever answers `false`, and nothing has loaded Better Auth or opened a pool.
 * Answers `false` for anything else, so the API host's 404 stands.
 */
export function createPublicApiHandler({
  mode = readPartnerOAuthMode(),
  loadRuntime = loadPartnerAuthority,
  mediaBaseUrl = getMediaPublicBaseUrl,
}: PublicApiHandlerOptions = {}): PublicApiHandler {
  if (mode === 'off') return async () => false;

  async function loadRuntimeForRequest(): Promise<PartnerRuntime | null> {
    try {
      return await loadRuntime(mode);
    } catch (error) {
      logger.error('Partner API could not start', { errorName: error instanceof Error ? error.name : 'unknown' });
      return null;
    }
  }

  async function serveForPrincipal(
    route: PublicApiRoute,
    runtime: PartnerRuntime,
    principal: PartnerApiPrincipal,
    requestId: string,
  ): Promise<ApiOutcome> {
    if (route.kind === 'me') {
      const climber = await runtime.api.readClimber(principal);
      if (!climber) return unauthorized(requestId, CHALLENGE_INVALID_TOKEN, 'climber_gone');
      return { status: 200, body: presentMe(climber, mediaBaseUrl()) };
    }
    const outcome = await runtime.api.disconnect(principal);
    if (outcome === 'token_invalid') return unauthorized(requestId, CHALLENGE_INVALID_TOKEN, 'changed_under_lock');
    return { status: 204 };
  }

  /**
   * The order matters for who can spend what. The lookup runs inside the
   * two-permit `/v1` lanes, which bound what junk can cost the database. An
   * address with many failed lookups waits in its own one-permit lane, so its
   * junk cannot fill the lane everyone else uses; its valid tokens still pass.
   * A failed lookup charges its address, and only a failed lookup can be
   * refused for that count. An app's and a connection's budgets are charged
   * only once a token for them has passed, so a caller without one cannot
   * spend either.
   */
  async function serveRequest(
    req: IncomingMessage,
    route: PublicApiRoute,
    runtime: PartnerRuntime,
    clientIp: string,
    ledger: RateLimitLedger,
    requestId: string,
    authenticated: (clientId: string) => void,
  ): Promise<ApiOutcome> {
    const bearer = parseBearerAuthorization(req.headers.authorization);
    if (bearer.problem !== undefined) {
      const challenge = bearer.problem === 'missing' ? CHALLENGE_NO_TOKEN : CHALLENGE_INVALID_TOKEN;
      return unauthorized(requestId, challenge, bearer.problem);
    }

    const flagged = await isPartnerLimitReached(clientIp, 'api-invalid-token-ip', FAILED_LOOKUPS_BEFORE_OWN_LANE);
    const permit = await runtime.admission.acquire(flagged ? 'api-flagged' : 'api');
    if (!permit) return unavailable(requestId);
    try {
      const result = await runtime.api.authenticate(bearer.token);
      if (!result.principal) {
        // Counts this failure and refuses with 429 once the address is past its limit.
        await ledger.consume(clientIp, 'api-invalid-token-ip', INVALID_TOKENS_PER_IP);
        return unauthorized(requestId, CHALLENGE_INVALID_TOKEN, result.refusal);
      }
      const { principal } = result;
      authenticated(principal.clientId);
      await ledger.consume(`${principal.clientId}:${principal.userId}`, 'api-connection', API_PER_CONNECTION);
      await ledger.consume(principal.clientId, 'api-app', API_PER_APP);
      return await serveForPrincipal(route, runtime, principal, requestId);
    } catch (error) {
      if (error instanceof PartnerRateLimited) throw error;
      if (runtime.api.isDatabaseBusy(error)) return unavailable(requestId);
      // Name and database code only: a Drizzle error's text carries the token hash.
      logger.error('Partner API request failed', {
        requestId,
        route: route.kind,
        errorName: error instanceof Error ? error.name : 'unknown',
        postgresCode: getPostgresErrorCode(error),
      });
      return serverError(requestId);
    } finally {
      permit.release();
    }
  }

  async function writeOutcome(
    req: IncomingMessage,
    res: ServerResponse,
    outcome: ApiOutcome,
    context: {
      runtime: PartnerRuntime | null;
      clientId: string | undefined;
      requestId: string;
      rateLimitHeaders: Record<string, string>;
    },
  ): Promise<void> {
    const { runtime, clientId, requestId, rateLimitHeaders } = context;
    const headers: Record<string, string> = {
      'cache-control': 'no-store',
      'boardsesh-request-id': requestId,
      'x-content-type-options': 'nosniff',
      // A 429 already names the limit it hit.
      ...(outcome.headers?.['ratelimit-limit'] ? {} : rateLimitHeaders),
      ...outcome.headers,
    };
    if (runtime) {
      Object.assign(
        headers,
        await partnerResponseCorsHeaders({
          policy: 'credential-free',
          origin: req.headers.origin,
          webOrigin: runtime.configuration.webOrigin,
          directory: runtime.registeredOrigins,
          status: outcome.status,
          clientId,
        }),
      );
    }
    // No route here reads a body. One that was sent anyway is never drained.
    if (requestHasBody(req)) headers.connection = 'close';
    if (outcome.body === undefined) {
      res.writeHead(outcome.status, headers);
      res.end();
      return;
    }
    headers['content-type'] = 'application/json; charset=utf-8';
    res.writeHead(outcome.status, headers);
    res.end(JSON.stringify(outcome.body));
  }

  async function serveRoute(req: IncomingMessage, res: ServerResponse, route: PublicApiRoute): Promise<void> {
    const requestId = `req_${randomBytes(12).toString('base64url')}`;
    const ledger = new RateLimitLedger();
    const clientIp = getTrustedClientIp(req);
    let runtime: PartnerRuntime | null = null;
    let clientId: string | undefined;

    let outcome: ApiOutcome;
    try {
      runtime = await loadRuntimeForRequest();
      outcome = runtime
        ? await serveRequest(req, route, runtime, clientIp, ledger, requestId, (authenticatedClientId) => {
            clientId = authenticatedClientId;
          })
        : unavailable(requestId);
    } catch (error) {
      if (error instanceof PartnerRateLimited) {
        outcome = errorOutcome(
          429,
          'rate_limited',
          'Too many requests. Wait for Retry-After.',
          requestId,
          partnerRateLimitedHeaders(error),
        );
      } else {
        logger.error('Partner API request failed', {
          requestId,
          route: route.kind,
          errorName: error instanceof Error ? error.name : 'unknown',
        });
        outcome = serverError(requestId);
      }
    }

    await writeOutcome(req, res, outcome, { runtime, clientId, requestId, rateLimitHeaders: ledger.headers() });
    logger.info('Partner API request', {
      requestId,
      clientId,
      route: route.kind,
      status: outcome.status,
      ...(outcome.refusal ? { refusal: outcome.refusal } : {}),
    });
  }

  async function servePreflight(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const runtime = await loadRuntimeForRequest();
    if (!runtime) {
      res.writeHead(503, { 'Cache-Control': 'no-store', 'Retry-After': UNAVAILABLE_RETRY_AFTER_SECONDS });
      res.end();
      return;
    }
    const headers = await partnerPreflightHeaders({
      policy: 'credential-free',
      origin: req.headers.origin,
      webOrigin: runtime.configuration.webOrigin,
      directory: runtime.registeredOrigins,
    });
    res.writeHead(204, { 'Cache-Control': 'no-store', ...headers });
    res.end();
  }

  return async function handlePublicApi(req, res): Promise<boolean> {
    if (!isApiHost(req.headers.host)) return false;
    const route = matchPublicApiRoute(req.method, req.url);
    const preflight = route ? undefined : matchPublicApiPreflight(req.method, req.url);
    if (!route && !preflight) return false;

    if (mode === 'hold') {
      const requestId = `req_${randomBytes(12).toString('base64url')}`;
      const held = errorOutcome(503, 'server_error', 'The API is paused. Try again shortly.', requestId, {
        'retry-after': HOLD_RETRY_AFTER_SECONDS,
      });
      await writeOutcome(req, res, held, { runtime: null, clientId: undefined, requestId, rateLimitHeaders: {} });
      return true;
    }

    if (route) await serveRoute(req, res, route);
    else await servePreflight(req, res);
    return true;
  };
}
