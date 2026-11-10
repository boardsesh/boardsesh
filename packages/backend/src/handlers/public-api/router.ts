import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import { renderPublicApiDocument } from '@boardsesh/public-api';
import { loadPartnerAuthority } from '../../auth/partner/load-authority';
import { readPartnerOAuthMode, type PartnerOAuthMode } from '../../auth/partner/mode';
import { getMediaPublicBaseUrl } from '../../storage/s3';
import { apiLaneGroup, getPartnerLimitIdentity, type PartnerLimitIdentity } from '../../utils/client-ip';
import { logger } from '../../utils/logger';
import { getPostgresErrorCode } from '../../utils/postgres-errors';
import { isApiHost } from '../api-host';
import { partnerPreflightHeaders, partnerResponseCorsHeaders } from '../partner-cors';
import { PartnerRateLimited, partnerRateLimitedHeaders, RateLimitLedger } from '../partner-rate-limits';
import {
  matchPublicApiPreflight,
  matchPublicApiRoute,
  parseBearerAuthorization,
  presentMe,
  type PublicApiRequestRoute,
} from './http';
import { serveLogbookChanges, serveLogbookTick } from './logbook';
import {
  CHALLENGE_INVALID_TOKEN,
  CHALLENGE_NO_TOKEN,
  errorOutcome,
  serverError,
  unauthorized,
  unavailable,
  type ApiOutcome,
} from './outcome';

export type PartnerRuntime = NonNullable<Awaited<ReturnType<typeof loadPartnerAuthority>>>;
type PartnerRuntimeLoader = (mode: PartnerOAuthMode) => Promise<PartnerRuntime | null>;
type PartnerApiPrincipal = Parameters<PartnerRuntime['api']['readClimber']>[0];

/** `docs/integration-platform.md`, "Operations" → "Limits". */
const API_PER_CONNECTION = 120;
const API_PER_APP = 6000;
/**
 * Token lookups that found nothing, per client address (per zone for a
 * Cloudflare Worker, `getPartnerLimitIdentity`). Charged, and refused with 429,
 * only after a lookup has failed: never before one. Many partners share one
 * address (carrier and cloud NAT, and every Worker that sends no zone), so a
 * check before the lookup would let one sender of junk lock every neighbour's
 * valid token out. The database work junk can cause is bounded by the `/v1`
 * admission lanes instead, which route on how many requests an address has in
 * flight, never on how many failed. One address refreshing every climber's
 * hourly token at this rate serves 36,000 climbers, the sizing of the token
 * endpoint's refresh bound.
 *
 * There is deliberately no ceiling across Worker zones, unlike the OAuth routes:
 * this count is charged after the lookup, so it saves no database work, and a
 * shared ceiling would only let one junk Worker turn every other Worker
 * partner's expired-token 401s into 429s. A Worker that forges new zone names
 * dodges its own 600; the lanes still hold every Worker zone together to its
 * share of the database.
 */
const INVALID_TOKENS_PER_IP = 600;

const HOLD_RETRY_AFTER_SECONDS = 60;
const RUNTIME_UNAVAILABLE_RETRY_AFTER_SECONDS = '2';
/** The document changes only with a deploy. */
const OPENAPI_CACHE_CONTROL = 'public, max-age=300';

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
 * Serves the public `/v1` API on the API host: `GET /v1/me`,
 * `DELETE /v1/connection`, `GET /v1/logbook/changes`,
 * `GET /v1/logbook/ticks/{id}` and the OpenAPI document. Shares
 * `PARTNER_OAUTH_MODE` with the OAuth routes, read once here from the
 * environment. With `off` the returned handler only ever answers `false`, and
 * nothing has loaded Better Auth or opened a pool. Answers `false` for anything
 * else, so the API host's 404 stands.
 */
