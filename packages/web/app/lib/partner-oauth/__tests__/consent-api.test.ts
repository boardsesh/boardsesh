import { describe, expect, it, vi } from 'vite-plus/test';
import { PARTNER_CONSENT_ERRORS } from '@boardsesh/auth-protocol/partner-oauth';
import {
  classifyConsentRefusal,
  fetchConsentDetails,
  readConsentRedirect,
  safeAppLink,
  sendConsentDecision,
} from '../consent-api';

const DETAILS = {
  client: {
    clientId: 'bsk_sequence',
    name: 'Sequence',
    homepageUrl: 'https://sequence.example',
    privacyPolicyUrl: 'https://sequence.example/privacy',
    termsUrl: null,
    redirectHost: 'com.example.app',
  },
  scopes: [{ scope: 'profile:read', includesOnlyMeTicks: false }],
  reconnect: false,
  reviewed: false,
  expiresAt: '2026-11-10T12:10:00.000Z',
};

/** The JSON a request posted. Every consent call sends a string body. */
function postedJson(init: RequestInit): Record<string, unknown> {
  if (typeof init.body !== 'string') throw new Error('expected a JSON string body');
  return JSON.parse(init.body) as Record<string, unknown>;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('fetchConsentDetails', () => {
  it('posts the signed query with the session cookie and no Referer', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, DETAILS));
    await fetchConsentDetails('client_id=bsk_sequence&sig=abc', fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.boardsesh.com/api/auth/oauth2/consent-details');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    expect(init.referrerPolicy).toBe('no-referrer');
    expect(postedJson(init)).toEqual({ oauth_query: 'client_id=bsk_sequence&sig=abc' });
  });

  it('reads the app details the screen shows', async () => {
    const outcome = await fetchConsentDetails('q', async () => jsonResponse(200, DETAILS));
    if (outcome.kind !== 'ready') throw new Error('expected details');
    expect(outcome.details.client.name).toBe('Sequence');
    expect(outcome.details.client.redirectHost).toBe('com.example.app');
  });

  it('treats a body it cannot read as a failure', async () => {
    expect(await fetchConsentDetails('q', async () => jsonResponse(200, { client: {} }))).toEqual({
      kind: 'problem',
      problem: 'failed',
    });
  });

  it('treats a network error as a failure', async () => {
    const outcome = await fetchConsentDetails('q', async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(outcome).toEqual({ kind: 'problem', problem: 'failed' });
  });
});

describe('classifyConsentRefusal', () => {
  it.each([
    [401, { error: PARTNER_CONSENT_ERRORS.loginRequired, error_description: 'any text' }, 'sign-in-again'],
    [400, { error: PARTNER_CONSENT_ERRORS.linkSpent, error_description: 'any text' }, 'expired'],
    [400, { error: 'invalid_signature' }, 'expired'],
    [403, { error: PARTNER_CONSENT_ERRORS.appSuspended, error_description: 'any text' }, 'app-unavailable'],
    [403, { error: PARTNER_CONSENT_ERRORS.crossSite, error_description: 'any text' }, 'failed'],
    [403, { error: 'temporarily_unavailable', error_description: 'limit' }, 'app-full'],
    [403, { error: 'access_denied' }, 'app-unavailable'],
    // A code the page does not know, whatever its text says.
    [400, { error: 'invalid_request', error_description: 'This consent link is no longer valid.' }, 'failed'],
    [404, {}, 'unavailable'],
    [429, { error: 'rate_limited' }, 'busy'],
    [503, { error: 'temporarily_unavailable' }, 'busy'],
    [500, { error: 'server_error' }, 'busy'],
  ])('reads %i %j as %s', async (status, body, problem) => {
    expect(await classifyConsentRefusal(jsonResponse(status, body))).toBe(problem);
  });

  it('pins the codes the backend answers with', () => {
    expect(PARTNER_CONSENT_ERRORS).toEqual({
      loginRequired: 'login_required',
      crossSite: 'invalid_request',
      linkSpent: 'link_spent',
      appSuspended: 'app_suspended',
    });
  });

  it('reads a refusal without a JSON body by its status alone', async () => {
    expect(await classifyConsentRefusal(new Response('nope', { status: 400 }))).toBe('failed');
  });
});

describe('readConsentRedirect', () => {
  it('sorts the app redirect by what the app will hear', () => {
    expect(readConsentRedirect('com.example.app:/cb?code=abc&state=s&iss=x', true)?.kind).toBe('connected');
    expect(readConsentRedirect('https://app.example/cb?error=access_denied&state=s', false)?.kind).toBe('declined');
    expect(readConsentRedirect('https://app.example/cb?error=temporarily_unavailable', true)?.kind).toBe('app-full');
    expect(readConsentRedirect('https://app.example/cb?error=access_denied', true)?.kind).toBe('app-not-ready');
    expect(readConsentRedirect('https://app.example/cb?error=invalid_scope', true)?.kind).toBe('app-error');
  });

  it('refuses schemes a browser must never be sent to, and a success with no code', () => {
    expect(readConsentRedirect('javascript:alert(1)//?code=x', true)).toBeNull();
    expect(readConsentRedirect('data:text/html,hi?code=x', true)).toBeNull();
    expect(readConsentRedirect('not a url', true)).toBeNull();
    expect(readConsentRedirect('https://app.example/cb?state=s', true)).toBeNull();
  });
});

describe('sendConsentDecision', () => {
  it('posts the answer and follows the app redirect it gets back', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { redirect: true, url: 'com.example.app:/cb?code=abc&state=s' }),
    );
    const outcome = await sendConsentDecision('client_id=bsk_sequence&sig=abc', true, fetchImpl);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.boardsesh.com/api/auth/oauth2/consent');
    expect(postedJson(init)).toEqual({ accept: true, oauth_query: 'client_id=bsk_sequence&sig=abc' });
    expect(init.credentials).toBe('include');
    expect(outcome).toEqual({
      kind: 'redirect',
      redirect: { kind: 'connected', url: 'com.example.app:/cb?code=abc&state=s' },
    });
  });

  it('turns a spent link into the expired state', async () => {
    const outcome = await sendConsentDecision('q', false, async () =>
      jsonResponse(400, {
        error: PARTNER_CONSENT_ERRORS.linkSpent,
        error_description: 'This consent link is no longer valid.',
      }),
    );
    expect(outcome).toEqual({ kind: 'problem', problem: 'expired' });
  });

  it('refuses to follow an unsafe redirect', async () => {
    const outcome = await sendConsentDecision('q', true, async () =>
      jsonResponse(200, { redirect: true, url: 'javascript:alert(1)' }),
    );
    expect(outcome).toEqual({ kind: 'problem', problem: 'failed' });
  });
});

describe('safeAppLink', () => {
  it('shows only ordinary web links', () => {
    expect(safeAppLink('https://sequence.example/privacy')).toBe('https://sequence.example/privacy');
    expect(safeAppLink('javascript:alert(1)')).toBeNull();
    expect(safeAppLink('mailto:dev@example.com')).toBeNull();
    expect(safeAppLink(null)).toBeNull();
    expect(safeAppLink('nonsense')).toBeNull();
  });
});
