import { partnerConnectionNotices } from '@boardsesh/db/schema/auth';
import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { getOAuthProviderApi, type OAuthOptions } from '@better-auth/oauth-provider';
import { and, eq, gt } from 'drizzle-orm';
import {
  oauthAccessToken,
  oauthClient,
  oauthConnections,
  oauthGrants,
  oauthRefreshToken,
  oauthVerification,
} from '@boardsesh/db/schema/auth';
import { PARTNER_AUTHORIZATION_CODE_LIFETIME_SECONDS } from './configuration';
import { PARTNER_CONSENT_ERRORS } from '@boardsesh/auth-protocol/partner-oauth';
import { checkConnectionCaps, type ConnectionCapRefusal } from './connection-caps';
import { ensurePartnerSubject } from './api-access';
import { createPartnerFamilyStore, createRefreshFamilyHooks } from './family-guard';
import {
  lockClimber,
  lockCurrentGrant,
  lockOrCreatePartnerConnection,
  lockPartnerConnection,
  selectConnectionForUpdate,
} from './locks';
import type { PartnerDatabase } from './tables';
import { currentPartnerTransaction, PartnerRefusal } from './transaction';

/** RFC 6749 section 3.2 forbids repeats. RFC 8707 makes `resource` the one exception. */
const REPEATABLE_FORM_PARAMETERS = new Set(['resource']);

function stringParameter(candidate: unknown): string | undefined {
  return typeof candidate === 'string' ? candidate : undefined;
}

function firstRepeatedParameter(formBody: string): string | undefined {
  const seen = new Set<string>();
  for (const name of new URLSearchParams(formBody).keys()) {
    if (seen.has(name) && !REPEATABLE_FORM_PARAMETERS.has(name)) return name;
    seen.add(name);
  }
  return undefined;
}

/** Splits `prompt` the way the provider's schema does. */
function promptTokens(prompt: string): string[] {
  return prompt
    .split(' ')
    .map((token) => token.trim())
    .filter(Boolean);
}

/** The token endpoint methods that prove a client secret. Every other method is a public app's. */
const SECRET_AUTH_METHODS: ReadonlySet<string> = new Set(['client_secret_basic', 'client_secret_post']);

/**
 * Whether a code may go out only after the climber answers the consent screen
 * in this request, however recently they approved the app before. True for
 * every app but a confidential web app redirecting to https.
 *
 * - No secret (`none`): the client_id is public, so anyone can send it. A
 *   browser app cannot keep a secret (RFC 6749 section 10.2), and nothing
 *   proves which app on a device opened authorize (RFC 8252 section 8.6).
 * - Native, whatever its method or redirect: a secret it registered ships in
 *   the binary and can be pulled out, and another app can claim its custom
 *   scheme, listen on its loopback port, or catch an https link the system
 *   does not verify. Registration lets a native app register a secret and an
 *   https redirect, so neither proves anything. `application_type` is stored
 *   at registration and never changes.
 * - A redirect that is not https, should one ever reach a web app.
 *
 * In each case another app can start authorize with the real client_id and
 * its own PKCE verifier, in a browser that carries the climber's Boardsesh
 * sign-in. A remembered consent would hand it a code with no screen at all.
 *
 * `skip_consent` changes none of this: it can only spare a confidential web app
 * on https the screen, and registration never sets it (`managedClientProblem`).
 * Fails closed: an unknown app, type or method, or an unreadable redirect, asks.
 */
async function requiresConsentEveryTime(
  transaction: PartnerDatabase,
  clientId: string,
  redirectUri: string | null | undefined,
): Promise<boolean> {
  const [client] = await transaction
    .select({
      applicationType: oauthClient.applicationType,
      tokenEndpointAuthMethod: oauthClient.tokenEndpointAuthMethod,
    })
    .from(oauthClient)
    .where(eq(oauthClient.clientId, clientId));
  if (!client || client.applicationType !== 'web') return true;
  if (!client.tokenEndpointAuthMethod || !SECRET_AUTH_METHODS.has(client.tokenEndpointAuthMethod)) return true;
  return !redirectUri || !URL.canParse(redirectUri) || new URL(redirectUri).protocol !== 'https:';
}

/**
 * Whether the code can still be redeemed. An expired row counts as gone, as it
 * does in the provider, because nothing deletes it until the provider consumes it.
 */
