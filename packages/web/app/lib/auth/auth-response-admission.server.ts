import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { getToken } from 'next-auth/jwt';
import { admitPresentedWebCredential, CredentialAuthorityUnavailable } from './credential-admission.server';
import { capturePresentedWebCredential } from './admitted-session.server';
import { CREDENTIAL_AUTHORITY_HEADER, unavailableCredentialResponse } from './credential-admission-response.server';
import { isSecureCookieContext, sessionCookieNameCandidates } from './secure-cookies';
import { responseClearsNextAuthSession } from './web-signout-command.server';
import { browserConsumerFacade, publicBrowserLeaseOwner } from './browser-consumers.server';
import { BROWSER_CORRELATION_COOKIE, BROWSER_PROOF_COOKIE_PREFIX } from './browser-proof-cookies.server';
import { sameBrowserBackendLeaseOwner } from '@boardsesh/auth-protocol/browser-backend-lease';

type AuthRouteContext = { params: Promise<{ nextauth: string[] }> };

/** Trusted request-local acknowledgment; never supplied through an HTTP header. */
export type SignOutCompletion = (response: Response, credential: string) => void;
/** Trusted request-local receipt after all ordinary admission checks finish. */
export type AuthResponseAdmissionCompletion = (response: Response) => void;
/** Trusted request-local source-free OAuth scope. Its completion acknowledges
 * only a repeated anonymous primary read, never an authenticated actor. */
export interface AnonymousProviderResponseAdmission {
  readonly cursor: Readonly<{ bindingId: string; version: number; bindingExpiresAt: string }>;
  readonly complete: AuthResponseAdmissionCompletion;
}

function deniedAuthResponse(action: string): Response {
  return NextResponse.json(action === 'session' ? {} : { error: 'Authentication required' }, {
    status: action === 'session' ? 200 : 401,
    headers: { 'Cache-Control': 'private, no-store', [CREDENTIAL_AUTHORITY_HEADER]: 'denied' },
  });
}

function selectedRefusal(status: string): Response {
  const code = status === 'unavailable' ? 503 : status === 'conflict' ? 409 : 401;
  return NextResponse.json(
    { error: status },
    {
      status: code,
      headers: {
        'Cache-Control': 'private, no-store',
        [CREDENTIAL_AUTHORITY_HEADER]: status === 'unavailable' ? 'unavailable' : 'denied',
      },
    },
  );
}
function containsAuthCookieWrite(response: Response): boolean {
  return response.headers.getSetCookie().some((header) => {
    const name = header.split(';', 1)[0].split('=', 1)[0].trim();
    return (
      name.startsWith(BROWSER_CORRELATION_COOKIE) ||
      name.startsWith(BROWSER_PROOF_COOKIE_PREFIX) ||
      sessionCookieNameCandidates().some((base) => name.startsWith(base))
    );
  });
}

/** Public selected readers stay gated. No old cookie, claimed response identity
 * or skipped legacy read substitutes for actual current central possession. */
async function selectedResponseAdmission(
  request: NextRequest,
  action: string,
  invoke: (completeSignOut: SignOutCompletion) => Promise<Response>,
  completeAdmission?: AuthResponseAdmissionCompletion,
  anonymousProvider?: AnonymousProviderResponseAdmission,
): Promise<Response | null> {
  try {
    const cookieHeader = request.headers.get('cookie');
    const before = await browserConsumerFacade.observe(cookieHeader);
    if (before.status === 'legacy') return anonymousProvider ? selectedRefusal('unavailable') : null;
    if (before.status !== 'admitted' && before.status !== 'anonymous') return selectedRefusal(before.status);
    if (
      anonymousProvider &&
      (before.status !== 'anonymous' ||
        before.cursor.bindingId !== anonymousProvider.cursor.bindingId ||
        before.cursor.version !== anonymousProvider.cursor.version ||
        before.cursor.bindingExpiresAt !== anonymousProvider.cursor.bindingExpiresAt ||
        !((action === 'signin' && request.method === 'POST') || (action === 'callback' && request.method === 'GET')) ||
        !/^\/api\/auth\/(?:signin|callback)\/(?:google|apple)$/.test(request.nextUrl.pathname))
    )
      return selectedRefusal('conflict');
    // A durable selected logout needs its separately qualified exact-response
    // backend ACK. The legacy sign-out acknowledgment cannot stand in for it.
    if (
      action === 'signout' ||
      (before.status === 'anonymous' && !anonymousProvider && !['session', 'csrf', 'providers'].includes(action))
    )
      return selectedRefusal('unavailable');
    const response =
      action === 'session'
        ? Response.json(before.status === 'admitted' ? browserConsumerFacade.session(before) : {}, {
            headers: { 'Cache-Control': 'private, no-store' },
          })
        : await invoke(() => {
            throw new CredentialAuthorityUnavailable();
          });
    // Only the outer, prebuilt and ACK-bound publisher may install auth proof.
    if (containsAuthCookieWrite(response)) return selectedRefusal('unavailable');
    const after = await browserConsumerFacade.observe(cookieHeader);
    if (after.status === 'unavailable') return selectedRefusal('unavailable');
    if (before.status === 'admitted') {
      if (after.status !== 'admitted') return selectedRefusal(after.status === 'conflict' ? 'conflict' : 'denied');
      if (
        !sameBrowserBackendLeaseOwner(publicBrowserLeaseOwner(before), publicBrowserLeaseOwner(after)) ||
        before.actor.credential.kind !== after.actor.credential.kind
      )
        return selectedRefusal('conflict');
      response.headers.set('Cache-Control', 'private, no-store');
      completeAdmission?.(response);
    } else {
      if (
        after.status !== 'anonymous' ||
        before.cursor.bindingId !== after.cursor.bindingId ||
        before.cursor.version !== after.cursor.version ||
        before.cursor.bindingExpiresAt !== after.cursor.bindingExpiresAt
      )
        return selectedRefusal('conflict');
      response.headers.set('Cache-Control', 'private, no-store');
      // Anonymous observation is never an authenticated provider actor ACK.
      anonymousProvider?.complete(response);
    }
    return response;
  } catch {
    return selectedRefusal('unavailable');
  }
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
  invoke: (completeSignOut: SignOutCompletion) => Promise<Response>,
  completeAdmission?: AuthResponseAdmissionCompletion,
  anonymousProvider?: AnonymousProviderResponseAdmission,
): Promise<Response> {
  const [action] = (await context.params).nextauth;
  const selected = await selectedResponseAdmission(request, action, invoke, completeAdmission, anonymousProvider);
  if (selected) return selected;
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

    let acknowledgedSignOutResponse: Response | undefined;
    const response = await invoke((completedResponse, credential) => {
      if (
        action !== 'signout' ||
        !captured ||
        credential !== captured.credential ||
        !responseClearsNextAuthSession(completedResponse)
      )
        throw new CredentialAuthorityUnavailable();
      acknowledgedSignOutResponse = completedResponse;
    });
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
      // An acknowledged denial necessarily makes this same credential fail its
      // next admission read. Publish that exact sign-out's clears after ACK;
      // every unacknowledged response retains the final deletion/revocation guard.
      const completedOwnSignOut =
        action === 'signout' && acknowledgedSignOutResponse === response && responseClearsNextAuthSession(response);
      if (!completedOwnSignOut && (await isDenied(captured.credential))) return deniedAuthResponse(action);
    }
    response.headers.set('Cache-Control', 'private, no-store');
    completeAdmission?.(response);
    return response;
  } catch (error) {
    if (error instanceof CredentialAuthorityUnavailable) return unavailableCredentialResponse();
    throw error;
  }
}
