import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { getOAuthProviderApi, type OAuthOptions } from '@better-auth/oauth-provider';
import { eq } from 'drizzle-orm';
import { oauthClient, oauthConnections, oauthGrants, oauthVerification } from '@boardsesh/db/schema/auth';
import { PARTNER_AUTHORIZATION_CODE_LIFETIME_SECONDS } from './configuration';
import { createPartnerFamilyStore, createRefreshFamilyHooks } from './family-guard';
import { lockCurrentGrant, lockOrCreatePartnerConnection, lockPartnerConnection } from './locks';
import { currentPartnerTransaction } from './transaction';

function stringParameter(candidate: unknown): string | undefined {
  return typeof candidate === 'string' ? candidate : undefined;
}

function parseCodeOwner(serialized: string): { userId: string; clientId: string } | null {
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
  const clientId = (query as Record<string, unknown>).client_id;
  return typeof clientId === 'string' ? { userId: record.userId, clientId } : null;
}

/** Where the provider sent the browser, whether it answered JSON or a 302. */
function authorizeRedirectTarget(context: {
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
  const family = createRefreshFamilyHooks({
    store: createPartnerFamilyStore(),
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
        // A signed-in climber opening an authorization or answering consent.
        {
          matcher: (context) => context.path === '/oauth2/authorize' || context.path === '/oauth2/consent',
          handler: createAuthMiddleware(async (context) => {
            const session = context.context.session;
            if (!session) return;
            const { transaction, state } = currentPartnerTransaction();
            const isConsent = context.path === '/oauth2/consent';
            const clientId = isConsent
              ? typeof context.body?.oauth_query === 'string'
                ? new URLSearchParams(context.body.oauth_query).get('client_id')
                : null
              : (stringParameter(context.body?.client_id) ?? stringParameter(context.query?.client_id));
            if (!clientId) return;
            if (isConsent && context.body?.accept === true) state.consentApproved = true;

            const [knownClient] = await transaction
              .select({ clientId: oauthClient.clientId })
              .from(oauthClient)
              .where(eq(oauthClient.clientId, clientId));
            if (!knownClient) return;

            const connection = await lockOrCreatePartnerConnection(transaction, session.user.id, clientId);
            if (!connection) {
              throw new APIError('BAD_REQUEST', { error: 'invalid_request', error_description: 'Account not found.' });
            }
            // A reconnect always shows a new consent screen, even if the app
            // would otherwise skip it. The provider reads this from the body on
            // a form POST and from the query otherwise.
            if (connection.revokedAt && !isConsent && !state.consentApproved) {
              const source = context.method === 'POST' ? 'body' : 'query';
              const parameters: Record<string, unknown> = context[source] ?? {};
              const prompts = new Set(
                (typeof parameters.prompt === 'string' ? parameters.prompt : '').split(' ').filter(Boolean),
              );
              prompts.add('consent');
              return { context: { [source]: { ...parameters, prompt: [...prompts].join(' ') } } };
            }
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
            const owner = { userId: grant.userId, clientId: grant.clientId, authorizationCodeId };
            if (!(await lockCurrentGrant(transaction, owner))) return invalidGrant();
          }),
        },
        ...(family.before ?? []),
      ],
      after: [
        // A code was issued: bind it to the connection generation and cut its lifetime.
        {
          matcher: (context) => context.path === '/oauth2/authorize',
          handler: createAuthMiddleware(async (context) => {
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

            const connection = await lockOrCreatePartnerConnection(transaction, codeOwner.userId, codeOwner.clientId);
            if (!connection) throw new Error('Authorization code issued for a missing account.');
            if (connection.revokedAt && !state.consentApproved) {
              throw new Error('Authorization code issued for a disconnected connection without consent.');
            }
            const issuedAt = new Date();
            if (connection.revokedAt || !connection.connectedAt) {
              await transaction
                .update(oauthConnections)
                .set({ revokedAt: null, revocationReason: null, connectedAt: issuedAt, updatedAt: issuedAt })
                .where(eq(oauthConnections.id, connection.id));
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
      ],
    },
  } satisfies BetterAuthPlugin;
}