async function isCodeLive(transaction: PartnerDatabase, authorizationCodeId: string): Promise<boolean> {
  const [pendingCode] = await transaction
    .select({ identifier: oauthVerification.identifier })
    .from(oauthVerification)
    .where(and(eq(oauthVerification.identifier, authorizationCodeId), gt(oauthVerification.expiresAt, new Date())))
    .limit(1);
  return pendingCode !== undefined;
}

/**
 * True when the code cannot be redeemed and neither token table still has a row
 * from it. The code is read first: a redemption inserts its tokens in the
 * transaction that consumes the code, so a code row seen as gone means those
 * tokens are already visible to the two reads that follow.
 */
async function isSpentCodeWithNoTokens(transaction: PartnerDatabase, authorizationCodeId: string): Promise<boolean> {
  if (await isCodeLive(transaction, authorizationCodeId)) return false;
  const [accessToken] = await transaction
    .select({ id: oauthAccessToken.id })
    .from(oauthAccessToken)
    .where(eq(oauthAccessToken.authorizationCodeId, authorizationCodeId))
    .limit(1);
  if (accessToken) return false;
  const [refreshToken] = await transaction
    .select({ id: oauthRefreshToken.id })
    .from(oauthRefreshToken)
    .where(eq(oauthRefreshToken.authorizationCodeId, authorizationCodeId))
    .limit(1);
  return refreshToken === undefined;
}

interface CodeOwner {
  userId: string;
  clientId: string;
  redirectUri: string | null;
  state: string | null;
}

function parseCodeOwner(serialized: string): CodeOwner | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const query = record.query;
  if (typeof record.userId !== 'string' || typeof query !== 'object' || query === null) return null;
  const { client_id: clientId, redirect_uri: redirectUri, state } = query as Record<string, unknown>;
  if (typeof clientId !== 'string') return null;
  return {
    userId: record.userId,
    clientId,
    redirectUri: typeof redirectUri === 'string' ? redirectUri : null,
    state: typeof state === 'string' ? state : null,
  };
}

const CAP_DESCRIPTIONS: Record<ConnectionCapRefusal, { error: string; description: string }> = {
  no_policy: { error: 'access_denied', description: 'This app is not set up to connect climbers yet.' },
  active_connections: {
    error: 'temporarily_unavailable',
    description: 'This app has reached its limit of connected climbers.',
  },
  new_connections_today: {
    error: 'temporarily_unavailable',
    description: 'This app has reached its limit of new connections for today. Try again tomorrow.',
  },
};

/** What the code guard answers when a code went out with no answer from the climber in this request. */
const CONSENT_REQUIRED = {
  error: 'consent_required',
  description: 'The climber has to approve this app on the Boardsesh consent screen.',
};

/**
 * The app hears about a refused code the way it hears a denial: an error on
 * its own redirect URI, as a 302 for a browser or `{ redirect, url }` for the
 * consent page's fetch. Nothing from the request survives: the provider's
 * consent and code roll back with it, and the consent link stays unspent.
 */
function authorizeRefusal(
  context: { headers?: Headers; request?: Request; context: { baseURL: string } },
  owner: CodeOwner,
  { error, description }: { error: string; description: string },
): PartnerRefusal {
  if (!owner.redirectUri || !URL.canParse(owner.redirectUri)) {
    return new PartnerRefusal(
      Response.json(
        { error, error_description: description },
        { status: 403, headers: { 'cache-control': 'no-store' } },
      ),
    );
  }
  const target = new URL(owner.redirectUri);
  target.searchParams.set('error', error);
  target.searchParams.set('error_description', description);
  if (owner.state) target.searchParams.set('state', owner.state);
  target.searchParams.set('iss', context.context.baseURL);
  const wantsJson =
    context.headers?.get('accept')?.includes('application/json') ||
    context.request?.headers.get('sec-fetch-mode') === 'cors';
  return new PartnerRefusal(
    wantsJson
      ? Response.json({ redirect: true, url: target.href }, { headers: { 'cache-control': 'no-store' } })
      : new Response(null, { status: 302, headers: { location: target.href, 'cache-control': 'no-store' } }),
  );
}

/**
 * The same caps at the code exchange, where they are enforced: the token
 * response becomes this error and everything the provider wrote rolls back.
 */
function exchangeRefusal(refusal: ConnectionCapRefusal): PartnerRefusal {
  return new PartnerRefusal(
    Response.json(
      { error: 'invalid_grant', error_description: CAP_DESCRIPTIONS[refusal].description },
      { status: 400, headers: { 'cache-control': 'no-store' } },
    ),
  );
}

