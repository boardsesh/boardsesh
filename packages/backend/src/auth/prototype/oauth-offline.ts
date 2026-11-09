import { and, eq } from 'drizzle-orm';
import { oauthAccessToken, oauthRefreshToken } from '@boardsesh/db/auth-prototype';
import type { RefreshTokenRecord } from '../partner/family-guard';
import type { PrototypeDatabase } from './authority';

/**
 * Opt-in disposable policy after provider issuance has verified the original
 * session and approved scopes. Offline grants outlive that browser session;
 * reset, Disconnect and deletion still revoke their canonical user/connection.
 * Call only within the guarded request transaction, never as a background hook.
 */
export async function detachPrototypeOfflineGrant(
  database: PrototypeDatabase,
  refreshToken: RefreshTokenRecord,
  accessTokenHash: string,
): Promise<void> {
  if (!refreshToken.scopes.includes('offline_access')) return;
  if (!refreshToken.authorizationCodeId) throw new Error('Missing offline prototype grant lineage.');
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
  if (detached.length !== 1) throw new Error('Missing matching issued prototype offline access token.');
  await database.update(oauthRefreshToken).set({ sessionId: null }).where(eq(oauthRefreshToken.id, refreshToken.id));
}
