import { describe, expect, it } from 'vite-plus/test';
import { signCatalogRequest, verifyCatalogRequest } from '../catalog-request-proof';

const secret = 'catalog-proof-test-secret-only';
const now = Date.parse('2026-11-25T00:00:00Z');
const request = {
  purpose: 'reserve' as const,
  method: 'POST',
  pathname: '/internal/catalog-admission',
  clientIp: '203.0.113.10',
  body: JSON.stringify({ operation: 'rest-climb' }),
};

describe('catalog server attribution', () => {
  it('binds the visitor, purpose, method, path, body and signing secret', () => {
    const proof = signCatalogRequest(request, secret, now);
    expect(verifyCatalogRequest(proof, request, secret, now)).toEqual({ clientIp: request.clientIp });
    expect(verifyCatalogRequest(proof, { ...request, purpose: 'release' }, secret, now)).toBeNull();
    expect(verifyCatalogRequest(proof, { ...request, pathname: '/graphql' }, secret, now)).toBeNull();
    expect(verifyCatalogRequest(proof, { ...request, method: 'GET' }, secret, now)).toBeNull();
    expect(verifyCatalogRequest(proof, { ...request, body: '{}' }, secret, now)).toBeNull();
    expect(verifyCatalogRequest(proof, request, 'different-secret', now)).toBeNull();
  });

  it('refuses expired, future, oversized and malformed proofs', () => {
    const proof = signCatalogRequest(request, secret, now);
    expect(verifyCatalogRequest(proof, request, secret, now + 65_000)).toBeNull();
    expect(verifyCatalogRequest(proof, request, secret, now - 5001)).toBeNull();
    expect(verifyCatalogRequest('x'.repeat(2049), request, secret, now)).toBeNull();
    expect(verifyCatalogRequest('invalid.signature', request, secret, now)).toBeNull();
    expect(verifyCatalogRequest(proof, request, undefined, now)).toBeNull();
    expect(verifyCatalogRequest(null, request, secret, now)).toBeNull();
  });

  it('does not accept a proof with changed visitor attribution', () => {
    const proof = signCatalogRequest(request, secret, now);
    const [payload, signature] = proof.split('.');
    const changed = Buffer.from(
      Buffer.from(payload, 'base64url').toString('utf8').replace(request.clientIp, '203.0.113.99'),
    ).toString('base64url');
    expect(verifyCatalogRequest(`${changed}.${signature}`, request, secret, now)).toBeNull();
  });
});
