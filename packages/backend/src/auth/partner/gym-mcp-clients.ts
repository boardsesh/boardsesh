import { AsyncLocalStorage } from 'node:async_hooks';
import {
  createCimdClientDiscovery,
  isCimdClientIdUrlCandidate,
  validateCimdMetadata,
  validateClientIdUrl,
} from '@better-auth/cimd';
import { fetchClientMetadataResource } from '@better-auth/cimd/node';
import type { ClientDiscovery, ClientMetadataResourceFetch } from '@better-auth/oauth-provider';
import { APIError } from 'better-auth/api';
import { eq } from 'drizzle-orm';
import { oauthClient, oauthMcpClientPolicy } from '@boardsesh/db/schema/auth';
import {
  GYM_MCP_RESOURCE,
  GYM_MCP_SCOPES,
  GYM_MCP_DEFAULT_SCOPES,
  GYM_MCP_ADMIN_SCOPES,
  gymMcpAllowsClientMetadata,
  type GymMcpConfiguration,
} from '../../mcp/gyms/configuration';
import { createPartnerDatabaseHandle } from './transaction';
import type { PartnerDatabase } from './tables';

const MAX_DOCUMENT_BYTES = 5 * 1024;
const FETCH_TIMEOUT_MS = 5000;
const FETCHES_PER_MINUTE = 600;
const FETCHES_PER_ORIGIN_PER_MINUTE = 300;
const MAX_METADATA_CACHE_ENTRIES = 256;
const MAX_METADATA_CACHE_AGE_MS = 60_000;
const MAX_OUTSTANDING_NETWORK_PREPARATIONS = 16;

class InvalidGymMcpMetadata extends Error {}

/** Network I/O finishes before the OAuth request acquires any database locks. */
export interface GymMcpClientDiscovery {
  discovery: ClientDiscovery;
  withPreparedMetadata(request: Request, work: () => Promise<Response>): Promise<Response>;
}

function invalidClient(): Response {
  return Response.json(
    { error: 'invalid_client', error_description: 'The assistant client identity could not be verified.' },
    {
      status: 400,
      headers: { 'cache-control': 'no-store' },
    },
  );
}

function unavailableClient(): Response {
  return Response.json(
    { error: 'temporarily_unavailable', error_description: 'Assistant sign-in is busy. Try again shortly.' },
    {
      status: 503,
      headers: { 'cache-control': 'no-store', 'retry-after': '2' },
    },
  );
}

/** ChatGPT publishes both supported methods and a legacy JWT preference; negotiate our supported public method. */
function publicClientMetadata(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null || !('token_endpoint_auth_methods_supported' in raw)) return raw;
  const methods = raw.token_endpoint_auth_methods_supported;
  if (
    !Array.isArray(methods) ||
    !methods.every((method: unknown) => typeof method === 'string') ||
    !methods.includes('none')
  )
    return raw;
  const normalized = { ...raw } as Record<string, unknown>;
  normalized.token_endpoint_auth_method = 'none';
  // No key retrieval or JWT verification occurs for the negotiated public client.
  delete normalized.jwks;
  delete normalized.jwks_uri;
  return normalized;
}

/** Bounded shared-cache freshness. Ambiguous cache directives always revalidate. */
function metadataFreshnessMs(headers: Headers, now: number): number {
  const directives = new Map<string, string | undefined>();
  for (const field of (headers.get('cache-control') ?? '').split(',')) {
    const [rawName, rawDuration] = field.trim().split('=');
    if (!rawName) continue;
    const name = rawName.toLowerCase();
    if (directives.has(name)) return 0;
    directives.set(name, rawDuration?.replace(/^"|"$/g, ''));
  }
  if (
    ['no-store', 'private', 'no-cache'].some((name) => directives.has(name)) ||
    headers
      .get('vary')
      ?.split(',')
      .some((name) => name.trim() === '*')
  )
    return 0;
  const lifetimeName = directives.has('s-maxage') ? 's-maxage' : directives.has('max-age') ? 'max-age' : undefined;
  const lifetime = lifetimeName ? directives.get(lifetimeName) : undefined;
  const age = Number(headers.get('age') ?? '0');
  if (!Number.isFinite(age) || age < 0) return 0;
  if (lifetimeName !== undefined) {
    if (lifetime === undefined || !/^\d+$/.test(lifetime)) return 0;
    return Math.max(0, Math.min(MAX_METADATA_CACHE_AGE_MS, (Number(lifetime) - age) * 1000));
  }
  const expires = headers.get('expires');
  if (expires) {
    const expiration = Date.parse(expires);
    return Number.isFinite(expiration) ? Math.max(0, Math.min(MAX_METADATA_CACHE_AGE_MS, expiration - now)) : 0;
  }
  return MAX_METADATA_CACHE_AGE_MS;
}

