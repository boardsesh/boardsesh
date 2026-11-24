import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { McpServer } from '@modelcontextprotocol/server';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import type { PartnerBearerResult, PartnerApiPrincipal } from '../../auth/partner/bearer';
import { readPartnerOAuthMode, type PartnerOAuthMode } from '../../auth/partner/mode';
import { isApiHost } from '../../handlers/api-host';
import { parseBearerAuthorization } from '../../handlers/public-api/http';
import { readWorkoutBody, WorkoutBodyError } from '../../handlers/public-api/workouts';
import { PartnerRateLimited, RateLimitLedger } from '../../handlers/partner-rate-limits';
import { getPartnerLimitIdentity } from '../../utils/client-ip';
import { logger } from '../../utils/logger';
import { recordGymMcpPendingAuthAddressRefusal, recordPublicApiRequest } from '../../services/public-api-usage';
import {
  GYM_MCP_RESOURCE,
  GYM_MCP_SCOPES,
  GYM_MCP_DEFAULT_SCOPES,
  GYM_MCP_ADMIN_SCOPES,
  readGymMcpMode,
  type GymMcpMode,
} from './configuration';
import { GymMcpRequestLifetime, runWithGymMcpRequestLifetime } from './request-lifetime';

export const GYM_MCP_PATH = '/mcp/gyms';
export const GYM_MCP_METADATA_PATH = '/.well-known/oauth-protected-resource/mcp/gyms';
export const GYM_MCP_STATUS_PATH = '/mcp/gyms/status';
const ALLOWED_ORIGINS = new Set(['https://chatgpt.com', 'https://claude.ai', 'https://www.boardsesh.com']);
const MAX_ACTIVE_REQUESTS = 32;
const MAX_ACTIVE_PER_CONNECTION = 4;
const MAX_PENDING_AUTH_PER_ADDRESS = 4;

export interface GymMcpHandlerOptions {
  mode?: GymMcpMode;
  partnerMode?: PartnerOAuthMode;
  authenticate?: (token: string) => Promise<PartnerBearerResult>;
  createServer?: (principal: PartnerApiPrincipal, selectedTool?: string) => McpServer | Promise<McpServer>;
}