export function createPublicApiHandler({
  mode = readPartnerOAuthMode(),
  loadRuntime = loadPartnerAuthority,
  mediaBaseUrl = getMediaPublicBaseUrl,
}: PublicApiHandlerOptions = {}): PublicApiHandler {
  if (mode === 'off') return async () => false;

  let openApiDocument: string | undefined;

  async function loadRuntimeForRequest(): Promise<PartnerRuntime | null> {
    try {
      return await loadRuntime(mode);
    } catch (error) {
      logger.error('Partner API could not start', { errorName: error instanceof Error ? error.name : 'unknown' });
      return null;
    }
  }

  async function serveForPrincipal(
    req: IncomingMessage,
    route: PublicApiRequestRoute,
    runtime: PartnerRuntime,
    principal: PartnerApiPrincipal,
    requestId: string,
    releaseApiPermit: () => void,
  ): Promise<ApiOutcome> {
    switch (route.kind) {
      case 'me': {
        const climber = await runtime.api.readClimber(principal);
        if (!climber) return unauthorized(requestId, CHALLENGE_INVALID_TOKEN, 'climber_gone');
        return { status: 200, body: presentMe(climber, mediaBaseUrl()) };
      }
      case 'connection': {
        const outcome = await runtime.api.disconnect(principal);
        if (outcome === 'token_invalid') return unauthorized(requestId, CHALLENGE_INVALID_TOKEN, 'changed_under_lock');
        return { status: 204 };
      }
      case 'logbook-changes':
        return serveLogbookChanges({ logbook: runtime.logbook, principal, requestId, releaseApiPermit }, req.url ?? '');
      case 'logbook-tick':
        return serveLogbookTick({ logbook: runtime.logbook, principal, requestId, releaseApiPermit }, route.tickId);
      case 'openapi':
        throw new Error('The OpenAPI document is served without a token.');
    }
  }

  /**
   * The order matters for who can spend what. The lookup runs inside the
   * two-permit `/v1` lanes, which bound what junk can cost the database. One
   * address group holds at most 8 places in the shared lane; its further
   * requests wait in the one-permit overflow lane, and a burst of 16 valid
   * requests from one address is still served, only slower. When a lane's
   * queue is full, the group holding the most places gives one up to a group
   * holding fewer, so a few flooding addresses cannot fill it between them
   * either (`auth/partner/admission.ts`).
   * A failed lookup charges its address, and only a failed lookup can be
   * refused for that count. An app's and a connection's budgets are charged
   * only once a token for them has passed, so a caller without one cannot
   * spend either. Snapshot work hands the permit back before it starts and
   * runs on its own pool, so a build never holds a `/v1` connection.
   */
  async function serveRequest(
    req: IncomingMessage,
    route: PublicApiRequestRoute,
    runtime: PartnerRuntime,
    identity: PartnerLimitIdentity,
    ledger: RateLimitLedger,
    requestId: string,
    authenticated: (clientId: string) => void,
  ): Promise<ApiOutcome> {
    const bearer = parseBearerAuthorization(req.headers.authorization);
    if (bearer.problem !== undefined) {
      const challenge = bearer.problem === 'missing' ? CHALLENGE_NO_TOKEN : CHALLENGE_INVALID_TOKEN;
      return unauthorized(requestId, challenge, bearer.problem);
    }

    const permit = await runtime.admission.acquire('api', apiLaneGroup(identity.key), identity.sharedEgress);
    if (!permit) return unavailable(requestId);
    try {
      const result = await runtime.api.authenticate(bearer.token);
      if (!result.principal) {
        // Counts this failure and refuses with 429 once the address is past its limit.
        await ledger.consume(identity.key, 'api-invalid-token-ip', INVALID_TOKENS_PER_IP);
        return unauthorized(requestId, CHALLENGE_INVALID_TOKEN, result.refusal);
      }
      const { principal } = result;
      authenticated(principal.clientId);
      await ledger.consume(`${principal.clientId}:${principal.userId}`, 'api-connection', API_PER_CONNECTION);
      await ledger.consume(principal.clientId, 'api-app', API_PER_APP);
      // Connected apps' "last used": a write at most once an hour per connection.
      await runtime.api.recordUse(principal);
      return await serveForPrincipal(req, route, runtime, principal, requestId, () => permit.release());
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

  async function serveRoute(req: IncomingMessage, res: ServerResponse, route: PublicApiRequestRoute): Promise<void> {
    const requestId = `req_${randomBytes(12).toString('base64url')}`;
    const ledger = new RateLimitLedger();
    const identity = getPartnerLimitIdentity(req);
    let runtime: PartnerRuntime | null = null;
    let clientId: string | undefined;

    let outcome: ApiOutcome;
    try {
      runtime = await loadRuntimeForRequest();
      outcome = runtime
        ? await serveRequest(req, route, runtime, identity, ledger, requestId, (authenticatedClientId) => {
            clientId = authenticatedClientId;
          })
        : unavailable(requestId);
    } catch (error) {
      if (error instanceof PartnerRateLimited) {
        outcome = errorOutcome(429, 'rate_limited', 'Too many requests. Wait for Retry-After.', requestId, {
          headers: partnerRateLimitedHeaders(error),
        });
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

  /**
   * The published contract, the committed `openapi.json` byte for byte. Public
   * and credential-free, so any origin may read it; it needs no runtime and
   * touches no database.
   */
  function serveOpenApiDocument(req: IncomingMessage, res: ServerResponse): void {
    openApiDocument ??= renderPublicApiDocument();
    const headers: Record<string, string> = {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': OPENAPI_CACHE_CONTROL,
      'access-control-allow-origin': '*',
      'x-content-type-options': 'nosniff',
    };
    if (requestHasBody(req)) headers.connection = 'close';
    res.writeHead(200, headers);
    res.end(openApiDocument);
  }

  async function servePreflight(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const runtime = await loadRuntimeForRequest();
    if (!runtime) {
      res.writeHead(503, { 'Cache-Control': 'no-store', 'Retry-After': RUNTIME_UNAVAILABLE_RETRY_AFTER_SECONDS });
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
      const held = unavailable(requestId, {
        retryAfterSeconds: HOLD_RETRY_AFTER_SECONDS,
        message: 'The API is paused. Try again shortly.',
      });
      await writeOutcome(req, res, held, { runtime: null, clientId: undefined, requestId, rateLimitHeaders: {} });
      return true;
    }

    if (route?.kind === 'openapi') serveOpenApiDocument(req, res);
    else if (route) await serveRoute(req, res, route);
    else await servePreflight(req, res);
    return true;
  };
}
