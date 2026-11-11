import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { getToken } from 'next-auth/jwt';
import { admitPresentedWebCredential, CredentialAuthorityUnavailable } from './credential-admission.server';
import { capturePresentedWebCredential } from './admitted-session.server';
import { CREDENTIAL_AUTHORITY_HEADER, unavailableCredentialResponse } from './credential-admission-response.server';
import { isSecureCookieContext, sessionCookieNameCandidates } from './secure-cookies';

type AuthRouteContext = { params: Promise<{ nextauth: string[] }> };

function deniedAuthResponse(action: string): Response {
  return NextResponse.json(action === 'session' ? {} : { error: 'Authentication required' }, {
    status: action === 'session' ? 200 : 401,
    headers: { 'Cache-Control': 'private, no-store', [CREDENTIAL_AUTHORITY_HEADER]: 'denied' },
  });
}

/** Reconstruct the handler's fresh cookies with the public NextAuth codec. */
async function emittedCredentials(response: Response, requestUrl: string): Promise<string[]> {
  const nonemptyChunks = new Map<string, string>();
  const families = sessionCookieNameCandidates();
  for (const header of response.headers.getSetCookie()) {
    const pair = header.split(';', 1)[0] ?? '';
    const separator = pair.indexOf('=');
    if (separator < 0) continue;
    const name = pair.slice(0, separator).trim();
    if (!families.some((family) => name === family || name.startsWith(`${family}.`))) continue;
    const content = pair.slice(separator + 1).trim();
    // Host-only migration clears may follow a new Domain-scoped cookie of the
    // same name. Keep fresh values separately instead of overwriting with ''.
    if (!content) continue;
    if (nonemptyChunks.has(name) && nonemptyChunks.get(name) !== content) throw new CredentialAuthorityUnavailable();
    nonemptyChunks.set(name, content);
  }
  const credentials: string[] = [];
  for (const family of families) {
    const chunks = [...nonemptyChunks].filter(([name]) => name === family || name.startsWith(`${family}.`));
    if (chunks.length === 0) continue;
    const cookieHeader = chunks.map(([name, content]) => `${name}=${content}`).join('; ');
    const credential = await getToken({
      req: new NextRequest(requestUrl, { headers: { cookie: cookieHeader } }),
      cookieName: family,
      secureCookie: isSecureCookieContext(),
      secret: process.env.NEXTAUTH_SECRET,
      raw: true,
    });
    if (typeof credential !== 'string' || !credential.trim()) throw new CredentialAuthorityUnavailable();
    credentials.push(credential);
  }
  return credentials;
}

/**
 * Keep all NextAuth headers buffered until the exact emitted identity is freshly
 * admitted. A denied or uncertain A result publishes no cookie writes or clears.
 * This does not make browser Set-Cookie conditional on later account switches.
 */
export async function withAuthResponseAdmission(
  request: NextRequest,
  context: AuthRouteContext,
  invoke: () => Promise<Response>,
): Promise<Response> {
  const [action] = (await context.params).nextauth;
  // Clearing a cookie needs no proof the account still exists, so an outage must
  // not stop a climber signing out. A known denial still answers as before.
  const isDenied = async (credential: string): Promise<boolean> => {
    try {
      return !(await admitPresentedWebCredential(credential));
    } catch (error) {
      if (action === 'signout' && error instanceof CredentialAuthorityUnavailable) return false;
      throw error;
    }
  };
  try {
    const captured = await capturePresentedWebCredential(request);
    if (captured && (action === 'session' || action === 'signout')) {
      if (await isDenied(captured.credential)) return deniedAuthResponse(action);
    }

    const response = await invoke();
    const produced = await emittedCredentials(response, request.url);
    if (produced.length > 0) {
      let admittedUserId: string | undefined;
      for (const credential of produced) {
        const userId = await admitPresentedWebCredential(credential);
        if (!userId) return deniedAuthResponse(action);
        if (admittedUserId !== undefined && admittedUserId !== userId) throw new CredentialAuthorityUnavailable();
        admittedUserId = userId;
      }
    } else if (captured && action !== 'signin' && action !== 'csrf' && action !== 'providers') {
      // Sign-out and negative renewal must recheck at the publication boundary,
      // including deletion committed while the real handler was running.
      if (await isDenied(captured.credential)) return deniedAuthResponse(action);
    }
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  } catch (error) {
    if (error instanceof CredentialAuthorityUnavailable) return unavailableCredentialResponse();
    throw error;
  }
}
