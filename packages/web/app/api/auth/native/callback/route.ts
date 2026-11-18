import { decode } from 'next-auth/jwt';
import { webCredentialProofMode, webCredentialProofSchema, type WebCredentialProof } from '@boardsesh/auth-protocol';
import { CredentialAuthorityUnavailable } from '@/app/lib/auth/credential-admission.server';
import { NextResponse, type NextRequest } from 'next/server';
import type { Session } from 'next-auth';
import { BROWSER_SESSION_MODE_ENV } from '@boardsesh/auth-protocol/browser-session-mode';
import {
  capturePresentedWebCredential,
  getAdmittedRawServerToken,
  getAdmittedServerSession,
} from '@/app/lib/auth/admitted-session.server';
import { browserSessionRouteMode } from '@/app/lib/auth/browser-session-mode.server';
import {
  issueNativeOAuthTransferToken,
  NATIVE_OAUTH_ATTEMPT_COOKIE,
  verifyNativeOAuthAttempt,
} from '@/app/lib/auth/native-oauth-transfer';
import { NATIVE_OAUTH_CALLBACK_SCHEME } from '@/app/lib/auth/native-oauth-config';

const sanitizeNextPath = (nextPath: string | null): string => (nextPath && nextPath.startsWith('/') ? nextPath : '/');

/**
 * Redirect to a custom URL scheme using an HTML page with JavaScript.
 *
 * iOS SFSafariViewController (used by Capacitor's Browser plugin) does not
 * reliably follow HTTP 302 redirects to custom URL schemes — it shows
 * "Safari cannot open the page because the URL is invalid."
 *
 * An HTML page that triggers the redirect via JavaScript + meta refresh
 * works consistently across iOS and Android.
 */
const escapeHtmlAttr = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const deepLinkRedirect = (url: string) => {
  const response = new NextResponse(
    `<!DOCTYPE html>
<html>
<head>
<meta http-equiv="refresh" content="0;url=${escapeHtmlAttr(url)}">
</head>
<body>
<script>window.location.href=${JSON.stringify(url)};</script>
</body>
</html>`,
    {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    },
  );
  // Attempts expire naturally. A delayed callback must not clear the shared
  // attempt cookie written by a newer native login.
  return response;
};

type CreationProof = NonNullable<Session['nativeOAuthCreationProof']>;

/**
 * The receipt of an account a provider sign-in just created, bound to the
 * app's own attempt (its signed cookie and the query), or nothing.
 */
function verifiedCreationProof(
  request: NextRequest,
  proof: CreationProof | undefined,
  session: { userId: string; authSessionId: string | undefined },
) {
  const attempt = verifyNativeOAuthAttempt(request.cookies.get(NATIVE_OAUTH_ATTEMPT_COOKIE)?.value);
  return attempt &&
    attempt.attemptId === request.nextUrl.searchParams.get('attemptId') &&
    attempt.provider === request.nextUrl.searchParams.get('provider') &&
    proof?.provider === attempt.provider &&
    proof.authSessionId === session.authSessionId &&
    proof.accountCreation.userId === session.userId &&
    proof.signedInAt > attempt.startedAt &&
    proof.signedInAt <= Date.now()
    ? {
        accountCreation: proof.accountCreation,
        authSessionId: proof.authSessionId,
        provider: proof.provider,
        attemptId: attempt.attemptId,
      }
    : {};
}

const transferRedirect = (transferToken: string, nextPath: string) =>
  deepLinkRedirect(
    `${NATIVE_OAUTH_CALLBACK_SCHEME}?transferToken=${encodeURIComponent(transferToken)}&next=${encodeURIComponent(nextPath)}`,
  );

/**
 * Under `AUTH_BROWSER_SESSION_MODE=better-auth` (#7596 B4c-web): the account,
 * its session id, generation, sign-in time and link guard come from the
 * request's canonical session resolution (the one renders use; a legacy-only
 * browser is bridged without a cookie). The legacy NextAuth cookie is read
 * only for the account-creation receipt a provider sign-in puts on its twin,
 * which no session read carries, and only when it names the same login: a
 * legacy cookie of another login (or one that does not decode) refuses. Writes
 * no cookie. A request whose session is known only by its legacy cookie (its
 * bridge over budget or failing) answers `session_unavailable`.
 *
 * Supplying the receipt without the legacy cookie needs a backend change: the
 * web OAuth `resolve` command knows whether it created the account, so it
 * would store the receipt (provider, created-at, sign-in time) with the issued
 * session, and the session read would return it while that sign-in is
 * minutes old.
 */