async function requestClientId(request: Request): Promise<string | null> {
  const url = new URL(request.url);
  if (request.method === 'GET') return url.searchParams.get('client_id');
  const contentType = request.headers.get('content-type') ?? '';
  if (contentType.includes('application/x-www-form-urlencoded')) {
    return new URLSearchParams(await request.clone().text()).get('client_id');
  }
  if (contentType.includes('application/json') && url.pathname.endsWith('/consent')) {
    const body: unknown = await request.clone().json();
    if (typeof body !== 'object' || body === null || !('oauth_query' in body) || typeof body.oauth_query !== 'string')
      return null;
    return new URLSearchParams(body.oauth_query).get('client_id');
  }
  return null;
}

async function readMetadataBody(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new InvalidGymMcpMetadata('Missing client metadata');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_DOCUMENT_BYTES) throw new InvalidGymMcpMetadata('Client metadata is too large');
      chunks.push(chunk.value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/**
 * The SDK validates and stores CIMD records. Its fetch seam reads only this
 * request's already fetched document, so no plugin path can fetch while an
 * OAuth transaction is open. Public clients never supply JWKS or secrets.
 */
export function createGymMcpClientDiscovery(
  database: PartnerDatabase,
  {
    fetchMetadata = fetchClientMetadataResource,
    configuration,
  }: { fetchMetadata?: ClientMetadataResourceFetch; configuration?: GymMcpConfiguration } = {},
): GymMcpClientDiscovery {
  const databaseHandle = createPartnerDatabaseHandle(database);
  const prepared = new AsyncLocalStorage<{ clientId: string; document: string }>();
  let activeFetches = 0;
  let outstandingNetworkPreparations = 0;
  const activeOrigins = new Map<string, number>();
  const fetchStarts: Array<{ origin: string; timestamp: number }> = [];
  const documents = new Map<string, { document: string; expiresAt: number }>();
  const validatedFetch: ClientMetadataResourceFetch = async (input) => {
    const requestedUrl = input instanceof Request ? input.url : String(input);
    const snapshot = prepared.getStore();
    if (!snapshot || requestedUrl !== snapshot.clientId) throw new Error('Client metadata was not prepared');
    return new Response(snapshot.document, {
      status: 200,
      // Every OAuth interaction prepares a fresh bounded response. Never let
      // the plugin turn an earlier document into authority for this request.
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  };
  const cimd = createCimdClientDiscovery({
    fetchClientMetadataResource: validatedFetch,
    isMetadataDocumentUrlAllowed: (clientId) => gymMcpAllowsClientMetadata(configuration, clientId),
    metadataProfile: 'mcp-2026-07-28',
    originBoundFields: ['post_logout_redirect_uris'],
    metadataRevalidationInterval: 0,
    maxCacheEntries: 100,
    metadataFetchPolicy: {
      maximumConcurrentFetches: 4,
      maximumConcurrentFetchesPerOrigin: 2,
      maximumFetchesPerMinute: FETCHES_PER_MINUTE,
      maximumFetchesPerOriginPerMinute: FETCHES_PER_ORIGIN_PER_MINUTE,
    },
  });
  const discovery: ClientDiscovery = {
    ...cimd,
    async resolve(context, clientId, existing) {
      const snapshot = prepared.getStore();
      if (!gymMcpAllowsClientMetadata(configuration, clientId) || !snapshot || snapshot.clientId !== clientId) {
        throw new APIError('BAD_REQUEST', {
          error: 'invalid_client',
          error_description: 'Client metadata was not verified.',
        });
      }
      // Provider registration defaults also affect admin-created training
      // clients. Apply these defaults only inside this discovery's context.
      const originalGetPlugin = context.context.getPlugin.bind(context.context);
      const getPlugin = ((pluginId: string) => {
        const plugin = originalGetPlugin(pluginId);
        return pluginId === 'oauth-provider' && plugin && 'options' in plugin
          ? { ...plugin, options: { ...plugin.options, ...GYM_MCP_REGISTRATION_DEFAULTS } }
          : plugin;
      }) as typeof context.context.getPlugin;
      const discoveryContext = { ...context, context: { ...context.context, getPlugin } };
      const client = await cimd.resolve(discoveryContext, clientId, existing);
      if (!client) return null;
      if (client.tokenEndpointAuthMethod !== 'none' || client.jwks || client.jwksUri) {
        throw new APIError('BAD_REQUEST', {
          error: 'invalid_client',
          error_description: 'Assistant clients must use PKCE without a shared secret.',
        });
      }
      await databaseHandle
        .update(oauthClient)
        .set({ requirePKCE: true, skipConsent: false, scopes: [...GYM_MCP_SCOPES] })
        .where(eq(oauthClient.clientId, clientId));
      // This is part of the same transaction as client creation. The CIMD
      // callback is best-effort, so it cannot establish required policy.
      await databaseHandle.insert(oauthMcpClientPolicy).values({ clientId }).onConflictDoNothing();
      const [policy] = await databaseHandle
        .select()
        .from(oauthMcpClientPolicy)
        .where(eq(oauthMcpClientPolicy.clientId, clientId));
      if (!policy || policy.suspendedAt) {
        throw new APIError('FORBIDDEN', {
          error: 'access_denied',
          error_description: 'This assistant cannot be connected.',
        });
      }
      // This is the server-owned capability ceiling, not a user's grant.
      // Existing tokens and consents retain their original scope lists.
      return { ...client, scopes: [...GYM_MCP_SCOPES], requirePKCE: true, skipConsent: false };
    },
  };
  return {
    discovery,
    async withPreparedMetadata(request, work) {
      let clientId: string | null;
      try {
        clientId = await requestClientId(request);
      } catch {
        return invalidClient();
      }
      if (!clientId || !isCimdClientIdUrlCandidate(clientId)) return work();
      if (
        clientId.length > 2048 ||
        validateClientIdUrl(clientId) ||
        !gymMcpAllowsClientMetadata(configuration, clientId)
      )
        return invalidClient();
      const origin = new URL(clientId).origin;
      const now = Date.now();
      const cached = documents.get(clientId);
      if (cached && cached.expiresAt > now) {
        documents.delete(clientId);
        documents.set(clientId, cached);
        return prepared.run({ clientId, document: cached.document }, work);
      }
      documents.delete(clientId);
      while (fetchStarts[0] && fetchStarts[0].timestamp <= now - 60_000) fetchStarts.shift();
      if (
        activeFetches >= 4 ||
        outstandingNetworkPreparations >= MAX_OUTSTANDING_NETWORK_PREPARATIONS ||
        (activeOrigins.get(origin) ?? 0) >= 2 ||
        fetchStarts.length >= FETCHES_PER_MINUTE ||
        fetchStarts.filter((entry) => entry.origin === origin).length >= FETCHES_PER_ORIGIN_PER_MINUTE
      )
        return unavailableClient();
      fetchStarts.push({ origin, timestamp: now });
      activeFetches += 1;
      activeOrigins.set(origin, (activeOrigins.get(origin) ?? 0) + 1);
      let document: string;
      const controller = new AbortController();
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_resolve, reject) => {
        deadlineTimer = setTimeout(() => {
          controller.abort();
          reject(new Error('Client metadata deadline'));
        }, FETCH_TIMEOUT_MS);
        deadlineTimer.unref();
      });
      try {
        // dns.lookup in the pinned transport cannot itself be cancelled. A
        // complete deadline releases the HTTP request, while the separate
        // outstanding bound caps abandoned lookups until they really settle.
        outstandingNetworkPreparations += 1;
        const networkPreparation = (async () => {
          const response = await fetchMetadata(clientId!, {
            method: 'GET',
            redirect: 'error',
            signal: controller.signal,
            headers: { accept: 'application/json' },
          });
          if (response.status === 429 || response.status >= 500) {
            await response.body?.cancel();
            throw new Error('Client metadata unavailable');
          }
          if (
            response.status !== 200 ||
            !/^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')
          ) {
            await response.body?.cancel();
            throw new InvalidGymMcpMetadata('Client metadata refused');
          }
          const rawDocument = await readMetadataBody(response);
          const parsed = publicClientMetadata(JSON.parse(rawDocument) as unknown);
          const validation = validateCimdMetadata(clientId!, parsed, {
            metadataProfile: 'mcp-2026-07-28',
            originBoundFields: ['post_logout_redirect_uris'],
          });
          if (
            !validation.valid ||
            (validation.metadata.token_endpoint_auth_method ?? 'none') !== 'none' ||
            validation.metadata.jwks ||
            validation.metadata.jwks_uri
          )
            throw new InvalidGymMcpMetadata('Client metadata refused');
          controller.signal.throwIfAborted();
          return { document: JSON.stringify(parsed), lifetime: metadataFreshnessMs(response.headers, Date.now()) };
        })();
        void networkPreparation.then(
          () => {
            outstandingNetworkPreparations -= 1;
          },
          () => {
            outstandingNetworkPreparations -= 1;
          },
        );
        const snapshot = await Promise.race([networkPreparation, deadline]);
        document = snapshot.document;
        if (snapshot.lifetime > 0) {
          while (documents.size >= MAX_METADATA_CACHE_ENTRIES) {
            const oldest = documents.keys().next().value;
            if (oldest === undefined) break;
            documents.delete(oldest);
          }
          documents.set(clientId, { document, expiresAt: Date.now() + snapshot.lifetime });
        }
      } catch (error) {
        return error instanceof InvalidGymMcpMetadata || error instanceof SyntaxError
          ? invalidClient()
          : unavailableClient();
      } finally {
        clearTimeout(deadlineTimer);
        controller.abort();
        activeFetches -= 1;
        const remaining = (activeOrigins.get(origin) ?? 1) - 1;
        if (remaining === 0) activeOrigins.delete(origin);
        else activeOrigins.set(origin, remaining);
      }
      return prepared.run({ clientId, document }, work);
    },
  };
}

export const GYM_MCP_REGISTRATION_DEFAULTS = {
  clientRegistrationDefaultResources: [GYM_MCP_RESOURCE],
  clientRegistrationAllowedResources: [] as string[],
  clientRegistrationDefaultScopes: [...GYM_MCP_DEFAULT_SCOPES],
  clientRegistrationAllowedScopes: [...GYM_MCP_ADMIN_SCOPES],
};