/** A token endpoint answer that issued tokens, as opposed to an error the provider returned. */
function issuedTokens(returned: unknown): boolean {
  return (
    typeof returned === 'object' &&
    returned !== null &&
    typeof (returned as { access_token?: unknown }).access_token === 'string'
  );
}

/** Where the provider sent the browser, whether it answered JSON or a 302. */
export function authorizeRedirectTarget(context: {
  context: { returned?: unknown; responseHeaders?: Headers };
}): string | undefined {
  const returned = context.context.returned;
  if (typeof returned === 'object' && returned !== null && 'url' in returned) {
    const url = (returned as { url: unknown }).url;
    if (typeof url === 'string') return url;
  }
  return context.context.responseHeaders?.get('location') ?? undefined;
}

export function partnerFencePlugin(oauthOptions: OAuthOptions<string[]>): BetterAuthPlugin {
  const familyStore = createPartnerFamilyStore();
  const family = createRefreshFamilyHooks({
    store: familyStore,
    oauthOptions,
    async acquireFamilyFence(owner) {
      return (await lockCurrentGrant(currentPartnerTransaction().transaction, owner)) ? 'current' : 'fenced';
    },
    async lockAccessTokenOwner(owner) {
      if (owner.userId === null) return;
      await lockPartnerConnection(currentPartnerTransaction().transaction, owner.userId, owner.clientId);
    },
  });

  return {
    id: 'boardsesh-partner-fence',
    hooks: {
      before: [
        // Hooks run before the provider parses the request, so they read it raw.
        // The provider trims grant_type, and last-wins form parsing would let one
        // copy of a parameter reach the guards and another reach the provider.
        // Refusing both here keeps every guard on the value the provider acts on.
        {
          matcher: (context) => context.path === '/oauth2/token' || context.path === '/oauth2/revoke',
          handler: createAuthMiddleware(async (context) => {
            const invalidRequest = (description: string) =>
              context.json(
                { error: 'invalid_request', error_description: description },
                { status: 400, headers: { 'cache-control': 'no-store' } },
              );
            const grantType: unknown = context.body?.grant_type;
            if (typeof grantType === 'string' && grantType !== grantType.trim()) {
              return invalidRequest('grant_type must not have surrounding whitespace.');
            }
            if (context.request && firstRepeatedParameter(await context.request.clone().text())) {
              return invalidRequest('Request parameters must not be repeated.');
            }
          }),
        },
        // A signed-in climber opening an authorization or answering consent.
        {
          matcher: (context) => context.path === '/oauth2/authorize' || context.path === '/oauth2/consent',
          handler: createAuthMiddleware(async (context) => {
            const session = context.context.session;
            if (!session) return;
            const { transaction, state } = currentPartnerTransaction();
            const isConsent = context.path === '/oauth2/consent';
            // The provider reads a form POST from the body and a GET from the query.
            // Consent's nested authorize finds no client_id in its JSON body and
            // stops below: consent's own pass through this hook has taken the locks.
            const source = !isConsent && context.method === 'POST' ? 'body' : 'query';
            const parameters: Record<string, unknown> = context[source] ?? {};
            const clientId = isConsent
              ? typeof context.body?.oauth_query === 'string'
                ? new URLSearchParams(context.body.oauth_query).get('client_id')
                : null
              : stringParameter(parameters.client_id);
            if (!clientId) return;
            if (isConsent) {
              // The consent guard checked and spent the consent link before this
              // hook runs. Without its decision, nothing here approves anything.
              if (!state.consent) {
                throw new APIError('BAD_REQUEST', {
                  error: PARTNER_CONSENT_ERRORS.linkSpent,
                  error_description: 'This consent link is no longer valid.',
                });
              }
              if (state.consent.approved) state.consentApproved = true;
            }

            // Held even with no connection yet: a password reset then waits for this
            // request and finds the code it binds. The row itself waits for a code.
            if (!(await lockClimber(transaction, session.user.id))) {
              throw new APIError('BAD_REQUEST', { error: 'invalid_request', error_description: 'Account not found.' });
            }
            const connection = await selectConnectionForUpdate(transaction, session.user.id, clientId);
            if (isConsent || state.consentApproved) return;
            // A reconnect always shows a new consent screen, even if the app would
            // otherwise skip it. So does every request a remembered consent must
            // not answer: any app but a confidential web app on https. Decided
            // here from the stored app, never from what the request asks for,
            // and backed by the code guard after authorize.
            const mustAsk =
              Boolean(connection?.revokedAt) ||
              (await requiresConsentEveryTime(transaction, clientId, stringParameter(parameters.redirect_uri)));
            if (!mustAsk) return;
            const prompt = parameters.prompt ?? '';
            if (typeof prompt !== 'string') return;
            const prompts = new Set(promptTokens(prompt));
            // The provider refuses prompt=none combined with anything else. Alone,
            // it gets consent_required: from the provider once Disconnect removed
            // the consent, and from the code guard while a consent is remembered.
            if (prompts.has('none')) return;
            prompts.add('consent');
            return { context: { [source]: { ...parameters, prompt: [...prompts].join(' ') } } };
          }),
        },
        // Redeeming a code: find the owner from the grant, then lock before the provider consumes it.
        {
          matcher: (context) => context.path === '/oauth2/token' && context.body?.grant_type === 'authorization_code',
          handler: createAuthMiddleware(async (context) => {
            const code: unknown = context.body?.code;
            if (typeof code !== 'string' || !code) return;
            const provider = getOAuthProviderApi(context, oauthOptions, 'authorization_code');
            const client = await provider.authenticateClient({ requireCredentials: false });
            // The provider's own first check: with neither a code_verifier nor a
            // client secret it refuses before consuming anything, so taking the
            // lock first would let one live code hold it again on every request.
            const codeVerifier: unknown = context.body?.code_verifier;
            const hasCodeVerifier = typeof codeVerifier === 'string' && codeVerifier.length > 0;
            if (!hasCodeVerifier && (client.method === undefined || client.method === 'none')) {
              return context.json(
                { error: 'invalid_request', error_description: 'Either code_verifier or client_secret is required' },
                { status: 400, headers: { 'cache-control': 'no-store' } },
              );
            }
            const { transaction } = currentPartnerTransaction();
            const authorizationCodeId = await provider.hashToken(code, 'authorization_code');
            const [grant] = await transaction
              .select({ userId: oauthConnections.userId, clientId: oauthConnections.clientId })
              .from(oauthGrants)
              .innerJoin(oauthConnections, eq(oauthConnections.id, oauthGrants.connectionId))
              .where(eq(oauthGrants.authorizationCodeId, authorizationCodeId));
            // An unknown code takes no lock. A code from another app is refused
            // here, before the stock path would consume it.
            const invalidGrant = () =>
              context.json(
                { error: 'invalid_grant', error_description: 'The authorization code is no longer valid.' },
                { status: 400, headers: { 'cache-control': 'no-store' } },
              );
            if (!grant || grant.clientId !== client.clientId) return invalidGrant();
            // A spent code whose tokens are already gone needs no fence: only a
            // live code can issue anything, and there is nothing left to clean
            // up. Taking `users FOR SHARE` here would let replays of it hold off
            // a password reset for as long as the replays keep coming.
            if (await isSpentCodeWithNoTokens(transaction, authorizationCodeId)) return invalidGrant();
            const owner = { userId: grant.userId, clientId: grant.clientId, authorizationCodeId };
            if (!(await lockCurrentGrant(transaction, owner))) return invalidGrant();
            currentPartnerTransaction().state.redemption = { userId: grant.userId, clientId: grant.clientId };
            // RFC 6749 section 4.1.2: a code used twice takes its tokens with it.
            // Done here, under the lock, because the provider only does it after
            // its own checks, and a replay that fails those (no code_verifier)
            // would otherwise find the tokens still there and lock again forever.
            if (!(await isCodeLive(transaction, authorizationCodeId))) {
              await familyStore.closeFamily(owner);
              return invalidGrant();
            }
          }),
        },
        ...(family.before ?? []),
      ],
      after: [
        // A code was issued: bind it to the connection generation and cut its lifetime.
        {
          matcher: (context) => context.path === '/oauth2/authorize',
          handler: createAuthMiddleware(async (context) => {
            // A code needs a session. Without one the redirect is the sign-in
            // page, and a `code` on it is a parameter the caller sent.
            if (!context.context.session) return;
            const target = authorizeRedirectTarget(context);
            if (!target) return;
            const code = URL.canParse(target) ? new URL(target).searchParams.get('code') : null;
            if (!code) return;
            const { transaction, state } = currentPartnerTransaction();
            const provider = getOAuthProviderApi(context, oauthOptions);
            const authorizationCodeId = await provider.hashToken(code, 'authorization_code');
            const [pending] = await transaction
              .select({ value: oauthVerification.value })
              .from(oauthVerification)
              .where(eq(oauthVerification.identifier, authorizationCodeId));
            // No matching row means `code` came from the client's own redirect URI, not from issuance.
            if (!pending) return;
            const codeOwner = parseCodeOwner(pending.value);
            if (!codeOwner) throw new Error('Issued authorization code has no owner.');
            // The code guard. Only a code bound below can be redeemed, so every
            // code that could reach a token passes here. One the climber did not
            // approve in this very request, for an app a remembered consent must
            // not answer, goes nowhere: prompt=none from such an app lands here,
            // and so would anything that slipped past the rewrite before authorize.
            if (
              !state.consentApproved &&
              (await requiresConsentEveryTime(transaction, codeOwner.clientId, codeOwner.redirectUri))
            ) {
              throw authorizeRefusal(context, codeOwner, CONSENT_REQUIRED);
            }

            const connection = await lockOrCreatePartnerConnection(transaction, codeOwner.userId, codeOwner.clientId);
            if (!connection) throw new Error('Authorization code issued for a missing account.');
            if (connection.revokedAt && !state.consentApproved) {
              throw new Error('Authorization code issued for a disconnected connection without consent.');
            }
            // The guard read the generation under the connection lock, but a
            // first-time consent had no row to lock: a connection made and then
            // disconnected since then has moved it, and this approval was for
            // the generation that ended. Reconnecting here would undo Disconnect.
            if (state.consentApproved && state.consent && connection.generation !== state.consent.generation) {
              throw new PartnerRefusal(
                Response.json(
                  {
                    error: PARTNER_CONSENT_ERRORS.linkSpent,
                    error_description: 'This consent link is no longer valid.',
                  },
                  { status: 400, headers: { 'cache-control': 'no-store' } },
                ),
              );
            }
            const issuedAt = new Date();
            if (connection.revokedAt || !connection.connectedAt) {
              // Nothing is counted here; the caps are enforced when the app
              // redeems a code. Checked now only so a full app turns the climber
              // away at once instead of after they approve.
              const capRefusal = await checkConnectionCaps(transaction, connection, issuedAt);
              if (capRefusal) throw authorizeRefusal(context, codeOwner, CAP_DESCRIPTIONS[capRefusal]);
              if (connection.revokedAt) {
                // An approved reconnect: no longer revoked, but not live again
                // (and not counted) until the app redeems a code. Its last use
                // belonged to the connection that ended, so Connected apps reads
                // "Not used yet" and the first call after reconnecting stamps it.
                await transaction
                  .update(oauthConnections)
                  .set({
                    revokedAt: null,
                    revocationReason: null,
                    connectedAt: null,
                    lastUsedAt: null,
                    updatedAt: issuedAt,
                  })
                  .where(eq(oauthConnections.id, connection.id));
              }
            }
            await transaction
              .insert(oauthGrants)
              .values({ authorizationCodeId, connectionId: connection.id, generation: connection.generation });
            await transaction
              .update(oauthVerification)
              .set({ expiresAt: new Date(issuedAt.getTime() + PARTNER_AUTHORIZATION_CODE_LIFETIME_SECONDS * 1000) })
              .where(eq(oauthVerification.identifier, authorizationCodeId));
          }),
        },
        ...(family.after ?? []),
        // A code became tokens: the connection goes live now, if the app's caps
        // allow, under the connection lock the redemption holds and then the
        // app's policy row. Approvals nobody redeems hold no place: a code lives
        // 60 seconds, and only an exchange, which a confidential app makes with
        // its secret, can fill an app's caps.
        {
          matcher: (context) => context.path === '/oauth2/token' && context.body?.grant_type === 'authorization_code',
          handler: createAuthMiddleware(async (context) => {
            const { transaction, state } = currentPartnerTransaction();
            if (!state.redemption || !issuedTokens(context.context.returned)) return;
            const connection = await selectConnectionForUpdate(
              transaction,
              state.redemption.userId,
              state.redemption.clientId,
            );
            if (!connection) throw new Error('Redeemed a code for a missing connection.');
            await ensurePartnerSubject(transaction, connection.userId, connection.clientId);
            if (connection.connectedAt) return;
            const liveAt = new Date();
            const capRefusal = await checkConnectionCaps(transaction, connection, liveAt);
            if (capRefusal) throw exchangeRefusal(capRefusal);
            await transaction
              .update(oauthConnections)
              .set({ connectedAt: liveAt, updatedAt: liveAt })
              .where(eq(oauthConnections.id, connection.id));
            await transaction
              .insert(partnerConnectionNotices)
              .values({
                connectionId: connection.id,
                generation: connection.generation,
                userId: connection.userId,
                clientId: connection.clientId,
                createdAt: liveAt,
              })
              .onConflictDoNothing();
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}
