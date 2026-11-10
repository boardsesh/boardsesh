// @vitest-environment node
import { describe, expect, it } from 'vite-plus/test';
import { NextRequest } from 'next/server';
import { partnerSignInReturnPath, withPartnerSignInFailureReturn } from '../sign-in-failure-return';

const PARTNER_RETURN = '/oauth/sign-in?client_id=bsk_sequence&state=app-state&sig=signed&boardsesh_signed_in=1';
/** A partner request from earlier in the browser session, kept by "Not you? Sign out". */
const STALE_PARTNER = '/oauth/sign-in?client_id=bsk_old_app&state=old-state&sig=old';
const NATIVE_CALLBACK = '/api/auth/native/callback?attemptId=0123456789abcdef0123456789abcdef';
const SCOPE = 'a'.repeat(32);
const OTHER_SCOPE = 'b'.repeat(32);

function redirect(location: string, setCookies: string[] = []): Response {
  const headers = new Headers({ Location: location });
  headers.append('Set-Cookie', 'next-auth.state=; Path=/; Max-Age=0');
  for (const setCookie of setCookies) headers.append('Set-Cookie', setCookie);
  return new Response(null, { status: 302, headers });
}

function request(path: string, cookies: Record<string, string> = {}, method = 'GET'): NextRequest {
  const cookie = Object.entries(cookies)
    .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
    .join('; ');
  return new NextRequest(`https://www.boardsesh.com${path}`, { method, headers: cookie ? { cookie } : {} });
}

const retire = (name: string) => `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`;
const write = (name: string, value: string) => `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax`;

describe('partnerSignInReturnPath', () => {
  it.each([PARTNER_RETURN, `https://www.boardsesh.com${PARTNER_RETURN}`, '/es/oauth/sign-in?client_id=bsk_sequence'])(
    'accepts the partner sign-in page at %s',
    (candidate) => {
      expect(partnerSignInReturnPath(candidate)).not.toBeNull();
    },
  );

  it.each([
    '/auth/login',
    '/oauth/consent?client_id=bsk_sequence',
    '/oauth/sign-in/../../auth/login',
    'javascript:alert(1)//oauth/sign-in',
    '/xx/oauth/sign-in',
    '/oauth/sign-in#fragment',
    null,
  ])('refuses %s', (candidate) => {
    expect(partnerSignInReturnPath(candidate)).toBeNull();
  });
});

describe('withPartnerSignInFailureReturn, legacy flows', () => {
  it('sends a failed callback of a partner sign-in straight back to the partner page', async () => {
    const response = await withPartnerSignInFailureReturn(
      request('/api/auth/callback/google?code=x&state=y', {
        'next-auth.callback-url': `http://localhost:3000${PARTNER_RETURN}`,
      }),
      redirect('http://localhost:3000/api/auth/error?error=OAuthAccountNotLinked'),
    );
    const location = response.headers.get('Location') ?? '';
    expect(location.startsWith('/oauth/sign-in?')).toBe(true);
    const query = new URLSearchParams(location.split('?')[1]);
    expect(query.get('error')).toBe('OAuthAccountNotLinked');
    expect(query.get('boardsesh_signed_in')).toBeNull();
    expect(query.get('state')).toBe('app-state');
    expect(response.status).toBe(302);
    expect(response.headers.getSetCookie()).toHaveLength(1);
  });

  it('covers pages.error codes outside the sign-in list, and replaces an odd code with the generic one', async () => {
    const response = await withPartnerSignInFailureReturn(
      request(
        '/api/auth/callback/apple',
        { '__Secure-next-auth.callback-url': '/de/oauth/sign-in?client_id=x' },
        'POST',
      ),
      redirect('/auth/error?error=%3Cscript%3E'),
    );
    const location = response.headers.get('Location') ?? '';
    expect(location.startsWith('/de/oauth/sign-in?')).toBe(true);
    expect(new URLSearchParams(location.split('?')[1]).get('error')).toBe('OAuthCallback');
  });

  it('leaves an ordinary failed sign-in alone', async () => {
    const original = redirect('/api/auth/error?error=OAuthCallback');
    const response = await withPartnerSignInFailureReturn(
      request('/api/auth/callback/google', { 'next-auth.callback-url': '/gyms' }),
      original,
    );
    expect(response).toBe(original);
  });

  it('leaves a successful sign-in alone, even when it returns to the partner page', async () => {
    const original = redirect(PARTNER_RETURN);
    const response = await withPartnerSignInFailureReturn(
      request('/api/auth/callback/google', { 'next-auth.callback-url': PARTNER_RETURN }),
      original,
    );
    expect(response).toBe(original);
  });

  it.each(['https://evil.example/oauth/sign-in?client_id=x', '//evil.example/oauth/sign-in?client_id=x'])(
    'never points the redirect at another host, even for %s',
    async (candidate) => {
      const response = await withPartnerSignInFailureReturn(
        request('/api/auth/callback/google', { 'next-auth.callback-url': candidate }),
        redirect('/api/auth/error?error=Callback'),
      );
      // Only the path survives, so the browser stays on this site.
      expect(response.headers.get('Location')).toBe('/oauth/sign-in?client_id=x&error=Callback');
    },
  );

  // Review probe 1: the start response sets the flow's own callback URL.
  it('trusts the callback URL a failed sign-in start sets over a stale partner cookie (phone fallback)', async () => {
    const original = redirect('/api/auth/error?error=OAuthSignin', [write('next-auth.callback-url', NATIVE_CALLBACK)]);
    const response = await withPartnerSignInFailureReturn(
      request('/api/auth/signin/google', { 'next-auth.callback-url': STALE_PARTNER }, 'POST'),
      original,
    );
    expect(response).toBe(original);
  });

  it('sends a failed partner sign-in start back by the URL it sets, as a JSON url too', async () => {
    const original = Response.json(
      { url: 'https://www.boardsesh.com/api/auth/error?error=OAuthSignin' },
      { headers: { 'Set-Cookie': write('next-auth.callback-url', PARTNER_RETURN) } },
    );
    const response = await withPartnerSignInFailureReturn(
      request('/api/auth/signin/google', { 'next-auth.callback-url': '/gyms' }, 'POST'),
      original,
    );
    const body = (await response.json()) as { url: string };
    const url = new URL(body.url);
    expect(url.origin).toBe('https://www.boardsesh.com');
    expect(url.pathname).toBe('/oauth/sign-in');
    expect(url.searchParams.get('error')).toBe('OAuthSignin');
    expect(response.headers.getSetCookie()).toHaveLength(1);
  });

  it('leaves a JSON start that is not an error alone', async () => {
    const original = Response.json({ url: 'https://accounts.google.com/o/oauth2/v2/auth?state=x' });
    const response = await withPartnerSignInFailureReturn(
      request('/api/auth/signin/google', { 'next-auth.callback-url': PARTNER_RETURN }, 'POST'),
      original,
    );
    expect(response).toBe(original);
  });

  it('never rewrites the later error hops, where the base cookie may be stale', async () => {
    for (const [path, location] of [
      ['/api/auth/error?error=OAuthCallback', '/api/auth/signin?error=OAuthCallback'],
      [
        '/api/auth/signin?error=OAuthCallback',
        `/auth/login?callbackUrl=${encodeURIComponent(STALE_PARTNER)}&error=OAuthCallback`,
      ],
    ]) {
      const original = redirect(location);
      const response = await withPartnerSignInFailureReturn(
        request(path, { 'next-auth.callback-url': STALE_PARTNER }),
        original,
      );
      expect(response).toBe(original);
    }
  });
});

