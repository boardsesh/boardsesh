import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { stripAccessTokenAuthorizationScheme } from 'better-auth/oauth2';
import { getOAuthProviderApi, type OAuthOptions } from '@better-auth/oauth-provider';
import { and, eq, isNull } from 'drizzle-orm';
import { oauthAccessToken, oauthRefreshAncestors, oauthRefreshToken } from '@boardsesh/db/schema/auth';
import { detachPartnerOfflineGrant } from './offline';
import { currentPartnerTransaction } from './transaction';

/** The fields of a refresh token this guard reads. Shared with the BA-01 prototype's tables. */
export interface RefreshTokenRecord {
  id: string;
  token: string;
  clientId: string;
  userId: string;
  authorizationCodeId: string | null;
  expiresAt: Date;
  revoked: Date | null;
  scopes: string[];
}

export interface RefreshAncestorRecord {
  tokenHash: string;
  clientId: string;
  userId: string;
  authorizationCodeId: string;
  expiresAt: Date;
  consumedAt: Date | null;
}

export interface AccessTokenOwner {
  clientId: string;
  userId: string | null;
}

export interface FamilyOwner {
  clientId: string;
  userId: string;
  authorizationCodeId: string;
}

/** Everything the guard reads and writes. Each backing store owns its own tables. */
export interface RefreshFamilyStore {
  findRefreshToken(tokenHash: string): Promise<RefreshTokenRecord | undefined>;
  findAncestor(tokenHash: string): Promise<RefreshAncestorRecord | undefined>;
  findAccessTokenOwner(tokenHash: string): Promise<AccessTokenOwner | undefined>;
  insertAncestorIfAbsent(ancestor: RefreshAncestorRecord): Promise<void>;
  markAncestorConsumed(tokenHash: string, consumedAt: Date): Promise<void>;
  closeFamily(owner: FamilyOwner): Promise<void>;
  detachOfflineGrant(refreshToken: RefreshTokenRecord, accessTokenHash: string): Promise<void>;
}

export interface RefreshFamilyGuardOptions {
  store: RefreshFamilyStore;
  oauthOptions: OAuthOptions<string[]>;
  /**
   * Called after the token's owner is known and before the guard trusts any
   * mutable state. Takes the connection lock and reports whether the grant is
   * still current. A reader that holds no lock of its own would race Disconnect.
   */
  acquireFamilyFence: (owner: FamilyOwner) => Promise<'current' | 'fenced'>;
  /** Called before access-token revocation: the provider still reads the row under this lock. */
  lockAccessTokenOwner: (owner: AccessTokenOwner) => Promise<void>;
}

function isRecord(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate);
}

async function rememberAncestor(store: RefreshFamilyStore, refreshToken: RefreshTokenRecord): Promise<void> {
  if (!refreshToken.authorizationCodeId) throw new Error('Refresh token is missing its grant lineage.');
  await store.insertAncestorIfAbsent({
    tokenHash: refreshToken.token,
    clientId: refreshToken.clientId,
    userId: refreshToken.userId,
    authorizationCodeId: refreshToken.authorizationCodeId,
    expiresAt: refreshToken.expiresAt,
    consumedAt: refreshToken.revoked,
  });
  const existing = await store.findAncestor(refreshToken.token);
  if (
    !existing ||
    existing.clientId !== refreshToken.clientId ||
    existing.userId !== refreshToken.userId ||
    existing.authorizationCodeId !== refreshToken.authorizationCodeId ||
    existing.expiresAt.getTime() !== refreshToken.expiresAt.getTime()
  ) {
    throw new Error('Conflicting immutable refresh lineage.');
  }
  if (refreshToken.revoked) await store.markAncestorConsumed(refreshToken.token, refreshToken.revoked);
}

/**
 * Better Auth 1.7.17 invalidates every grant for an app and climber when one
 * refresh token is reused. These hooks limit that to the original authorization
 * code's family. The provider's own client authentication runs first, and the
 * guard runs inside the request transaction.
 */
