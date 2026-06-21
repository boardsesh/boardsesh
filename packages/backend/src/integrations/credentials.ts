// Credential persistence + token-refresh lifecycle for integration providers.
// Tokens are encrypted at rest with @boardsesh/crypto; this module is the only
// place that decrypts them.

import { and, eq } from 'drizzle-orm';
import { db } from '../db/client';
import { integrationCredentials } from '@boardsesh/db/schema';
import { encrypt, decrypt } from '@boardsesh/crypto';
import { getProvider, type ProviderName } from './registry';
import { IntegrationHttpError } from './strava';
import type { ProviderTokens } from './types';
import { logger } from '../utils/logger';

export type IntegrationCredentialRow = typeof integrationCredentials.$inferSelect;

/** Refresh the access token when it expires within this window. */
const TOKEN_REFRESH_LEEWAY_MS = 5 * 60 * 1000;

function isTokenFresh(row: IntegrationCredentialRow): boolean {
  return !!row.tokenExpiresAt && row.tokenExpiresAt.getTime() >= Date.now() + TOKEN_REFRESH_LEEWAY_MS;
}

async function loadCredentialById(credId: bigint): Promise<IntegrationCredentialRow | null> {
  const [row] = await db.select().from(integrationCredentials).where(eq(integrationCredentials.id, credId)).limit(1);
  return row ?? null;
}

export async function upsertCredential(userId: string, provider: ProviderName, tokens: ProviderTokens): Promise<void> {
  const now = new Date();
  const values = {
    userId,
    provider,
    encryptedAccessToken: encrypt(tokens.accessToken),
    encryptedRefreshToken: encrypt(tokens.refreshToken),
    tokenExpiresAt: tokens.expiresAt,
    externalAccountId: tokens.externalAccountId || null,
    externalAccountName: tokens.externalAccountName,
    scopes: tokens.scopes,
    status: 'active' as const,
    lastError: null,
    updatedAt: now,
  };

  await db
    .insert(integrationCredentials)
    .values(values)
    .onConflictDoUpdate({
      target: [integrationCredentials.userId, integrationCredentials.provider],
      set: {
        encryptedAccessToken: values.encryptedAccessToken,
        encryptedRefreshToken: values.encryptedRefreshToken,
        tokenExpiresAt: values.tokenExpiresAt,
        externalAccountId: values.externalAccountId,
        externalAccountName: values.externalAccountName,
        scopes: values.scopes,
        status: values.status,
        lastError: values.lastError,
        updatedAt: values.updatedAt,
      },
    });
}

/**
 * Return a usable access token for a credential row, refreshing it first when
 * it is missing an expiry or about to expire. A rotated refresh token is
 * persisted (encrypted) before the new access token is returned.
 *
 * Concurrency: the caller's row may be stale by the time this runs (e.g. two
 * sessions ending near-simultaneously for the same user), so the row is
 * re-read at entry, the persist is an optimistic update conditioned on the
 * exact refresh-token ciphertext we read (a concurrent refresh changes it),
 * and a 400/401 refresh failure re-checks for a concurrent winner before
 * concluding the credential is dead — the failure may just mean another
 * request already used (and rotated) the refresh token we tried.
 *
 * On a genuine 400/401 refresh failure the credential is marked 'expired' and
 * the error rethrown so callers can surface a re-connect prompt.
 */
export async function getFreshAccessToken(credRow: IntegrationCredentialRow): Promise<string> {
  const current = (await loadCredentialById(credRow.id)) ?? credRow;
  if (!current.encryptedAccessToken || !current.encryptedRefreshToken) {
    throw new Error('Integration credential is missing stored tokens');
  }

  if (isTokenFresh(current)) {
    return decrypt(current.encryptedAccessToken);
  }

  const provider = getProvider(current.provider);
  if (!provider) {
    throw new Error(`Unsupported integration provider: ${current.provider}`);
  }

  const refreshTokenCiphertext = current.encryptedRefreshToken;
  const refreshToken = decrypt(refreshTokenCiphertext);
  try {
    const refreshed = await provider.refreshTokens(refreshToken);
    // Optimistic lock on the stored ciphertext: if a concurrent refresh
    // already persisted a rotation, leave its (newer) tokens in place rather
    // than clobbering them — ours is still valid to use for this request.
    await db
      .update(integrationCredentials)
      .set({
        encryptedAccessToken: encrypt(refreshed.accessToken),
        encryptedRefreshToken: encrypt(refreshed.refreshToken),
        tokenExpiresAt: refreshed.expiresAt,
        status: 'active',
        lastError: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(integrationCredentials.id, current.id),
          eq(integrationCredentials.encryptedRefreshToken, refreshTokenCiphertext),
        ),
      );
    return refreshed.accessToken;
  } catch (error) {
    const statusCode = error instanceof IntegrationHttpError ? error.statusCode : null;
    if (statusCode === 400 || statusCode === 401) {
      // A concurrent request may have refreshed (rotating the token we just
      // tried) between our read and the provider call — its tokens are good.
      const winner = await loadCredentialById(current.id);
      if (winner && winner.encryptedAccessToken && winner.encryptedRefreshToken !== refreshTokenCiphertext) {
        return decrypt(winner.encryptedAccessToken);
      }
      await db
        .update(integrationCredentials)
        .set({
          status: 'expired',
          lastError: error instanceof Error ? error.message : 'Token refresh failed',
          updatedAt: new Date(),
        })
        .where(eq(integrationCredentials.id, current.id));
    }
    throw error;
  }
}

/**
 * Disconnect a provider: best-effort revoke at the provider, then delete the
 * local row. Returns true when a row was deleted.
 */
export async function disconnect(userId: string, provider: ProviderName): Promise<boolean> {
  const [credRow] = await db
    .select()
    .from(integrationCredentials)
    .where(and(eq(integrationCredentials.userId, userId), eq(integrationCredentials.provider, provider)))
    .limit(1);

  if (!credRow) {
    return false;
  }

  // Revoke is best-effort — a network failure or already-revoked token must
  // not prevent the local disconnect.
  if (credRow.encryptedAccessToken) {
    const providerImpl = getProvider(provider);
    if (providerImpl) {
      try {
        await providerImpl.revoke(decrypt(credRow.encryptedAccessToken));
      } catch (error) {
        logger.warn(`[Integrations] revoke failed for ${provider} user ${userId}:`, error);
      }
    }
  }

  await db.delete(integrationCredentials).where(eq(integrationCredentials.id, credRow.id));
  return true;
}

/**
 * Toggle auto-sync for an existing credential. Returns the updated row, or null
 * when no credential exists yet (the resolver turns that into an error).
 */
export async function setAutoSync(
  userId: string,
  provider: ProviderName,
  enabled: boolean,
): Promise<IntegrationCredentialRow | null> {
  const updated = await db
    .update(integrationCredentials)
    .set({ autoSyncEnabled: enabled, updatedAt: new Date() })
    .where(and(eq(integrationCredentials.userId, userId), eq(integrationCredentials.provider, provider)))
    .returning();

  return updated[0] ?? null;
}

export async function recordSyncSuccess(credId: bigint): Promise<void> {
  await db
    .update(integrationCredentials)
    .set({ lastSyncAt: new Date(), updatedAt: new Date() })
    .where(eq(integrationCredentials.id, credId));
}