describe('withPartnerSignInFailureReturn, flows scoped by backend-staging', () => {
  // Review probe 2: staged flows never write the base cookie.
  it('reads the scoped cookie of the flow the callback retires', async () => {
    const response = await withPartnerSignInFailureReturn(
      request('/api/auth/callback/google?code=x&state=y', {
        [`next-auth.callback-url.${SCOPE}`]: PARTNER_RETURN,
        [`next-auth.callback-url.${OTHER_SCOPE}`]: '/gyms',
      }),
      redirect('/api/auth/error?error=Callback', [
        retire(`next-auth.state.${SCOPE}`),
        retire(`next-auth.callback-url.${SCOPE}`),
      ]),
    );
    const location = response.headers.get('Location') ?? '';
    expect(location.startsWith('/oauth/sign-in?')).toBe(true);
    expect(new URLSearchParams(location.split('?')[1]).get('error')).toBe('Callback');
  });

  // Review probe 3: an ordinary staged failure with a stale partner base cookie.
  it('ignores a stale base cookie when the flow has its own scoped one', async () => {
    const original = redirect('/api/auth/error?error=OAuthCallback', [retire(`next-auth.callback-url.${SCOPE}`)]);
    const response = await withPartnerSignInFailureReturn(
      request('/api/auth/callback/google?code=x&state=y', {
        'next-auth.callback-url': STALE_PARTNER,
        [`next-auth.callback-url.${SCOPE}`]: '/auth/login',
      }),
      original,
    );
    expect(response).toBe(original);
  });

  it('never falls back to the base cookie while scoped flows are pending', async () => {
    const original = redirect('/auth/error?error=AuthBackendUnavailable');
    const response = await withPartnerSignInFailureReturn(
      request('/api/auth/callback/google?code=x&state=y', {
        'next-auth.callback-url': STALE_PARTNER,
        [`next-auth.callback-url.${OTHER_SCOPE}`]: '/gyms',
      }),
      original,
    );
    expect(response).toBe(original);
  });

  it('sends a failed staged partner start back by the scoped cookie it sets', async () => {
    const original = Response.json(
      { url: 'https://www.boardsesh.com/api/auth/error?error=OAuthSignin' },
      { headers: { 'Set-Cookie': write(`__Secure-next-auth.callback-url.${SCOPE}`, PARTNER_RETURN) } },
    );
    const response = await withPartnerSignInFailureReturn(
      request('/api/auth/signin/google', { '__Secure-next-auth.callback-url': '/gyms' }, 'POST'),
      original,
    );
    expect(new URL(((await response.json()) as { url: string }).url).pathname).toBe('/oauth/sign-in');
  });
});
