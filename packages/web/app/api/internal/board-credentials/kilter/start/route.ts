import { randomBytes, createHash } from 'crypto';
import { getServerSession } from 'next-auth/next';
import { NextResponse, type NextRequest } from 'next/server';
import { KILTER_IDP_HOST, KILTER_OIDC_REALM } from '@boardsesh/kilter-sync/api';
import { authOptions } from '@/app/lib/auth/auth-options';
import { isKilterSyncAllowed } from '@/app/lib/kilter-sync/access';

/**
 * GET /api/internal/board-credentials/kilter/start — start the Kilter
 * PKCE/OIDC flow.
 *
 * Account-linking only — never creates a NextAuth session. We require an
 * existing NextAuth user; if they're not signed in we redirect to login
 * with a return URL. This route sits under
 * /api/internal/board-credentials (alongside aurora-credentials) rather
 * than /api/auth, which is owned by NextAuth and would route-match
 * incorrectly for non-provider flows.
 *
 * The PKCE code_verifier is stored in an HttpOnly cookie keyed by `state`
 * so the callback can complete the exchange without exposing the verifier
 * to JavaScript. Cookie path is scoped to the callback route only.
 */

// KILTER_IDP_HOST / KILTER_OIDC_REALM come from @boardsesh/kilter-sync/api,
// where they go through validateKilterHost(). Reading them straight from
// process.env here would skip that allowlist (an attacker-set IDP host
// would redirect the user to attacker infra during the OAuth start flow,
// even though the callback already verifies the JWT against the realm's
// JWKS).
const KILTER_OAUTH_CLIENT_ID = process.env.KILTER_OAUTH_CLIENT_ID;
const KILTER_OAUTH_REDIRECT_URI = process.env.KILTER_OAUTH_REDIRECT_URI;

const STATE_COOKIE_NAME = 'kilter_oauth_state';
const VERIFIER_COOKIE_NAME = 'kilter_oauth_verifier';
const COOKIE_MAX_AGE_SECONDS = 600; // 10 minutes — handshake should complete fast

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generateVerifier(): string {
  // RFC 7636 §4.1 — 43-128 chars, base64url charset. 32 random bytes ⇒ 43 chars.
  return base64url(randomBytes(32));
}

function challengeFor(verifier: string): string {
  return base64url(createHash('sha256').update(verifier).digest());
}

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);

  if (!session?.user?.id) {
    // Send the user through NextAuth, then back here once they're signed in.
    const returnTo = new URL('/api/internal/board-credentials/kilter/start', req.url).toString();
    const loginUrl = new URL('/api/auth/signin', req.url);
    loginUrl.searchParams.set('callbackUrl', returnTo);
    return NextResponse.redirect(loginUrl);
  }

  if (!(await isKilterSyncAllowed(session.user.id))) {
    return NextResponse.json({ error: 'Kilter sync is not enabled for this account' }, { status: 403 });
  }

  if (!KILTER_OAUTH_CLIENT_ID || !KILTER_OAUTH_REDIRECT_URI) {
    return NextResponse.json(
      { error: 'KILTER_OAUTH_CLIENT_ID and KILTER_OAUTH_REDIRECT_URI must be set' },
      { status: 500 },
    );
  }

  const state = base64url(randomBytes(16));
  const verifier = generateVerifier();
  const challenge = challengeFor(verifier);

  const authorize = new URL(`https://${KILTER_IDP_HOST}/realms/${KILTER_OIDC_REALM}/protocol/openid-connect/auth`);
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('client_id', KILTER_OAUTH_CLIENT_ID);
  authorize.searchParams.set('redirect_uri', KILTER_OAUTH_REDIRECT_URI);
  // offline_access requests a refresh_token. profile/email give us the
  // user metadata; openid is required for the id_token (which carries `sub`).
  authorize.searchParams.set('scope', 'openid profile email offline_access');
  authorize.searchParams.set('state', state);
  authorize.searchParams.set('code_challenge', challenge);
  authorize.searchParams.set('code_challenge_method', 'S256');

  const response = NextResponse.redirect(authorize.toString());
  // Scope the cookies to /api/internal/board-credentials/kilter so they
  // don't leak across the site. The callback reads them; disconnect
  // doesn't need them.
  response.cookies.set(STATE_COOKIE_NAME, state, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/api/internal/board-credentials/kilter',
    maxAge: COOKIE_MAX_AGE_SECONDS,
  });
  response.cookies.set(VERIFIER_COOKIE_NAME, verifier, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/api/internal/board-credentials/kilter',
    maxAge: COOKIE_MAX_AGE_SECONDS,
  });
  return response;
}
