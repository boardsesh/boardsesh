import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { stripAccessTokenAuthorizationScheme } from 'better-auth/oauth2';
import { getOAuthProviderApi } from '@better-auth/oauth-provider';
import { and, eq, isNull } from 'drizzle-orm';
import { oauthAccessToken, oauthRefreshToken, prototypeOAuthRefreshAncestor } from '@boardsesh/db/auth-prototype';
import type { PrototypeDatabase } from './authority';
import { PROTOTYPE_OAUTH_OPTIONS } from './oauth-options';
import { detachPrototypeOfflineGrant } from './oauth-offline';

function isRecord(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate);
}

async function rememberRefreshAncestor(
  database: PrototypeDatabase,
  refreshToken: typeof oauthRefreshToken.$inferSelect,
) {
  if (!refreshToken.authorizationCodeId) throw new Error('Missing persisted prototype refresh lineage.');
  await database
    .insert(prototypeOAuthRefreshAncestor)
    .values({
      tokenHash: refreshToken.token,
      clientId: refreshToken.clientId,
      userId: refreshToken.userId,
      authorizationCodeId: refreshToken.authorizationCodeId,
      expiresAt: refreshToken.expiresAt,
      consumedAt: refreshToken.revoked,
    })
    .onConflictDoNothing();
  const [existing] = await database
    .select()
    .from(prototypeOAuthRefreshAncestor)
    .where(eq(prototypeOAuthRefreshAncestor.tokenHash, refreshToken.token));
  if (
    !existing ||
    existing.clientId !== refreshToken.clientId ||
    existing.userId !== refreshToken.userId ||
    existing.authorizationCodeId !== refreshToken.authorizationCodeId ||
    existing.expiresAt.getTime() !== refreshToken.expiresAt.getTime()
  ) {
    throw new Error('Conflicting immutable prototype refresh lineage.');
  }
  if (refreshToken.revoked) {
    await database
      .update(prototypeOAuthRefreshAncestor)
      .set({ consumedAt: refreshToken.revoked })
      .where(
        and(
          eq(prototypeOAuthRefreshAncestor.tokenHash, refreshToken.token),
          isNull(prototypeOAuthRefreshAncestor.consumedAt),
        ),
      );
  }
}

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
            const [ancestor] = await database
              .select()
              .from(prototypeOAuthRefreshAncestor)
              .where(eq(prototypeOAuthRefreshAncestor.tokenHash, lookup));
            const lineage = refreshToken
              ? {
                  clientId: refreshToken.clientId,
                  userId: refreshToken.userId,
                  authorizationCodeId: refreshToken.authorizationCodeId,
                  expiresAt: refreshToken.expiresAt,
                  consumedAt: ancestor?.consumedAt ?? refreshToken.revoked,
                }
              : ancestor;
            if (!lineage) {
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
            if (lineage.clientId !== client.clientId) {
              // Stock 1.7.17's consumed-token revocation path invalidates the
              // supplied client/user family before checking token ownership.
              // A different registered client must never reach that path.
              return context.json(isRefresh ? { error: 'invalid_grant' } : null, {
                status: isRefresh ? 400 : 200,
                headers: { 'cache-control': 'no-store' },
              });
            }
            if (!isRefresh && lineage.expiresAt < new Date()) {
              // RFC 7009 treats an already-invalid token as a successful no-op.
              // Delegating an expired consumed token reaches stock broad cleanup.
              return context.json(null, { status: 200, headers: { 'cache-control': 'no-store' } });
            }
            if (!lineage.authorizationCodeId) {
              throw new APIError('BAD_REQUEST', {
                error: 'invalid_grant',
                error_description: 'Missing grant lineage.',
              });
            }
            if (!lineage.consumedAt) return;

            await database
              .delete(oauthAccessToken)
              .where(
                and(
                  eq(oauthAccessToken.clientId, lineage.clientId),
                  eq(oauthAccessToken.userId, lineage.userId),
                  eq(oauthAccessToken.authorizationCodeId, lineage.authorizationCodeId),
                ),
              );
            await database
              .delete(oauthRefreshToken)
              .where(
                and(
                  eq(oauthRefreshToken.clientId, lineage.clientId),
                  eq(oauthRefreshToken.userId, lineage.userId),
                  eq(oauthRefreshToken.authorizationCodeId, lineage.authorizationCodeId),
                ),
              );
            // The family is now closed, so forgetting its ancestry cannot leave
            // a live descendant behind. Expiry alone never triggers this delete.
            await database
              .delete(prototypeOAuthRefreshAncestor)
              .where(
                and(
                  eq(prototypeOAuthRefreshAncestor.clientId, lineage.clientId),
                  eq(prototypeOAuthRefreshAncestor.userId, lineage.userId),
                  eq(prototypeOAuthRefreshAncestor.authorizationCodeId, lineage.authorizationCodeId),
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
      after: [
        {
          matcher: (context) => context.path === '/oauth2/token',
          handler: createAuthMiddleware(async (context) => {
            const returned: unknown = context.context.returned;
            const tokenResponse: unknown = returned instanceof Response ? await returned.clone().json() : returned;
            if (!isRecord(tokenResponse) || typeof tokenResponse.refresh_token !== 'string') return;
            // The provider has already authenticated the client and issued this
            // response. Record only hashes from its transaction-bound rows.
            const provider = getOAuthProviderApi(context, PROTOTYPE_OAUTH_OPTIONS);
            const issuedHash = await provider.hashToken(tokenResponse.refresh_token, 'refresh_token');
            const [issued] = await database
              .select()
              .from(oauthRefreshToken)
              .where(eq(oauthRefreshToken.token, issuedHash));
            if (!issued) throw new Error('Missing persisted prototype refresh token.');
            if (issued.scopes.includes('offline_access')) {
              if (typeof tokenResponse.access_token !== 'string')
                throw new Error('Missing issued offline access token.');
              const accessTokenHash = await provider.hashToken(tokenResponse.access_token, 'access_token');
              await detachPrototypeOfflineGrant(database, issued, accessTokenHash);
            }
            await rememberRefreshAncestor(database, issued);

            if (context.body?.grant_type === 'refresh_token' && typeof context.body.refresh_token === 'string') {
              const consumedHash = await provider.hashToken(context.body.refresh_token, 'refresh_token');
              const [consumed] = await database
                .select()
                .from(oauthRefreshToken)
                .where(eq(oauthRefreshToken.token, consumedHash));
              if (!consumed || !consumed.revoked) throw new Error('Missing consumed prototype refresh token.');
              await rememberRefreshAncestor(database, consumed);
            }
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}
