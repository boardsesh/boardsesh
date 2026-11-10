import { describe, expect, it } from 'vite-plus/test';
import {
  MAX_PARTNER_QUERY_LENGTH,
  PARTNER_AUTHORIZE_URL,
  isPartnerRequestExpired,
  partnerAuthorizeUrl,
  partnerSignInPath,
  readPartnerOAuthRequest,
  searchParamsFromRecord,
} from '../authorization-query';

/** A query shaped like Better Auth 1.7.17's `signParams` output. */
function signedSearch(overrides: Record<string, string> = {}): URLSearchParams {
  const parameters = new URLSearchParams({
    response_type: 'code',
    client_id: 'bsk_sequence',
    redirect_uri: 'com.example.app:/oauth/boardsesh',
    scope: 'profile:read offline_access',
    state: 'app-state',
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    code_challenge_method: 'S256',
    resource: 'https://api.boardsesh.com/v1',
    exp: '1700000600',
    ba_iat: '1700000000000',
    ...overrides,
  });
  for (const name of [...new Set(parameters.keys())].concat('ba_param').sort()) parameters.append('ba_param', name);
  parameters.set('sig', 'signature-value');
  return parameters;
}

describe('readPartnerOAuthRequest', () => {
  it('keeps only the signed parameters and the signature', () => {
    const search = signedSearch();
    search.append('boardsesh_signed_in', '1');
    search.append('error', 'OAuthCallback');
    const request = readPartnerOAuthRequest(search);
    expect(request).not.toBeNull();
    const signed = new URLSearchParams(request?.signedQuery);
    expect(signed.get('boardsesh_signed_in')).toBeNull();
    expect(signed.get('error')).toBeNull();
    expect(signed.get('sig')).toBe('signature-value');
    expect(signed.get('client_id')).toBe('bsk_sequence');
    expect(signed.getAll('ba_param')).toContain('client_id');
    expect(request?.clientId).toBe('bsk_sequence');
    expect(request?.expiresAtMs).toBe(1_700_000_600_000);
  });

  it.each([
    ['no signature', (search: URLSearchParams) => search.delete('sig')],
    ['two signatures', (search: URLSearchParams) => search.append('sig', 'another')],
    ['no list of signed names', (search: URLSearchParams) => search.delete('ba_param')],
    ['no app', (search: URLSearchParams) => search.delete('client_id')],
    ['an expiry that is not a number', (search: URLSearchParams) => search.set('exp', 'soon')],
  ])('refuses a query with %s', (_label, change) => {
    const search = signedSearch();
    change(search);
    expect(readPartnerOAuthRequest(search)).toBeNull();
  });

  it('refuses a query longer than any real one', () => {
    expect(readPartnerOAuthRequest(signedSearch({ state: 'x'.repeat(MAX_PARTNER_QUERY_LENGTH) }))).toBeNull();
  });

  it('refuses an empty page query', () => {
    expect(readPartnerOAuthRequest(new URLSearchParams())).toBeNull();
  });
});

describe('isPartnerRequestExpired', () => {
  it('compares the signed expiry with the clock', () => {
    const request = readPartnerOAuthRequest(signedSearch());
    if (!request) throw new Error('expected a request');
    expect(isPartnerRequestExpired(request, 1_700_000_599_000)).toBe(false);
    expect(isPartnerRequestExpired(request, 1_700_000_600_000)).toBe(true);
  });
});

describe('partnerAuthorizeUrl', () => {
  it('starts the request again at authorize, with none of the signing fields', () => {
    const request = readPartnerOAuthRequest(signedSearch({ ba_pl: 'session-id' }));
    if (!request) throw new Error('expected a request');
    const url = new URL(partnerAuthorizeUrl(request));
    expect(`${url.origin}${url.pathname}`).toBe(PARTNER_AUTHORIZE_URL);
    expect(url.origin).toBe('https://api.boardsesh.com');
    for (const name of ['sig', 'exp', 'ba_iat', 'ba_pl', 'ba_param']) expect(url.searchParams.has(name)).toBe(false);
    expect(url.searchParams.get('state')).toBe('app-state');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')).toBe('profile:read offline_access');
  });
});

describe('partnerSignInPath', () => {
  it('names the sign-in page with the signed query and any marker', () => {
    const request = readPartnerOAuthRequest(signedSearch());
    if (!request) throw new Error('expected a request');
    const path = partnerSignInPath(request, { boardsesh_signed_in: '1' });
    expect(path.startsWith('/oauth/sign-in?')).toBe(true);
    const query = new URLSearchParams(path.slice(path.indexOf('?')));
    expect(query.get('boardsesh_signed_in')).toBe('1');
    expect(query.get('sig')).toBe('signature-value');
  });
});

describe('searchParamsFromRecord', () => {
  it('keeps repeated names as repeated parameters', () => {
    const search = searchParamsFromRecord({ ba_param: ['client_id', 'sig'], client_id: 'bsk_app', missing: undefined });
    expect(search.getAll('ba_param')).toEqual(['client_id', 'sig']);
    expect(search.get('client_id')).toBe('bsk_app');
    expect(search.has('missing')).toBe(false);
  });
});
