// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { CATALOG_PROOF_HEADER, verifyCatalogRequest } from '@boardsesh/crypto/catalog-request-proof';

const { requestHeaders, clientOptions, cacheState } = vi.hoisted(() => ({
  requestHeaders: vi.fn(),
  clientOptions: [] as { headers: Record<string, string> }[],
  cacheState: { active: false },
}));
vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ headers: requestHeaders }));
vi.mock('@/app/lib/auth/server-auth', () => ({ getServerAuthToken: vi.fn() }));
vi.mock('@/app/lib/auth/credential-admission.server', () => ({
  CredentialAuthorityUnavailable: class extends Error {},
}));
vi.mock('@/app/lib/auth/trusted-client-ip.server', () => ({
  trustedClientRateLimitKey: (request: Request) => request.headers.get('x-forwarded-for') ?? 'unknown',
}));
vi.mock('@/app/lib/graphql/client', () => ({ getGraphQLHttpUrl: () => 'https://backend.test/graphql' }));
vi.mock('next/cache', () => ({
  unstable_cache: (work: () => Promise<unknown>) => async () => {
    cacheState.active = true;
    try {
      return await work();
    } finally {
      cacheState.active = false;
    }
  },
}));
vi.mock('graphql-request', async (importOriginal) => ({
  ...(await importOriginal<typeof import('graphql-request')>()),
  GraphQLClient: class {
    constructor(_url: string, options: { headers: Record<string, string> }) {
      clientOptions.push(options);
    }
    request() {
      return Promise.resolve({ result: [] });
    }
  },
}));

import { createCachedGraphQLQuery, executeGraphQLInternal } from '../server-cached-client';
import { executeAuthenticatedGraphQL } from '../server-graphql';

const SECRET = 'catalog-attribution-test-secret';
function verifiedIdentity(index = 0) {
  return verifyCatalogRequest(
    clientOptions[index].headers[CATALOG_PROOF_HEADER],
    { purpose: 'graphql', method: 'POST', pathname: '/graphql' },
    SECRET,
  );
}

describe('SSR catalog attribution', () => {
  beforeEach(() => {
    vi.stubEnv('NEXTAUTH_SECRET', SECRET);
    clientOptions.length = 0;
    cacheState.active = false;
    requestHeaders.mockReset().mockImplementation(async () => {
      expect(cacheState.active).toBe(false);
      return new Headers({ 'x-forwarded-for': '203.0.113.8' });
    });
  });
  afterEach(() => vi.unstubAllEnvs());

  it('preserves static rendering without reading request headers for cached public queries', async () => {
    await createCachedGraphQLQuery('query { climbs }', 'climbs', 60)();
    expect(requestHeaders).not.toHaveBeenCalled();
    expect(verifiedIdentity()).toEqual({ clientIp: 'server-cache' });
  });

  it('attributes uncached discover reads to the visitor outside a cache callback', async () => {
    await createCachedGraphQLQuery('query { playlists }', 'discover-playlists-curated', 60)();
    expect(requestHeaders).toHaveBeenCalledTimes(1);
    expect(verifiedIdentity()).toEqual({ clientIp: '203.0.113.8' });
  });

  it('preserves user authorization while separately proving visitor attribution', async () => {
    await executeAuthenticatedGraphQL('query { climbs }', undefined, 'user-token');
    expect(clientOptions[0].headers.Authorization).toBe('Bearer user-token');
    expect(verifiedIdentity()).toEqual({ clientIp: '203.0.113.8' });
  });

  it('uses the bounded server-cache identity when no request context exists', async () => {
    requestHeaders.mockRejectedValue(new Error('No incoming request'));
    await createCachedGraphQLQuery('query { climbs }', 'climbs', 60)();
    expect(requestHeaders).not.toHaveBeenCalled();
    expect(verifiedIdentity()).toEqual({ clientIp: 'server-cache' });
  });

  it('never reads request headers from the internal cache fetch', async () => {
    cacheState.active = true;
    await executeGraphQLInternal('query { climbs }');
    expect(requestHeaders).not.toHaveBeenCalled();
    expect(verifiedIdentity()).toEqual({ clientIp: 'server-cache' });
  });
});
