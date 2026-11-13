import 'server-only';
import { cache } from 'react';
import { cookies } from 'next/headers';
import { getServerSession } from 'next-auth/next';
import { getToken } from 'next-auth/jwt';
import { NextRequest } from 'next/server';
import { admitPresentedWebCredential, CredentialAuthorityUnavailable } from './credential-admission.server';
import { isSecureCookieContext, sessionCookieNameCandidates } from './secure-cookies';
import { browserConsumerFacade } from './browser-consumers.server';

export type PresentedWebCredential = Readonly<{ credential: string; cookieName: string }>;

/** Public NextAuth cookie reconstruction, including its numbered chunks. */
export async function capturePresentedWebCredential(request: NextRequest): Promise<PresentedWebCredential | null> {
  // Cookie readers must not accidentally fall back to a different Bearer
  // credential on the same request. The backend admits the captured bytes.
  const cookieRequest = new NextRequest(request.url, {
    headers: { cookie: request.headers.get('cookie') ?? '' },
  });
  try {
    for (const cookieName of sessionCookieNameCandidates()) {
      const credential = await getToken({
        req: cookieRequest,
        cookieName,
        secureCookie: isSecureCookieContext(),
        secret: process.env.NEXTAUTH_SECRET,
        raw: true,
      });
      if (typeof credential === 'string' && credential.trim()) return Object.freeze({ credential, cookieName });
    }
    return null;
  } catch {
    throw new CredentialAuthorityUnavailable();
  }
}

const serverCookieHeaderForRender = cache(async (): Promise<string> => {
  const cookieStore = await cookies();
  return cookieStore
    .getAll()
    .map((cookie) => `${cookie.name}=${encodeURIComponent(cookie.value)}`)
    .join('; ');
});
const selectedBrowserForRender = cache(async () => browserConsumerFacade.observe(await serverCookieHeaderForRender()));
const selectedBackendLeaseForRender = cache(async () => {
  const observed = await selectedBrowserForRender();
  return observed.status === 'admitted' ? browserConsumerFacade.lease(observed) : null;
});

async function captureServerCredential(): Promise<PresentedWebCredential | null> {
  const cookieHeader = await serverCookieHeaderForRender();
  return capturePresentedWebCredential(
    new NextRequest('http://session-reader.invalid/api/auth/session', { headers: { cookie: cookieHeader } }),
  );
}

/**
 * One admission per server render. A profile page asks for the token about 15
 * times, and every forwarded request is checked again when it reaches the
 * backend. React scopes this to one render, so nothing is shared between requests.
 */
const admitServerCredentialForRender = cache(async () => {
  const presented = await captureServerCredential();
  if (!presented) return null;
  const userId = await admitPresentedWebCredential(presented.credential);
  return userId ? { presented, userId } : null;
});

export async function getAdmittedRawServerToken(): Promise<string | undefined> {
  const selected = await selectedBrowserForRender();
  if (selected.status !== 'legacy') {
    if (selected.status === 'unavailable' || selected.status === 'conflict') throw new CredentialAuthorityUnavailable();
    if (selected.status !== 'admitted') return undefined;
    const lease = await selectedBackendLeaseForRender();
    if (lease?.status === 'unavailable' || lease?.status === 'conflict') throw new CredentialAuthorityUnavailable();
    return lease?.status === 'admitted' ? lease.token : undefined;
  }
  return (await admitServerCredentialForRender())?.presented.credential;
}

/** Never mint a session or silently turn an authority outage into anonymity. */
export async function getAdmittedServerSession() {
  const selected = await selectedBrowserForRender();
  if (selected.status !== 'legacy') {
    if (selected.status === 'unavailable' || selected.status === 'conflict') throw new CredentialAuthorityUnavailable();
    if (selected.status !== 'admitted') return null;
    try {
      return browserConsumerFacade.session(selected);
    } catch {
      throw new CredentialAuthorityUnavailable();
    }
  }
  const admitted = await admitServerCredentialForRender();
  if (!admitted) return null;
  const { presented, userId } = admitted;

  const { authOptions } = await import('./auth-options');
  // Read the same selected name that was admitted; preserve request-local
  // options rather than changing shared authOptions for concurrent requests.
  const session = await getServerSession({
    ...authOptions,
    cookies: {
      ...authOptions.cookies,
      sessionToken: {
        name: presented.cookieName,
        options: authOptions.cookies?.sessionToken?.options ?? {},
      },
    },
  });
  if (!session) return null;
  if (session.user?.id !== userId) throw new CredentialAuthorityUnavailable();
  // A deletion that completed while the local session callback ran must not
  // turn that callback's result into a newly admitted private viewer.
  if (!(await admitPresentedWebCredential(presented.credential))) return null;
  return session;
}
