import type { BetterAuthPlugin } from 'better-auth';
import { isCimdClientIdUrlCandidate } from '@better-auth/cimd';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { GYM_MCP_RESOURCE, GYM_MCP_SCOPES, gymMcpAllowsUser } from '../../mcp/gyms/configuration';
import type { PartnerAuthorityConfiguration } from './configuration';

/** Policy applies before consent is spent; role permissions are still checked by every tool. */
export function gymMcpConsentGuard(configuration: PartnerAuthorityConfiguration): BetterAuthPlugin {
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
          }),
        },
      ],
    },
  };
}
