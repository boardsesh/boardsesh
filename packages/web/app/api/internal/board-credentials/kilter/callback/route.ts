import { getServerSession } from 'next-auth/next';
import { NextResponse, type NextRequest } from 'next/server';
import { and, eq } from 'drizzle-orm';
import * as Sentry from '@sentry/nextjs';
import { encrypt } from '@boardsesh/crypto';
// Importing from the `./api` subpath, NOT the package root. The api
// subpath only carries the Keycloak/PowerSync/REST type + helpers
// (jose, fetch, constants); it does NOT pull in the runner subgraph
// that drags `postgres` and the sync daemon into the web bundle. The
// `@boardsesh/kilter-sync` package.json declares separate exports for
// `.` vs `./api` for exactly this reason — keep using the subpath in
// web code to keep the bundle clean. If a future refactor needs more
// Kilter wire helpers from a web route, extend the `./api` re-exports
// rather than reaching into `./runner` or `./sync`.
import { exchangeAuthorizationCode, verifyKeycloakToken, KILTER_BOARD_TYPE } from '@boardsesh/kilter-sync/api';
import { authOptions } from '@/app/lib/auth/auth-options';
import { getDb } from '@/app/lib/db/db';
import * as schema from '@/app/lib/db/schema';
import { isKilterSyncAllowed } from '@/app/lib/kilter-sync/access';

const KILTER_OAUTH_CLIENT_ID = process.env.KILTER_OAUTH_CLIENT_ID;
const KILTER_OAUTH_CLIENT_SECRET = process.env.KILTER_OAUTH_CLIENT_SECRET;
const KILTER_OAUTH_REDIRECT_URI = process.env.KILTER_OAUTH_REDIRECT_URI;
const SETTINGS_RETURN_URL = '/settings?kilter=connected';
const SETTINGS_ERROR_URL = '/settings?kilter=error';

const STATE_COOKIE_NAME = 'kilter_oauth_state';
const VERIFIER_COOKIE_NAME = 'kilter_oauth_verifier';
const NONCE_COOKIE_NAME = 'kilter_oauth_nonce';
const HANDSHAKE_COOKIE_PATH = '/api/internal/board-credentials/kilter';

// The `reason` query param reflected onto /settings is an
// attacker-controllable string via the OAuth `error=` redirect. No
// page consumes it today, but a future change that drops it into JSX
// would ship reflected XSS. Constrain to a known enum at the source
// so the contract is "any unrecognised reason becomes `oauth_error`."
const REFLECTABLE_OAUTH_ERRORS = new Set<string>([
  'access_denied',
  'invalid_request',
  'invalid_scope',
  'server_error',
  'temporarily_unavailable',
  'unauthorized_client',
  'unsupported_response_type',
]);
function safeOauthErrorReason(raw: string): string {
  return REFLECTABLE_OAUTH_ERRORS.has(raw) ? raw : 'oauth_error';
}

/**
 * Build a redirect response and clear the handshake cookies in the same
 * pass. Every exit from this route — success or error — must scrub the
 * state + verifier + nonce so a stale cookie can't carry forward into a
 * later tab. The cookies are HttpOnly + 600s TTL, so leaving them alive
 * just means the next 10 minutes of any handshake start from a slightly
 * confusing state; not a security hole, but not the contract the file
 * docs promise either.
 */
function redirectAndClearCookies(req: NextRequest, location: string): NextResponse {
  const response = NextResponse.redirect(new URL(location, req.url));
  response.cookies.delete({ name: STATE_COOKIE_NAME, path: HANDSHAKE_COOKIE_PATH });
  response.cookies.delete({ name: VERIFIER_COOKIE_NAME, path: HANDSHAKE_COOKIE_PATH });
  response.cookies.delete({ name: NONCE_COOKIE_NAME, path: HANDSHAKE_COOKIE_PATH });
  return response;
}

