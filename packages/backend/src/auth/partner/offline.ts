import { and, eq } from 'drizzle-orm';
import { oauthAccessToken, oauthRefreshToken } from '@boardsesh/db/schema/auth';
import type { RefreshTokenRecord } from './family-guard';
import type { PartnerDatabase } from './tables';

/**
 * An offline grant must outlive the browser session it was approved in, so its
 * tokens stop naming that session once issued. Reset, Disconnect and deletion
 * still end them through the connection and user. Runs only inside the request
 * transaction, after the provider has verified the session and approved scopes.
 */
export async function detachPartnerOfflineGrant(
  database: PartnerDatabase,
  refreshToken: RefreshTokenRecord,
  accessTokenHash: string,
): Promise<void> {
  if (!refreshToken.scopes.includes('offline_access')) return;
  if (!refreshToken.authorizationCodeId) throw new Error('Offline grant is missing its authorization code.');
  const detached = await database
    .update(oauthAccessToken)
    .set({ sessionId: null })
    .where(
      and(
        eq(oauthAccessToken.token, accessTokenHash),
        eq(oauthAccessToken.clientId, refreshToken.clientId),
        eq(oauthAccessToken.userId, refreshToken.userId),
        eq(oauthAccessToken.authorizationCodeId, refreshToken.authorizationCodeId),
        eq(oauthAccessToken.refreshId, refreshToken.id),
      ),
    )
    .returning({ id: oauthAccessToken.id });
  if (detached.length !== 1) throw new Error('Offline grant has no matching issued access token.');
  await database.update(oauthRefreshToken).set({ sessionId: null }).where(eq(oauthRefreshToken.id, refreshToken.id));
}
