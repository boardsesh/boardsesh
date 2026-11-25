// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { CATALOG_PROOF_HEADER, verifyCatalogRequest } from '@boardsesh/crypto/catalog-request-proof';

const { requestHeaders } = vi.hoisted(() => ({ requestHeaders: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ headers: requestHeaders }));
import { catalogGraphQLProofHeaders, catalogRequestIdentity } from '../catalog-attribution.server';

const SECRET = 'catalog-attribution-trust-test-secret';
async function proofForHeaders(incoming: Record<string, string>) {
  requestHeaders.mockResolvedValue(new Headers(incoming));
  const identity = await catalogRequestIdentity();
  const proof = catalogGraphQLProofHeaders('https://backend.test/graphql', identity)[CATALOG_PROOF_HEADER];
  return verifyCatalogRequest(proof, { purpose: 'graphql', method: 'POST', pathname: '/graphql' }, SECRET);
}

describe('SSR attribution uses trusted ingress identities', () => {
  beforeEach(() => vi.stubEnv('NEXTAUTH_SECRET', SECRET));
  afterEach(() => vi.unstubAllEnvs());

  it('does not sign caller-controlled forwarder prefixes or direct-origin CF headers', async () => {
    expect(
      await proofForHeaders({
        'x-forwarded-for': '192.0.2.99, 203.0.113.8',
        'cf-connecting-ip': '192.0.2.99',
      }),
    ).toEqual({ clientIp: '203.0.113.8' });
  });

  it('keeps visitors separate instead of charging every guest to the SSR host', async () => {
    expect(await proofForHeaders({ 'x-forwarded-for': '203.0.113.8' })).toEqual({ clientIp: '203.0.113.8' });
    expect(await proofForHeaders({ 'x-forwarded-for': '203.0.113.9' })).toEqual({ clientIp: '203.0.113.9' });
    // Anonymous guests behind one NAT intentionally share that network bucket.
    expect(await proofForHeaders({ 'x-forwarded-for': '198.51.100.3, 203.0.113.8' })).toEqual({
      clientIp: '203.0.113.8',
    });
  });

  it('uses one bounded unknown bucket if the ingress supplies no client identity', async () => {
    expect(await proofForHeaders({ 'cf-connecting-ip': '192.0.2.99' })).toEqual({ clientIp: 'unknown' });
  });
});