function reply(res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Cache-Control': 'no-store', 'Content-Type': 'application/json', ...headers });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

function challenge(error?: 'invalid_token' | 'insufficient_scope'): string {
  return `Bearer resource_metadata="https://api.boardsesh.com${GYM_MCP_METADATA_PATH}", scope="${GYM_MCP_DEFAULT_SCOPES.join(' ')}"${error ? `, error="${error}"` : ''}`;
}

function toolName(body: unknown): string | undefined {
  if (
    typeof body !== 'object' ||
    body === null ||
    !('method' in body) ||
    body.method !== 'tools/call' ||
    !('params' in body)
  )
    return;
  const params = body.params;
  if (typeof params !== 'object' || params === null || !('name' in params) || typeof params.name !== 'string') return;
  return /^[a-zA-Z0-9_-]{1,100}$/.test(params.name) ? params.name : undefined;
}

/** A server and transport exist for one request, so one user's actor can never leak into another call. */
export function createGymMcpHandler({
  mode = readGymMcpMode(),
  partnerMode = readPartnerOAuthMode(),
  authenticate = async (token) => (await import('./auth')).authenticateGymMcpBearer(token),
  createServer = async (principal, selectedTool) =>
    (await import('./server')).createGymMcpServer(principal, selectedTool),
}: GymMcpHandlerOptions = {}): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const enabled = mode !== 'off' && (partnerMode === 'allowlist' || partnerMode === 'open');
  const held = mode !== 'off' && partnerMode === 'hold';
  let activeRequests = 0;
  const activeByConnection = new Map<string, number>();
  const pendingAuthByAddress = new Map<string, number>();

  return async (req, res) => {
    if (!isApiHost(req.headers.host)) return false;
    const pathname = (req.url ?? '').split('?')[0];
    if (pathname === GYM_MCP_STATUS_PATH && (req.method === 'GET' || req.method === 'HEAD')) {
      reply(res, 200, req.method === 'HEAD' ? undefined : { enabled, invitationRequired: enabled && mode === 'pilot' });
      return true;
    }
    if (pathname !== GYM_MCP_PATH && pathname !== GYM_MCP_METADATA_PATH) return false;
    if (!enabled && !held) return false;
    if (held) {
      reply(res, 503, { error: 'temporarily_unavailable' }, { 'Retry-After': '60' });
      return true;
    }
    const origin = req.headers.origin;
    if (origin !== undefined && !ALLOWED_ORIGINS.has(origin)) {
      reply(res, 403, { error: 'origin_not_allowed' });
      return true;
    }
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Expose-Headers', 'WWW-Authenticate, Retry-After, X-Request-Id');
    }
    if (pathname === GYM_MCP_METADATA_PATH) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        reply(res, 405, { error: 'method_not_allowed' }, { Allow: 'GET, HEAD' });
      } else {
        reply(
          res,
          200,
          req.method === 'HEAD'
            ? undefined
            : {
                resource: GYM_MCP_RESOURCE,
                authorization_servers: ['https://api.boardsesh.com/api/auth'],
                scopes_supported: GYM_MCP_SCOPES,
                bearer_methods_supported: ['header'],
                resource_name: 'Boardsesh gym management',
                resource_documentation: 'https://www.boardsesh.com/developers/gym-mcp',
              },
        );
      }
      return true;
    }
    if (req.method === 'OPTIONS') {
      reply(res, 204, undefined, {
        'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept, MCP-Protocol-Version, MCP-Session-Id',
        'Access-Control-Max-Age': '300',
      });
      return true;
    }
    const startedAt = performance.now();
    const requestId = randomUUID();
    res.setHeader('X-Request-Id', requestId);
    let principal: PartnerApiPrincipal | undefined;
    let selectedTool: string | undefined;
    let admissionRefusal: 'pending_auth_address_cap' | undefined;
    let reservedConnection: string | undefined;
    let reservedAddress: string | undefined;
    let reservedRequest = false;
    let server: McpServer | undefined;
    let responseCompleted = false;
    const lifetime = new GymMcpRequestLifetime();
    const requestAbort = new AbortController();
    let rejectCancellation: (error: unknown) => void = () => {};
    const cancelled = new Promise<never>((_resolve, reject) => {
      rejectCancellation = reject;
    });
    // Token lookup keeps its capacity reservation until it settles. If the
    // client leaves during that lookup, the cancellation is observed afterward.
    void cancelled.catch(() => undefined);
    function cancelRequest(): void {
      if (requestAbort.signal.aborted) return;
      requestAbort.abort();
      rejectCancellation(requestAbort.signal.reason);
      // SDK 2.4's direct legacy HTTP transport does not forward Request.signal
      // to ctx.mcpReq.signal. Closing this request's server aborts its callbacks.
      void server?.close().catch(() => undefined);
    }
    function onResponseClose(): void {
      if (!responseCompleted && !res.writableEnded) cancelRequest();
    }
    req.once('aborted', cancelRequest);
    res.once?.('close', onResponseClose);
    if (req.aborted || (res.destroyed && !res.writableEnded)) cancelRequest();
    const identity = getPartnerLimitIdentity(req);
    const authenticationAddress = identity.sharedEgress ?? identity.key;
    const ledger = new RateLimitLedger();
    function releaseAddress(): void {
      if (reservedAddress === undefined) return;
      const remaining = (pendingAuthByAddress.get(reservedAddress) ?? 1) - 1;
      if (remaining > 0) pendingAuthByAddress.set(reservedAddress, remaining);
      else pendingAuthByAddress.delete(reservedAddress);
      reservedAddress = undefined;
    }
    try {
      const bearer = parseBearerAuthorization(req.headers.authorization);
      if (bearer.problem !== undefined) {
        reply(
          res,
          401,
          { error: 'authentication_required' },
          { 'WWW-Authenticate': challenge(bearer.problem === 'missing' ? undefined : 'invalid_token') },
        );
        return true;
      }
      // One address cannot occupy all token lookups. Valid cloud users release
      // this permit as soon as their actor is known; their tool concurrency and
      // rate budgets remain account/client scoped.
      const pendingAddressCalls = pendingAuthByAddress.get(authenticationAddress) ?? 0;
      if (pendingAddressCalls >= MAX_PENDING_AUTH_PER_ADDRESS) {
        admissionRefusal = 'pending_auth_address_cap';
        recordGymMcpPendingAuthAddressRefusal();
        reply(res, 429, { error: 'rate_limited' }, { 'Retry-After': '2' });
        return true;
      }
      pendingAuthByAddress.set(authenticationAddress, pendingAddressCalls + 1);
      reservedAddress = authenticationAddress;
      if (activeRequests >= MAX_ACTIVE_REQUESTS) {
        reply(res, 503, { error: 'temporarily_unavailable' }, { 'Retry-After': '2' });
        return true;
      }
      activeRequests += 1;
      reservedRequest = true;
      const authentication = await authenticate(bearer.token);
      requestAbort.signal.throwIfAborted();
      if (!authentication.principal) {
        await ledger.consume(identity.key, 'gymMcpInvalidToken', 600);
        reply(res, 401, { error: 'invalid_token' }, { 'WWW-Authenticate': challenge('invalid_token') });
        return true;
      }
      principal = authentication.principal;
      releaseAddress();
      if (
        !principal.scopes.some(
          (scope) => scope === 'gyms:read' || GYM_MCP_ADMIN_SCOPES.some((adminScope) => adminScope === scope),
        )
      ) {
        reply(res, 403, { error: 'insufficient_scope' }, { 'WWW-Authenticate': challenge('insufficient_scope') });
        return true;
      }
      const connectionCalls = activeByConnection.get(principal.connectionId) ?? 0;
      if (connectionCalls >= MAX_ACTIVE_PER_CONNECTION) {
        reply(res, 429, { error: 'rate_limited' }, { 'Retry-After': '2' });
        return true;
      }
      activeByConnection.set(principal.connectionId, connectionCalls + 1);
      reservedConnection = principal.connectionId;
      await ledger.consume(principal.connectionId, 'gymMcpConnection', 120);
      await ledger.consume(principal.clientId, 'gymMcpClient', 6000);
      if (req.method !== 'POST') {
        reply(res, 405, { error: 'method_not_allowed' }, { Allow: 'POST, OPTIONS' });
        return true;
      }
      const body = await readWorkoutBody(req, identity.key);
      requestAbort.signal.throwIfAborted();
      selectedTool = toolName(body);
      const headers = new Headers();
      for (const headerName of ['accept', 'content-type', 'mcp-protocol-version', 'mcp-session-id']) {
        const header = req.headers[headerName];
        if (typeof header === 'string') headers.set(headerName, header);
      }
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      server = await createServer(principal, selectedTool);
      requestAbort.signal.throwIfAborted();
      await server.connect(transport);
      requestAbort.signal.throwIfAborted();
      const response = await Promise.race([
        runWithGymMcpRequestLifetime(lifetime, () =>
          transport.handleRequest(
            new Request(GYM_MCP_RESOURCE, {
              method: 'POST',
              headers,
              body: JSON.stringify(body),
              signal: requestAbort.signal,
            }),
            { parsedBody: body },
          ),
        ),
        cancelled,
      ]);
      for (const [headerName, header] of response.headers) res.setHeader(headerName, header);
      for (const [headerName, header] of Object.entries(ledger.headers())) res.setHeader(headerName, header);
      res.setHeader('Cache-Control', 'no-store');
      res.writeHead(response.status);
      res.end(Buffer.from(await response.arrayBuffer()));
      responseCompleted = true;
    } catch (error) {
      if (requestAbort.signal.aborted) {
        // The peer is already gone; retain a cancellation outcome for metrics.
        res.statusCode = 499;
      } else if (error instanceof PartnerRateLimited) {
        reply(res, 429, { error: 'rate_limited' }, { 'Retry-After': String(error.retryAfterSeconds) });
      } else if (error instanceof WorkoutBodyError) {
        reply(res, error.status, { error: 'invalid_request', message: error.message });
      } else {
        logger.error('Gym MCP request failed', {
          requestId,
          errorName: error instanceof Error ? error.name : 'unknown',
        });
        if (!res.headersSent) reply(res, 503, { error: 'temporarily_unavailable' }, { 'Retry-After': '2' });
      }
    } finally {
      req.off('aborted', cancelRequest);
      res.off?.('close', onResponseClose);
      await lifetime.finish();
      releaseAddress();
      if (reservedRequest) activeRequests -= 1;
      if (reservedConnection) {
        const remaining = (activeByConnection.get(reservedConnection) ?? 1) - 1;
        if (remaining > 0) activeByConnection.set(reservedConnection, remaining);
        else activeByConnection.delete(reservedConnection);
      }
      await server?.close();
      recordPublicApiRequest(principal?.clientId, 'mcp', res.statusCode, performance.now() - startedAt);
      logger.info('Gym MCP request', {
        requestId,
        clientId: principal?.clientId,
        connectionId: principal?.connectionId,
        tool: selectedTool,
        status: res.statusCode,
        completed: responseCompleted,
        admissionRefusal,
      });
    }
    return true;
  };
}
