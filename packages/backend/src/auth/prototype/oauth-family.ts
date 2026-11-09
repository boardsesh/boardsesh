import type { BetterAuthPlugin } from 'better-auth';
import { and, eq, isNull } from 'drizzle-orm';
import { oauthAccessToken, oauthRefreshToken, prototypeOAuthRefreshAncestor } from '@boardsesh/db/auth-prototype';
import { createRefreshFamilyHooks, type RefreshFamilyStore } from '../partner/family-guard';
import type { PrototypeDatabase } from './authority';
import { PROTOTYPE_OAUTH_OPTIONS } from './oauth-options';
import { detachPrototypeOfflineGrant } from './oauth-offline';

/** The partner guard's logic over the BA-01 tables. Family closure and ancestry are the same rules. */
function prototypeFamilyStore(database: PrototypeDatabase): RefreshFamilyStore {
  return {
    async findRefreshToken(tokenHash) {
      const [refreshToken] = await database
        .select()
        .from(oauthRefreshToken)
        .where(eq(oauthRefreshToken.token, tokenHash));
      return refreshToken;
    },
    async findAncestor(tokenHash) {
      const [ancestor] = await database
        .select()
        .from(prototypeOAuthRefreshAncestor)
        .where(eq(prototypeOAuthRefreshAncestor.tokenHash, tokenHash));
      return ancestor;
    },
    async findAccessTokenOwner(tokenHash) {
      const [accessToken] = await database.select().from(oauthAccessToken).where(eq(oauthAccessToken.token, tokenHash));
      return accessToken;
    },
    async insertAncestorIfAbsent(ancestor) {
      await database.insert(prototypeOAuthRefreshAncestor).values(ancestor).onConflictDoNothing();
    },
    async markAncestorConsumed(tokenHash, consumedAt) {
      await database
        .update(prototypeOAuthRefreshAncestor)
        .set({ consumedAt })
        .where(
          and(eq(prototypeOAuthRefreshAncestor.tokenHash, tokenHash), isNull(prototypeOAuthRefreshAncestor.consumedAt)),
        );
    },
    async closeFamily({ clientId, userId, authorizationCodeId }) {
      await database
        .delete(oauthAccessToken)
        .where(
          and(
            eq(oauthAccessToken.clientId, clientId),
            eq(oauthAccessToken.userId, userId),
            eq(oauthAccessToken.authorizationCodeId, authorizationCodeId),
          ),
        );
      await database
        .delete(oauthRefreshToken)
        .where(
          and(
            eq(oauthRefreshToken.clientId, clientId),
            eq(oauthRefreshToken.userId, userId),
            eq(oauthRefreshToken.authorizationCodeId, authorizationCodeId),
          ),
        );
      await database
        .delete(prototypeOAuthRefreshAncestor)
        .where(
          and(
            eq(prototypeOAuthRefreshAncestor.clientId, clientId),
            eq(prototypeOAuthRefreshAncestor.userId, userId),
            eq(prototypeOAuthRefreshAncestor.authorizationCodeId, authorizationCodeId),
          ),
        );
    },
    detachOfflineGrant: (refreshToken, accessTokenHash) =>
      detachPrototypeOfflineGrant(database, refreshToken, accessTokenHash),
  };
}

/**
 * Opt-in BA-01 glue. Call only inside the serialized request transaction in
 * oauth-transaction.ts; that global lock stands in for the production fence.
 */
export function prototypeOAuthFamilyGuard(database: PrototypeDatabase): BetterAuthPlugin {
  return {
    id: 'boardsesh-prototype-oauth-family',
    hooks: createRefreshFamilyHooks({
      store: prototypeFamilyStore(database),
      oauthOptions: PROTOTYPE_OAUTH_OPTIONS,
      acquireFamilyFence: async () => 'current',
      lockAccessTokenOwner: async () => undefined,
    }),
  };
}