export function createRefreshFamilyHooks({
  store,
  oauthOptions,
  acquireFamilyFence,
  lockAccessTokenOwner,
}: RefreshFamilyGuardOptions): NonNullable<BetterAuthPlugin['hooks']> {
  return {
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

          const provider = getOAuthProviderApi(context, oauthOptions, isRefresh ? 'refresh_token' : undefined);
          const client = await provider.authenticateClient({ requireCredentials: false });
          const lookup = await provider.hashToken(presentedToken, 'refresh_token');

          // Owner fields never change, so reading them before the lock is safe.
          // An unknown value takes no lock, so strangers cannot queue on a connection.
          const refreshToken = await store.findRefreshToken(lookup);
          const ancestor = await store.findAncestor(lookup);
          const owner = refreshToken ?? ancestor;
          const refused = () =>
            context.json(isRefresh ? { error: 'invalid_grant', error_description: 'The grant has ended.' } : null, {
              status: isRefresh ? 400 : 200,
              headers: { 'cache-control': 'no-store' },
            });

          if (!owner) {
            if (!isRefresh) {
              const accessLookup = await provider.hashToken(presentedToken, 'access_token');
              const accessToken = await store.findAccessTokenOwner(accessLookup);
              if (accessToken) {
                if (accessToken.clientId === client.clientId) await lockAccessTokenOwner(accessToken);
                if (context.body?.token_type_hint === 'refresh_token') context.body.token_type_hint = 'access_token';
                return;
              }
              // RFC 7009 section 2.2: an unknown token is a success, and stock
              // 1.7.17 answers 400. The client has authenticated by this point.
              return refused();
            }
            return;
          }
          // RFC 7009's type is a lookup hint, not authority to skip other types.
          if (!isRefresh && context.body?.token_type_hint === 'access_token') {
            context.body.token_type_hint = 'refresh_token';
          }
          if (owner.clientId !== client.clientId) {
            // Stock 1.7.17's consumed-token revocation invalidates the supplied
            // client and climber before checking token ownership. Another
            // registered client must never reach that path.
            return refused();
          }
          // RFC 7009 treats an already-invalid token as a successful no-op. A
          // refresh with an expired token that was never used fails anyway, so it
          // must not take the climber's row lock to find that out. Read before the
          // lock, that is safe: an expired token can no longer be consumed, since
          // the provider refuses to refresh it and revoke stops above. An expired
          // token that was used still goes on to trip reuse, once, under the lock.
          const consumedBeforeLock = ancestor?.consumedAt ?? refreshToken?.revoked ?? null;
          if (owner.expiresAt < new Date() && (!isRefresh || consumedBeforeLock === null)) {
            return refused();
          }
          if (!owner.authorizationCodeId) {
            throw new APIError('BAD_REQUEST', { error: 'invalid_grant', error_description: 'Missing grant lineage.' });
          }

          const lineage: FamilyOwner = {
            clientId: owner.clientId,
            userId: owner.userId,
            authorizationCodeId: owner.authorizationCodeId,
          };
          if ((await acquireFamilyFence(lineage)) === 'fenced') return refused();

          // Read the consumption state again now the lock is held: a racing
          // rotation may have consumed this token while the guard waited.
          const currentRefreshToken = await store.findRefreshToken(lookup);
          const currentAncestor = await store.findAncestor(lookup);
          const consumedAt = currentAncestor?.consumedAt ?? currentRefreshToken?.revoked;
          if (!consumedAt) {
            // Stock 1.7.17 issues a successor that lacks offline_access if the
            // request drops it, and that successor then never rotates. Checked
            // after the reuse path so a narrowed scope cannot hide a replay.
            const requestedScope: unknown = context.body?.scope;
            if (
              isRefresh &&
              typeof requestedScope === 'string' &&
              !requestedScope.split(' ').includes('offline_access')
            ) {
              return context.json(
                { error: 'invalid_scope', error_description: 'A refresh must keep offline_access.' },
                { status: 400, headers: { 'cache-control': 'no-store' } },
              );
            }
            return;
          }

          await store.closeFamily(lineage);
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
          const provider = getOAuthProviderApi(context, oauthOptions);
          const issuedHash = await provider.hashToken(tokenResponse.refresh_token, 'refresh_token');
          const issued = await store.findRefreshToken(issuedHash);
          if (!issued) throw new Error('Issued refresh token is missing.');
          if (issued.scopes.includes('offline_access')) {
            if (typeof tokenResponse.access_token !== 'string') throw new Error('Issued access token is missing.');
            const accessTokenHash = await provider.hashToken(tokenResponse.access_token, 'access_token');
            await store.detachOfflineGrant(issued, accessTokenHash);
          }
          await rememberAncestor(store, issued);

          if (context.body?.grant_type === 'refresh_token' && typeof context.body.refresh_token === 'string') {
            const consumedHash = await provider.hashToken(context.body.refresh_token, 'refresh_token');
            const consumed = await store.findRefreshToken(consumedHash);
            if (!consumed || !consumed.revoked) throw new Error('Consumed refresh token is missing.');
            await rememberAncestor(store, consumed);
          }
        }),
      },
    ],
  };
}

