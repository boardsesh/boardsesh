import 'server-only';
import { cache } from 'react';
import { cookies } from 'next/headers';
import { getServerSession } from 'next-auth/next';
import { getToken } from 'next-auth/jwt';
import { NextRequest } from 'next/server';
import { BROWSER_SESSION_MODE_ENV } from '@boardsesh/auth-protocol/browser-session-mode';
import { admitPresentedWebCredential, CredentialAuthorityUnavailable } from './credential-admission.server';
import { isSecureCookieContext, sessionCookieNameCandidates } from './secure-cookies';

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

/**
 * Who reads the session: by default the browser's session as the mode resolves
 * it. `legacyCookie` reads the admitted legacy NextAuth cookie in every mode:
 * only for the native transfer callback, which runs right after a provider
 * login that wrote that cookie (and, under `better-auth`, cleared the
 * first-party names), and needs its claims (B4c moves it).
 */
export type AdmittedSessionSource = { readonly legacyCookie?: boolean };

/**
 * Under `AUTH_BROWSER_SESSION_MODE=better-auth` (#7596 B4a) the render's one
 * resolution, from `server-browser-session.server.ts`; undefined in `legacy`
 * mode or when asked for the legacy cookie. Loaded on first use, so `legacy`
 * mode loads and runs exactly what it did before.
 */
async function resolvedForRender(source: AdmittedSessionSource) {
  if (source.legacyCookie) return { render: undefined, module: undefined };
  // Unset, empty and `legacy` are `legacy` to `browserSessionRouteMode` as
  // well; any other value goes there and gets its answer (503 when invalid).
  const rawMode = process.env[BROWSER_SESSION_MODE_ENV];
  if (rawMode === undefined || rawMode === '' || rawMode === 'legacy') return { render: undefined, module: undefined };
  const module = await import('./server-browser-session.server');
  return { render: await module.serverBrowserSessionForRender(), module };
}

async function getLegacyAdmittedRawServerToken(): Promise<string | undefined> {
  return (await admitServerCredentialForRender())?.presented.credential;
}

/**
 * The credential a server render forwards to the backend as a bearer. In
 * `legacy` mode the admitted NextAuth cookie, as before. Under `better-auth`
 * the backend's 15-minute access token for the session this render shows, or
 * the admitted legacy cookie when the session read would answer from it too.
 * Never sets or clears a cookie.
 */
export async function getAdmittedRawServerToken(source: AdmittedSessionSource = {}): Promise<string | undefined> {
  const { render, module } = await resolvedForRender(source);
  if (!render || !module) return getLegacyAdmittedRawServerToken();
  if (render.kind === 'legacy') return getLegacyAdmittedRawServerToken();
  if (render.kind === 'signed-out') return undefined;
  return module.serverAccessTokenForRender();
}

/** Never mint a session or silently turn an authority outage into anonymity. */
export async function getAdmittedServerSession(source: AdmittedSessionSource = {}) {
  const { render, module } = await resolvedForRender(source);
  if (render && module && render.kind !== 'legacy')
    return render.kind === 'active' ? module.sessionFromActive(render.session) : null;
  return getLegacyAdmittedServerSession();
}

async function getLegacyAdmittedServerSession() {
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
