import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { eq } from 'drizzle-orm';
import { encrypt, decrypt } from '@boardsesh/crypto';
import { auroraCredentials } from '@boardsesh/db/schema';
import { getStoredKilterAccessToken } from '@boardsesh/kilter-sync/api';
import { db } from '../db/client';

beforeEach(async () => {
  vi.stubEnv('AURORA_CREDENTIALS_SECRET', 'kilter-live-token-test-only');
  await db.delete(auroraCredentials).where(eq(auroraCredentials.userId, 'user-123'));
  await db
    .insert(auroraCredentials)
    .values({ userId: 'user-123', boardType: 'kilter', encryptedRefreshToken: encrypt('refresh-original') });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('stored Kilter refresh-token coordination', () => {
  it('serializes concurrent refreshes and persists rotation before the next reader', async () => {
    const refreshTokens: string[] = [];
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(init?.body).toBeInstanceOf(URLSearchParams);
      refreshTokens.push((init!.body as URLSearchParams).get('refresh_token')!);
      const iteration = refreshTokens.length;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return new Response(
        JSON.stringify({
          access_token: `access-${iteration}`,
          refresh_token: `refresh-${iteration}`,
          expires_in: 300,
          token_type: 'Bearer',
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const tokens = await Promise.all([
      getStoredKilterAccessToken(db, 'user-123', { clientId: 'kilter' }, true),
      getStoredKilterAccessToken(db, 'user-123', { clientId: 'kilter' }, true),
    ]);
    expect(tokens).toEqual(['access-1', 'access-2']);
    expect(refreshTokens).toEqual(['refresh-original', 'refresh-1']);
    const [stored] = await db.select().from(auroraCredentials).where(eq(auroraCredentials.userId, 'user-123'));
    expect(decrypt(stored.encryptedRefreshToken!)).toBe('refresh-2');
    expect(await getStoredKilterAccessToken(db, 'user-123', { clientId: 'kilter' })).toBe('access-2');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await db.delete(auroraCredentials).where(eq(auroraCredentials.userId, 'user-123'));
    await expect(getStoredKilterAccessToken(db, 'user-123', { clientId: 'kilter' })).rejects.toMatchObject({
      code: 'invalid_grant',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
