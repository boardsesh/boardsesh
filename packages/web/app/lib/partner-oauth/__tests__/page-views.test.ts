import { describe, expect, it } from 'vite-plus/test';
import { JUST_SIGNED_IN_WINDOW_MS, decidePartnerConsent, decidePartnerSignIn } from '../page-views';

const NOW_MS = 1_700_000_100_000;

function signedSearch(extra: Record<string, string> = {}): URLSearchParams {
  const parameters = new URLSearchParams({
    response_type: 'code',
    client_id: 'bsk_sequence',
    redirect_uri: 'https://sequence.example/callback',
    scope: 'profile:read',
    state: 'app-state',
    exp: '1700000600',
  });
  for (const name of [...parameters.keys(), 'ba_param'].sort()) parameters.append('ba_param', name);
  parameters.set('sig', 'signature-value');
  for (const [name, value] of Object.entries(extra)) parameters.set(name, value);
  return parameters;
}

const FRESH_SESSION = {
  account: 'climber@example.com',
  recentGuardedSignIn: true,
  signedInAtMs: NOW_MS - 30_000,
};

describe('decidePartnerSignIn', () => {
  it('shows nothing to sign in to while partner OAuth is off on the web', () => {
    expect(decidePartnerSignIn({ mode: 'off', search: signedSearch(), session: null, nowMs: NOW_MS })).toEqual({
      kind: 'unavailable',
    });
  });

  it('refuses a query the backend did not sign', () => {
    expect(
      decidePartnerSignIn({
        mode: 'allowlist',
        search: new URLSearchParams({ client_id: 'bsk_sequence' }),
        session: null,
        nowMs: NOW_MS,
      }),
    ).toEqual({ kind: 'invalid' });
  });

  it('asks a signed-out climber to sign in, returning here with the marker', () => {
    const view = decidePartnerSignIn({ mode: 'allowlist', search: signedSearch(), session: null, nowMs: NOW_MS });
    if (view.kind !== 'sign-in') throw new Error('expected the form');
    expect(view.reason).toBe('signed-out');
    expect(view.account).toBeNull();
    const returnQuery = new URLSearchParams(view.returnPath.split('?')[1]);
    expect(view.returnPath.startsWith('/oauth/sign-in?')).toBe(true);
    expect(returnQuery.get('boardsesh_signed_in')).toBe('1');
    expect(returnQuery.get('sig')).toBe('signature-value');
    const signOut = new URL(view.signOutPath, 'https://www.boardsesh.com');
    expect(signOut.pathname).toBe('/auth/signout');
    expect(signOut.searchParams.get('callbackUrl')?.startsWith('/oauth/sign-in?')).toBe(true);
    expect(signOut.searchParams.get('callbackUrl')).not.toContain('boardsesh_signed_in');
  });

  it('forwards to authorize once a sign-in this page started has come back', () => {
    const decision = decidePartnerSignIn({
      mode: 'allowlist',
      search: signedSearch({ boardsesh_signed_in: '1' }),
      session: FRESH_SESSION,
      nowMs: NOW_MS,
    });
    if (decision.kind !== 'forward') throw new Error('expected a forward');
    const url = new URL(decision.url);
    expect(url.origin + url.pathname).toBe('https://api.boardsesh.com/api/auth/oauth2/authorize');
    expect(url.searchParams.has('boardsesh_signed_in')).toBe(false);
    expect(url.searchParams.has('sig')).toBe(false);
    expect(url.searchParams.get('state')).toBe('app-state');
  });

  it('never forwards without the marker, so a refused session cannot bounce between hosts', () => {
    const view = decidePartnerSignIn({
      mode: 'allowlist',
      search: signedSearch(),
      session: FRESH_SESSION,
      nowMs: NOW_MS,
    });
    expect(view.kind).toBe('sign-in');
  });

  it('explains a fresh sign-in the backend still refused as the minute after a password change', () => {
    const view = decidePartnerSignIn({
      mode: 'allowlist',
      search: signedSearch(),
      session: FRESH_SESSION,
      nowMs: NOW_MS,
    });
    if (view.kind !== 'sign-in') throw new Error('expected the form');
    expect(view.reason).toBe('just-signed-in');
    expect(view.account).toBe('climber@example.com');
  });

  it.each([
    ['without auth_time or link_guarded (switch-on day)', { recentGuardedSignIn: false, signedInAtMs: null }],
    [
      'older than the just-signed-in window',
      { recentGuardedSignIn: true, signedInAtMs: NOW_MS - JUST_SIGNED_IN_WINDOW_MS },
    ],
    ['fresh but unguarded', { recentGuardedSignIn: false, signedInAtMs: NOW_MS - 1_000 }],
  ])('asks a climber signed in %s to sign in again', (_label, overrides) => {
    const view = decidePartnerSignIn({
      mode: 'open',
      search: signedSearch(),
      session: { ...FRESH_SESSION, ...overrides },
      nowMs: NOW_MS,
    });
    if (view.kind !== 'sign-in') throw new Error('expected the form');
    expect(view.reason).toBe('stale');
  });

  it('passes on a word-shaped NextAuth error code and drops anything else', () => {
    const withCode = decidePartnerSignIn({
      mode: 'allowlist',
      search: signedSearch({ error: 'OAuthAccountNotLinked' }),
      session: null,
      nowMs: NOW_MS,
    });
    const withJunk = decidePartnerSignIn({
      mode: 'allowlist',
      search: signedSearch({ error: '<script>' }),
      session: null,
      nowMs: NOW_MS,
    });
    expect(withCode.kind === 'sign-in' && withCode.errorCode).toBe('OAuthAccountNotLinked');
    expect(withJunk.kind === 'sign-in' && withJunk.errorCode).toBeNull();
  });
});

describe('decidePartnerConsent', () => {
  it('reports partner OAuth off, an unsigned link and an expired one before asking the backend', () => {
    const input = { search: signedSearch(), session: FRESH_SESSION, nowMs: NOW_MS };
    expect(decidePartnerConsent({ ...input, mode: 'off' })).toEqual({ kind: 'unavailable' });
    expect(decidePartnerConsent({ ...input, mode: 'allowlist', search: new URLSearchParams() })).toEqual({
      kind: 'invalid',
    });
    expect(decidePartnerConsent({ ...input, mode: 'allowlist', nowMs: 1_700_000_600_000 })).toEqual({
      kind: 'expired',
    });
  });

  it('sends a climber with no session back through sign-in for the same request', () => {
    const view = decidePartnerConsent({ mode: 'allowlist', search: signedSearch(), session: null, nowMs: NOW_MS });
    if (view.kind !== 'sign-in-again') throw new Error('expected sign-in-again');
    expect(view.signInPath.startsWith('/oauth/sign-in?')).toBe(true);
    expect(new URLSearchParams(view.signInPath.split('?')[1]).get('client_id')).toBe('bsk_sequence');
  });

  it('hands the signed query to the browser for a signed-in climber', () => {
    const view = decidePartnerConsent({
      mode: 'allowlist',
      search: signedSearch({ stray: 'value' }),
      session: { ...FRESH_SESSION, recentGuardedSignIn: false },
      nowMs: NOW_MS,
    });
    if (view.kind !== 'consent') throw new Error('expected consent');
    expect(view.account).toBe('climber@example.com');
    expect(new URLSearchParams(view.signedQuery).has('stray')).toBe(false);
    expect(new URLSearchParams(view.signedQuery).get('sig')).toBe('signature-value');
  });
});