async function canonicalNativeCallback(request: NextRequest, nextPath: string): Promise<Response> {
  const { serverBrowserSession } = await import('@/app/lib/auth/server-browser-session.server');
  const resolved = await serverBrowserSession({ method: 'GET' });
  if (!resolved || resolved.kind === 'legacy')
    return deepLinkRedirect(`${NATIVE_OAUTH_CALLBACK_SCHEME}?error=session_unavailable`);
  if (resolved.kind === 'signed-out') return deepLinkRedirect(`${NATIVE_OAUTH_CALLBACK_SCHEME}?error=session_missing`);
  const { session } = resolved;
  // Outside the `try`: an authority outage reading the cookie is `session_unavailable` (GET's catch).
  const twin = await capturePresentedWebCredential(request);
  // Only a real login hands the app a sign-in time and a link guard; a carried or
  // bridged session never does, as the 15-minute token drops them (#7802 review M1).
  const realLogin = session.source === 'login';
  let transferToken: string;
  try {
    let creationProof: CreationProof | undefined;
    if (twin) {
      if (!process.env.NEXTAUTH_SECRET) throw new Error('Source credential unavailable');
      const claims = await decode({ token: twin.credential, secret: process.env.NEXTAUTH_SECRET });
      if (claims?.sub !== session.userId || claims.authSessionId !== session.authSessionId)
        throw new Error('Legacy cookie names another login');
      creationProof = claims.nativeOAuthCreationProof;
    }
    const credentialProof = webCredentialProofSchema.parse({
      version: 1,
      userId: session.userId,
      authSessionId: session.authSessionId,
      generation: session.generation,
      authenticatedAt: realLogin ? session.authenticatedAt : null,
      linkGuarded: realLogin && session.linkGuarded,
    });
    transferToken = issueNativeOAuthTransferToken({
      userId: session.userId,
      generation: session.generation,
      nextPath,
      authSessionId: session.authSessionId,
      credentialProof,
      ...verifiedCreationProof(request, creationProof, session),
    });
  } catch {
    return deepLinkRedirect(`${NATIVE_OAUTH_CALLBACK_SCHEME}?error=token_issue_failed`);
  }
  return transferRedirect(transferToken, nextPath);
}

async function nativeCallback(request: NextRequest) {
  const nextPath = sanitizeNextPath(request.nextUrl.searchParams.get('next'));
  const rawMode = process.env[BROWSER_SESSION_MODE_ENV];
  if (rawMode !== undefined && rawMode !== '' && rawMode !== 'legacy') {
    const browserSession = browserSessionRouteMode();
    if (browserSession.kind === 'unavailable') throw new CredentialAuthorityUnavailable();
    if (browserSession.kind === 'better-auth') return canonicalNativeCallback(request, nextPath);
  }
  const session = await getAdmittedServerSession();
  if (!session?.user?.id) {
    return deepLinkRedirect(`${NATIVE_OAUTH_CALLBACK_SCHEME}?error=session_missing`);
  }

  const verifiedProof = verifiedCreationProof(request, session.nativeOAuthCreationProof, {
    userId: session.user.id,
    authSessionId: session.authSessionId,
  });
  let transferToken: string;
  try {
    let credentialProof: WebCredentialProof | undefined;
    if (webCredentialProofMode(process.env) === 'required') {
      const raw = await getAdmittedRawServerToken();
      if (!raw || !process.env.NEXTAUTH_SECRET) throw new Error('Source credential unavailable');
      const claims = await decode({ token: raw, secret: process.env.NEXTAUTH_SECRET });
      if (claims?.sub !== session.user.id || claims.authSessionId !== session.authSessionId)
        throw new Error('Source credential changed');
      credentialProof = webCredentialProofSchema.parse({
        version: 1,
        userId: claims.sub,
        authSessionId: claims.authSessionId,
        generation: claims.gen ?? 0,
        authenticatedAt: claims.auth_time === undefined ? null : new Date(claims.auth_time * 1000).toISOString(),
        linkGuarded: claims.link_guarded === true,
        ...(claims.legacy_no_sid === true ? { requiresAccountCutoff: true } : {}),
      });
    }
    transferToken = issueNativeOAuthTransferToken({
      userId: session.user.id,
      generation: session.authGeneration ?? 0,
      nextPath,
      ...(session.authSessionId ? { authSessionId: session.authSessionId } : {}),
      ...(credentialProof ? { credentialProof } : {}),
      ...verifiedProof,
    });
  } catch {
    return deepLinkRedirect(`${NATIVE_OAUTH_CALLBACK_SCHEME}?error=token_issue_failed`);
  }

  return transferRedirect(transferToken, nextPath);
}

export async function GET(request: NextRequest) {
  try {
    return await nativeCallback(request);
  } catch (error) {
    // The in-app browser only closes on a redirect to the app scheme.
    if (error instanceof CredentialAuthorityUnavailable) {
      return deepLinkRedirect(`${NATIVE_OAUTH_CALLBACK_SCHEME}?error=session_unavailable`);
    }
    throw error;
  }
}
