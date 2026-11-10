// @vitest-environment node
import { describe, expect, it } from 'vite-plus/test';
import { NextRequest } from 'next/server';
import { partnerSignInReturnPath, withPartnerSignInFailureReturn } from '../sign-in-failure-return';

const PARTNER_RETURN = '/oauth/sign-in?client_id=bsk_sequence&state=app-state&sig=signed&boardsesh_signed_in=1';

function redirect(location: string, extraHeaders: Record<string, string> = {}): Response {
  const headers = new Headers({ Location: location, ...extraHeaders });
  headers.append('Set-Cookie', 'next-auth.state=; Path=/; Max-Age=0');
  headers.append('Set-Cookie', 'next-auth.pkce.code_verifier=; Path=/; Max-Age=0');
  return new Response(null, { status: 302, headers });
}

function request(path: string, cookie = ''): NextRequest {
  return new NextRequest(`https://www.boardsesh.com${path}`, { headers: cookie ? { cookie } : {} });
}

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

describe('withPartnerSignInFailureReturn', () => {
  it('sends the /auth/login error landing back to the partner page, by the callbackUrl NextAuth names', () => {
    const response = withPartnerSignInFailureReturn(
      request('/api/auth/signin?error=OAuthAccountNotLinked'),
      redirect(
        `/auth/login?callbackUrl=${encodeURIComponent(`https://www.boardsesh.com${PARTNER_RETURN}`)}&error=OAuthAccountNotLinked`,
      ),
    );
    const location = response.headers.get('Location') ?? '';
    expect(location.startsWith('/oauth/sign-in?')).toBe(true);
    const query = new URLSearchParams(location.split('?')[1]);
    expect(query.get('error')).toBe('OAuthAccountNotLinked');
    expect(query.get('boardsesh_signed_in')).toBeNull();
    expect(query.get('state')).toBe('app-state');
    expect(response.status).toBe(302);
    expect(response.headers.getSetCookie()).toHaveLength(2);
  });

  it('short-cuts the first error hop from the provider callback, using the callback-url cookie', () => {
    const cookie = `next-auth.callback-url=${encodeURIComponent(`http://localhost:3000${PARTNER_RETURN}`)}`;
    const response = withPartnerSignInFailureReturn(
      request('/api/auth/callback/google?code=x&state=y', cookie),
      redirect('http://localhost:3000/api/auth/error?error=Callback'),
    );
    const location = response.headers.get('Location') ?? '';
    expect(location.startsWith('/oauth/sign-in?')).toBe(true);
    expect(new URLSearchParams(location.split('?')[1]).get('error')).toBe('Callback');
  });

  it('covers pages.error codes outside the sign-in list, and replaces an odd code with the generic one', () => {
    const cookie = `__Secure-next-auth.callback-url=${encodeURIComponent('/de/oauth/sign-in?client_id=bsk_sequence')}`;
    const response = withPartnerSignInFailureReturn(
      request('/api/auth/error?error=Configuration', cookie),
      redirect('/auth/error?error=%3Cscript%3E'),
    );
    const location = response.headers.get('Location') ?? '';
    expect(location.startsWith('/de/oauth/sign-in?')).toBe(true);
    expect(new URLSearchParams(location.split('?')[1]).get('error')).toBe('OAuthCallback');
  });

  it('leaves an ordinary /auth/login failure alone', () => {
    const original = redirect('/auth/login?callbackUrl=%2Fgyms&error=OAuthCallback');
    expect(withPartnerSignInFailureReturn(request('/api/auth/signin?error=OAuthCallback'), original)).toBe(original);
  });

  it('leaves a successful sign-in alone, even when it returns to the partner page', () => {
    const original = redirect(PARTNER_RETURN);
    const cookie = `next-auth.callback-url=${encodeURIComponent(PARTNER_RETURN)}`;
    expect(withPartnerSignInFailureReturn(request('/api/auth/callback/google', cookie), original)).toBe(original);
  });

  it.each(['https://evil.example/oauth/sign-in?client_id=x', '//evil.example/oauth/sign-in?client_id=x'])(
    'never points the redirect at another host, even for %s',
    (candidate) => {
      const cookie = `next-auth.callback-url=${encodeURIComponent(candidate)}`;
      const response = withPartnerSignInFailureReturn(
        request('/api/auth/error?error=Callback', cookie),
        redirect('/auth/error?error=Callback'),
      );
      // Only the path survives, so the browser stays on this site.
      expect(response.headers.get('Location')).toBe('/oauth/sign-in?client_id=x&error=Callback');
    },
  );

  it('leaves JSON answers alone', () => {
    const original = Response.json({ url: '/api/auth/error?error=OAuthSignin' });
    expect(withPartnerSignInFailureReturn(request('/api/auth/signin/google'), original)).toBe(original);
  });
});
