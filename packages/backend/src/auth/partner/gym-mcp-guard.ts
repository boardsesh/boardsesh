import type { BetterAuthPlugin } from 'better-auth';
import { isCimdClientIdUrlCandidate } from '@better-auth/cimd';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { getOAuthProviderApi, type OAuthOptions } from '@better-auth/oauth-provider';
import { and, eq, isNull } from 'drizzle-orm';
import { communityRoles } from '@boardsesh/db/schema';
import { oauthAccessToken } from '@boardsesh/db/schema/auth';
import {
  GYM_MCP_RESOURCE,
  GYM_MCP_SCOPES,
  GYM_MCP_DEFAULT_SCOPES,
  GYM_MCP_ADMIN_SCOPES,
  gymMcpAllowsUser,
} from '../../mcp/gyms/configuration';
import { currentPartnerTransaction, PartnerRefusal } from './transaction';
import type { PartnerAuthorityConfiguration } from './configuration';

function requestsAdminScopes(scopes: readonly string[]): boolean {
  return scopes.some((scope) => GYM_MCP_ADMIN_SCOPES.some((adminScope) => adminScope === scope));
}

/** The role cannot be revoked between the consent/token check and its commit. */
async function lockGlobalAdmin(userId: string): Promise<boolean> {
  const [role] = await currentPartnerTransaction()
    .transaction.select({ id: communityRoles.id })
    .from(communityRoles)
    .where(and(eq(communityRoles.userId, userId), eq(communityRoles.role, 'admin'), isNull(communityRoles.boardType)))
    .for('share')
    .limit(1);
  return role !== undefined;
}

/** Policy applies before consent is spent; role permissions are still checked by every tool. */
export function gymMcpConsentGuard(
  configuration: PartnerAuthorityConfiguration,
  oauthOptions: OAuthOptions<string[]>,
): BetterAuthPlugin {
  return {
    id: 'boardsesh-gym-mcp-consent',
    hooks: {
      before: [
        {
          matcher: (context) =>
            context.path === '/oauth2/authorize' ||
            context.path === '/oauth2/consent' ||
            context.path === '/oauth2/consent-details',
          handler: createAuthMiddleware(async (context) => {
            const query =
              context.path === '/oauth2/authorize'
                ? context.method === 'POST'
                  ? context.body
                  : context.query
                : typeof context.body?.oauth_query === 'string'
                  ? Object.fromEntries(new URLSearchParams(context.body.oauth_query))
                  : undefined;
            const clientId: unknown = query?.client_id;
            if (typeof clientId !== 'string' || !isCimdClientIdUrlCandidate(clientId)) return;
            const resource: unknown = query?.resource;
            const scope: unknown = query?.scope;
            // The provider otherwise defaults an omitted scope to the client's
            // full capability ceiling. Admin access must always be explicit.
            if (query && (scope === undefined || (typeof scope === 'string' && !scope.trim()))) {
              if (context.path !== '/oauth2/authorize') {
                throw new APIError('BAD_REQUEST', {
                  error: 'invalid_scope',
                  error_description: 'Start a new assistant connection with explicit scopes.',
                });
              }
              query.scope = GYM_MCP_DEFAULT_SCOPES.join(' ');
            }
            if (
              !configuration.gymMcp ||
              resource !== GYM_MCP_RESOURCE ||
              (typeof scope === 'string' &&
                scope
                  .split(' ')
                  .filter(Boolean)
                  .some((requestedScope) => !GYM_MCP_SCOPES.some((allowed) => allowed === requestedScope)))
            ) {
              throw new APIError('FORBIDDEN', {
                error: 'access_denied',
                error_description: 'This assistant may request only gym access.',
              });
            }
            const userId = context.context.session?.user.id;
            if (userId && !gymMcpAllowsUser(configuration.gymMcp, userId)) {
              throw new APIError('FORBIDDEN', {
                error: 'access_denied',
                error_description: 'Hosted gym tools are available to invited testers.',
              });
            }
            if (
              userId &&
              typeof scope === 'string' &&
              requestsAdminScopes(scope.split(' ')) &&
              !(await lockGlobalAdmin(userId))
            ) {
              throw new APIError('FORBIDDEN', {
                error: 'access_denied',
                error_description: 'Administrative gym access requires a current global admin role.',
              });
            }
          }),
        },
      ],
      after: [
        {
          matcher: (context) => context.path === '/oauth2/token',
          handler: createAuthMiddleware(async (context) => {
            const returned: unknown = context.context.returned;
            const tokenResponse: unknown = returned instanceof Response ? await returned.clone().json() : returned;
            if (
              typeof tokenResponse !== 'object' ||
              tokenResponse === null ||
              !('access_token' in tokenResponse) ||
              typeof tokenResponse.access_token !== 'string'
            )
              return;
            const provider = getOAuthProviderApi(context, oauthOptions);
            const tokenHash = await provider.hashToken(tokenResponse.access_token, 'access_token');
            const [issued] = await currentPartnerTransaction()
              .transaction.select()
              .from(oauthAccessToken)
              .where(eq(oauthAccessToken.token, tokenHash))
              .limit(1);
            if (!issued) throw new Error('Issued access token is missing.');
            if (!issued.resources?.includes(GYM_MCP_RESOURCE) || !requestsAdminScopes(issued.scopes)) return;
            if (issued.userId && (await lockGlobalAdmin(issued.userId))) return;
            // Ordinary OAuth 4xx responses commit replay cleanup. This refusal
            // must instead roll back the provider's newly issued token rows.
            throw new PartnerRefusal(
              Response.json(
                {
                  error: 'invalid_grant',
                  error_description: 'Administrative gym access requires a current global admin role. Sign in again.',
                },
                { status: 403, headers: { 'cache-control': 'no-store' } },
              ),
            );
          }),
        },
      ],
    },
  };
}
