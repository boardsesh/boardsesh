import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { stripAccessTokenAuthorizationScheme } from 'better-auth/oauth2';
import { getOAuthProviderApi } from '@better-auth/oauth-provider';
import { and, eq } from 'drizzle-orm';
import { oauthAccessToken, oauthRefreshToken } from '@boardsesh/db/auth-prototype';
import type { PrototypeDatabase } from './authority';
import { PROTOTYPE_OAUTH_OPTIONS } from './oauth-options';

/**
 * Opt-in BA-01 glue. Stock 1.7.17 invalidates every grant for an app/user when
 * one refresh token is reused. The public provider API authenticates the client
 * before this hook limits cleanup to the original immutable authorization code.
 * Call only inside the serialized request transaction in oauth-transaction.ts.
 */
export function prototypeOAuthFamilyGuard(database: PrototypeDatabase): BetterAuthPlugin {
  return {
    id: 'boardsesh-prototype-oauth-family',
    hooks: {
      before: [
        {
          matcher(context) {
            return (
              (context.path === '/oauth2/token' && context.body?.grant_type === 'refresh_token') ||
              context.path === '/oauth2/revoke'
            );
          },
          handler: createAuthMiddleware(async (context) => {
            const isRefresh = context.path === '/oauth2/token';
            const bodyToken: unknown = isRefresh ? context.body?.refresh_token : context.body?.token;
            if (typeof bodyToken !== 'string') return;
            // Match the stock endpoint's normalization before any guarded lookup.
            const presentedToken = isRefresh ? bodyToken : stripAccessTokenAuthorizationScheme(bodyToken);
            if (!presentedToken) return;

            const provider = getOAuthProviderApi(
              context,
              PROTOTYPE_OAUTH_OPTIONS,
              isRefresh ? 'refresh_token' : undefined,
            );
            const client = await provider.authenticateClient({ requireCredentials: false });
            const lookup = await provider.hashToken(presentedToken, 'refresh_token');
            const [refreshToken] = await database
              .select()
              .from(oauthRefreshToken)
              .where(eq(oauthRefreshToken.token, lookup));
            if (!refreshToken) {
              if (!isRefresh && context.body?.token_type_hint === 'refresh_token') {
                const accessLookup = await provider.hashToken(presentedToken, 'access_token');
                const [accessToken] = await database
                  .select()
                  .from(oauthAccessToken)
                  .where(eq(oauthAccessToken.token, accessLookup));
                if (accessToken) context.body.token_type_hint = 'access_token';
              }
              return;
            }
            // RFC 7009's type is a lookup hint, not authority to skip other types.
            if (!isRefresh && context.body?.token_type_hint === 'access_token')
              context.body.token_type_hint = 'refresh_token';
            if (refreshToken.clientId !== client.clientId) {
              // Stock 1.7.17's consumed-token revocation path invalidates the
              // supplied client/user family before checking token ownership.
              // A different registered client must never reach that path.
              return context.json(isRefresh ? { error: 'invalid_grant' } : null, {
                status: isRefresh ? 400 : 200,
                headers: { 'cache-control': 'no-store' },
              });
            }
            if (refreshToken.expiresAt < new Date()) {
              // RFC 7009 treats an already-invalid token as a successful no-op.
              // Delegating an expired consumed token reaches stock broad cleanup.
              if (!isRefresh) return context.json(null, { status: 200, headers: { 'cache-control': 'no-store' } });
              return;
            }
            if (!refreshToken.authorizationCodeId) {
              throw new APIError('BAD_REQUEST', {
                error: 'invalid_grant',
                error_description: 'Missing grant lineage.',
              });
            }
            if (!refreshToken.revoked) return;

            await database
              .delete(oauthAccessToken)
              .where(
                and(
                  eq(oauthAccessToken.clientId, refreshToken.clientId),
                  eq(oauthAccessToken.userId, refreshToken.userId),
                  eq(oauthAccessToken.authorizationCodeId, refreshToken.authorizationCodeId),
                ),
              );
            await database
              .delete(oauthRefreshToken)
              .where(
                and(
                  eq(oauthRefreshToken.clientId, refreshToken.clientId),
                  eq(oauthRefreshToken.userId, refreshToken.userId),
                  eq(oauthRefreshToken.authorizationCodeId, refreshToken.authorizationCodeId),
                ),
              );
            if (!isRefresh) return context.json(null, { status: 200, headers: { 'cache-control': 'no-store' } });
            return context.json(
              { error: 'invalid_grant', error_description: 'The refresh token has already been used.' },
              { status: 400, headers: { 'cache-control': 'no-store' } },
            );
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}