/** The partner store. Every call resolves the request's transaction, so the guard shares its locks. */
export function createPartnerFamilyStore(): RefreshFamilyStore {
  const database = () => currentPartnerTransaction().transaction;
  return {
    async findRefreshToken(tokenHash) {
      const [refreshToken] = await database()
        .select()
        .from(oauthRefreshToken)
        .where(eq(oauthRefreshToken.token, tokenHash));
      return refreshToken;
    },
    async findAncestor(tokenHash) {
      const [ancestor] = await database()
        .select()
        .from(oauthRefreshAncestors)
        .where(eq(oauthRefreshAncestors.tokenHash, tokenHash));
      return ancestor;
    },
    async findAccessTokenOwner(tokenHash) {
      const [accessToken] = await database()
        .select({ clientId: oauthAccessToken.clientId, userId: oauthAccessToken.userId })
        .from(oauthAccessToken)
        .where(eq(oauthAccessToken.token, tokenHash));
      return accessToken;
    },
    async insertAncestorIfAbsent(ancestor) {
      await database().insert(oauthRefreshAncestors).values(ancestor).onConflictDoNothing();
    },
    async markAncestorConsumed(tokenHash, consumedAt) {
      await database()
        .update(oauthRefreshAncestors)
        .set({ consumedAt })
        .where(and(eq(oauthRefreshAncestors.tokenHash, tokenHash), isNull(oauthRefreshAncestors.consumedAt)));
    },
    async closeFamily({ clientId, userId, authorizationCodeId }) {
      await database()
        .delete(oauthAccessToken)
        .where(
          and(
            eq(oauthAccessToken.clientId, clientId),
            eq(oauthAccessToken.userId, userId),
            eq(oauthAccessToken.authorizationCodeId, authorizationCodeId),
          ),
        );
      await database()
        .delete(oauthRefreshToken)
        .where(
          and(
            eq(oauthRefreshToken.clientId, clientId),
            eq(oauthRefreshToken.userId, userId),
            eq(oauthRefreshToken.authorizationCodeId, authorizationCodeId),
          ),
        );
      // The family is now closed, so forgetting its ancestry cannot leave a
      // live descendant behind. Expiry alone never triggers this delete.
      await database()
        .delete(oauthRefreshAncestors)
        .where(
          and(
            eq(oauthRefreshAncestors.clientId, clientId),
            eq(oauthRefreshAncestors.userId, userId),
            eq(oauthRefreshAncestors.authorizationCodeId, authorizationCodeId),
          ),
        );
    },
    async detachOfflineGrant(refreshToken, accessTokenHash) {
      await detachPartnerOfflineGrant(database(), refreshToken, accessTokenHash);
    },
  };
}
