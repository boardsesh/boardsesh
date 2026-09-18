import { and, eq } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { auroraCredentials } from '@boardsesh/db/schema';
import { decrypt, encrypt } from '@boardsesh/crypto';
import { refreshAccessToken, type KeycloakClientConfig } from './keycloak';
import { KilterApiError } from './errors';

type CredentialDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;
const tokenCaches = new WeakMap<
  CredentialDb,
  Map<string, { ciphertext: string; accessToken: string; expiresAt: number }>
>();

/** All stored-token consumers lock the same row before reading rotating credentials. */
export async function getStoredKilterAccessToken(
  db: CredentialDb,
  userId: string,
  client: KeycloakClientConfig,
  forceRefresh = false,
): Promise<string> {
  let cachedTokens = tokenCaches.get(db);
  if (!cachedTokens) {
    cachedTokens = new Map();
    tokenCaches.set(db, cachedTokens);
  }
  return db.transaction(async (transaction) => {
    const [credential] = await transaction
      .select()
      .from(auroraCredentials)
      .where(and(eq(auroraCredentials.userId, userId), eq(auroraCredentials.boardType, 'kilter')))
      .for('update')
      .limit(1);
    if (!credential?.encryptedRefreshToken || !['pending', 'active', 'error'].includes(credential.syncStatus)) {
      cachedTokens.delete(userId);
      throw new KilterApiError('invalid_grant', 'Kilter account must be linked again');
    }
    const cached = cachedTokens.get(userId);
    if (!forceRefresh && cached?.ciphertext === credential.encryptedRefreshToken && cached.expiresAt > Date.now()) {
      return cached.accessToken;
    }
    const refreshToken = decrypt(credential.encryptedRefreshToken);
    const tokens = await refreshAccessToken({ refreshToken, client });
    const rotated = tokens.refresh_token && tokens.refresh_token !== refreshToken;
    const ciphertext = rotated ? encrypt(tokens.refresh_token!) : credential.encryptedRefreshToken;
    if (rotated) {
      await transaction
        .update(auroraCredentials)
        .set({ encryptedRefreshToken: ciphertext, updatedAt: new Date() })
        .where(eq(auroraCredentials.id, credential.id));
    }
    // Keep the cache bounded even if many one-off viewers connect.
    for (const [cachedUserId, cachedToken] of cachedTokens) {
      if (cachedToken.expiresAt <= Date.now()) cachedTokens.delete(cachedUserId);
    }
    cachedTokens.set(userId, {
      ciphertext,
      accessToken: tokens.access_token,
      expiresAt: Date.now() + Math.max(0, tokens.expires_in - 60) * 1000,
    });
    return tokens.access_token;
  });
}