/**
 * Threat model for id_token verification:
 *
 * The id_token arrives over TLS from the Keycloak token endpoint, but
 * the host we hit is whatever `KILTER_IDP_HOST` resolves to — and that
 * value is env-driven. A misconfigured or hostile env var could point
 * us at an attacker-controlled IDP that hands us a token with any
 * `sub`/`preferred_username` it likes. Transport-layer trust does not
 * cover "is this realm who I think it is."
 *
 * Verifying the JWT signature against the realm's published JWKS, and
 * checking `iss === <expected realm URL>` + `aud === <our client_id>`,
 * ties the token back to the legitimate Keycloak signing key. The
 * host-allowlist on KILTER_IDP_HOST (types.ts) is the complementary
 * defence: together they prevent an env-set host from rerouting our
 * OAuth handshake to a third party.
 */

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.redirect(new URL('/api/auth/signin', req.url));
  }

  if (!(await isKilterSyncAllowed(session.user.id))) {
    return redirectAndClearCookies(req, `${SETTINGS_ERROR_URL}&reason=not-allowed`);
  }

  if (!KILTER_OAUTH_CLIENT_ID || !KILTER_OAUTH_REDIRECT_URI) {
    return NextResponse.json({ error: 'Kilter OAuth not configured' }, { status: 500 });
  }

  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const errorParam = url.searchParams.get('error');

  if (errorParam) {
    return redirectAndClearCookies(req, `${SETTINGS_ERROR_URL}&reason=${safeOauthErrorReason(errorParam)}`);
  }
  if (!code || !state) {
    return redirectAndClearCookies(req, `${SETTINGS_ERROR_URL}&reason=missing-params`);
  }

  const stateCookie = req.cookies.get(STATE_COOKIE_NAME)?.value;
  const verifier = req.cookies.get(VERIFIER_COOKIE_NAME)?.value;
  const nonceCookie = req.cookies.get(NONCE_COOKIE_NAME)?.value;
  if (!stateCookie || !verifier || stateCookie !== state) {
    // Either CSRF / replay attempt, or the user took >10 min between
    // /start and the redirect. Either way, restart the handshake — and
    // explicitly clear any cookies still hanging around so the next
    // /start gets a clean slate.
    return redirectAndClearCookies(req, `${SETTINGS_ERROR_URL}&reason=state-mismatch`);
  }

  let tokens;
  try {
    tokens = await exchangeAuthorizationCode({
      code,
      redirectUri: KILTER_OAUTH_REDIRECT_URI,
      codeVerifier: verifier,
      client: {
        clientId: KILTER_OAUTH_CLIENT_ID,
        clientSecret: KILTER_OAUTH_CLIENT_SECRET,
      },
    });
  } catch (err) {
    Sentry.captureException(err, {
      tags: { route: 'auth/kilter/callback', step: 'exchange-code' },
      // user.id is PII-scrubbed by Sentry; `extra` is not. Same fix
      // as backend/src/handlers/kilter-sync.ts.
      user: { id: session.user.id },
    });
    return redirectAndClearCookies(req, `${SETTINGS_ERROR_URL}&reason=exchange-failed`);
  }

  // Shape guard: a 200 from the token endpoint with a malformed body
  // (proxy stripped the JSON, upstream changed the contract, …) would
  // otherwise blow up on the property accesses below with a confusing
  // TypeError. Surface it cleanly and report the shape to Sentry so we
  // can spot the upstream regression.
  if (!tokens || typeof tokens !== 'object' || typeof tokens.access_token !== 'string') {
    Sentry.captureException(new Error('Keycloak token endpoint returned malformed body'), {
      tags: { route: 'auth/kilter/callback' },
      user: { id: session.user.id },
      extra: { tokensShape: typeof tokens },
    });
    return redirectAndClearCookies(req, `${SETTINGS_ERROR_URL}&reason=malformed-tokens`);
  }

  if (!tokens.refresh_token) {
    // offline_access scope should have produced a refresh_token; if it
    // didn't we can't keep syncing past the access_token TTL. Fail
    // closed — better than persisting an unrenewable credential.
    return redirectAndClearCookies(req, `${SETTINGS_ERROR_URL}&reason=no-refresh-token`);
  }

  let sub: string;
  let preferredUsername: string | undefined;
  try {
    if (!tokens.id_token) throw new Error('id_token missing from token response');
    ({ sub, preferredUsername } = await verifyKeycloakToken(tokens.id_token, {
      expectedAudience: KILTER_OAUTH_CLIENT_ID,
      // Bind the id_token to the nonce we stashed at /start. Absent only
      // if the cookie expired/was stripped, in which case verification
      // falls back to issuer + audience + signature + exp.
      expectedNonce: nonceCookie,
    }));
  } catch (err) {
    Sentry.captureException(err, {
      tags: { route: 'auth/kilter/callback', step: 'id-token-decode' },
      user: { id: session.user.id },
    });
    return redirectAndClearCookies(req, `${SETTINGS_ERROR_URL}&reason=id-token`);
  }

  const db = getDb();
  const now = new Date();
  const encryptedRefreshToken = encrypt(tokens.refresh_token);

  // Both writes go through a single transaction. Without it, a partial
  // failure between the credential upsert and the mapping upsert would
  // leave the daemon picking up a credential with no
  // user_board_mappings row — the sync loop has no way to recover
  // automatically and would silently no-op every cycle.
  try {
    await db.transaction(async (tx) => {
      // Upsert aurora_credentials with board_type='kilter'.
      // Username/password stay NULL — kilter rows are token-only.
      const existing = await tx
        .select({ id: schema.auroraCredentials.id })
        .from(schema.auroraCredentials)
        .where(
          and(
            eq(schema.auroraCredentials.userId, session.user.id),
            eq(schema.auroraCredentials.boardType, KILTER_BOARD_TYPE),
          ),
        )
        .limit(1);

      if (existing.length > 0) {
        await tx
          .update(schema.auroraCredentials)
          .set({
            encryptedRefreshToken,
            syncStatus: 'pending',
            syncError: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(schema.auroraCredentials.userId, session.user.id),
              eq(schema.auroraCredentials.boardType, KILTER_BOARD_TYPE),
            ),
          );
      } else {
        await tx.insert(schema.auroraCredentials).values({
          userId: session.user.id,
          boardType: KILTER_BOARD_TYPE,
          encryptedRefreshToken,
          syncStatus: 'pending',
        });
      }

      // Mirror to user_board_mappings so other parts of the app can
      // find the Kilter sub UUID. board_user_id (integer) stays NULL
      // for kilter rows; board_user_id_text holds Keycloak's sub.
      const existingMapping = await tx
        .select({ id: schema.userBoardMappings.id })
        .from(schema.userBoardMappings)
        .where(
          and(
            eq(schema.userBoardMappings.userId, session.user.id),
            eq(schema.userBoardMappings.boardType, KILTER_BOARD_TYPE),
          ),
        )
        .limit(1);

      if (existingMapping.length > 0) {
        await tx
          .update(schema.userBoardMappings)
          .set({
            boardUserIdText: sub,
            boardUsername: preferredUsername ?? null,
            linkedAt: now,
          })
          .where(
            and(
              eq(schema.userBoardMappings.userId, session.user.id),
              eq(schema.userBoardMappings.boardType, KILTER_BOARD_TYPE),
            ),
          );
      } else {
        await tx.insert(schema.userBoardMappings).values({
          userId: session.user.id,
          boardType: KILTER_BOARD_TYPE,
          boardUserIdText: sub,
          boardUsername: preferredUsername ?? null,
        });
      }
    });
  } catch (err) {
    Sentry.captureException(err, {
      tags: { route: 'auth/kilter/callback', step: 'persist-credential' },
      user: { id: session.user.id },
    });
    return redirectAndClearCookies(req, `${SETTINGS_ERROR_URL}&reason=persist-failed`);
  }

  return redirectAndClearCookies(req, SETTINGS_RETURN_URL);
}
