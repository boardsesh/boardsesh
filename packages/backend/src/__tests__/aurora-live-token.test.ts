import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { and, eq } from 'drizzle-orm';
import { encrypt, decrypt } from '@boardsesh/crypto';
import { AuroraClimbingClient } from '@boardsesh/aurora-sync/api';
import { auroraCredentials, providerSyncControls, users } from '@boardsesh/db/schema';
import { db } from '../db/client';
import {
  AuroraLiveCredentialChangedError,
  getAuroraLiveToken,
  type AuroraLiveCredentialBinding,
} from '../services/aurora-live-token';

let userId: string;
let binding: AuroraLiveCredentialBinding;
const signal = () => new AbortController().signal;
beforeEach(async () => {
  vi.stubEnv('AURORA_CREDENTIALS_SECRET', 'aurora-live-test-only-key');
  userId = randomUUID();
  await db.insert(users).values({ id: userId, email: `${userId}@aurora-live.test` });
  const [control] = await db.insert(providerSyncControls).values({ userId, boardType: 'tension' }).returning();
  const [credential] = await db
    .insert(auroraCredentials)
    .values({
      userId,
      boardType: 'tension',
      auroraUserId: 42,
      encryptedUsername: encrypt('fixture'),
      encryptedPassword: encrypt('fixture-password'),
      auroraToken: encrypt('stored-session'),
    })
    .returning();
  binding = { credentialId: credential.id, upstreamUserId: 42, linkGeneration: control.linkGeneration };
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('Aurora live credential fencing', () => {
  it('borrows a stored matching-board session without logging in', async () => {
    const login = vi.spyOn(AuroraClimbingClient.prototype, 'signIn');
    expect(await getAuroraLiveToken(userId, 'tension', binding, signal())).toBe('stored-session');
    expect(login).not.toHaveBeenCalled();
  });
  it('serializes two rejected-token refreshes and reuses the first replacement', async () => {
    const login = vi
      .spyOn(AuroraClimbingClient.prototype, 'signIn')
      .mockResolvedValue({ token: 'new-session', user_id: 42 });
    const tokens = await Promise.all([
      getAuroraLiveToken(userId, 'tension', binding, signal(), 'stored-session'),
      getAuroraLiveToken(userId, 'tension', binding, signal(), 'stored-session'),
    ]);
    expect(tokens).toEqual(['new-session', 'new-session']);
    expect(login).toHaveBeenCalledOnce();
    const [stored] = await db.select().from(auroraCredentials).where(eq(auroraCredentials.id, binding.credentialId));
    expect(decrypt(stored.auroraToken!)).toBe('new-session');
  });
  it('refuses a relink generation without using its new account session', async () => {
    await db
      .update(providerSyncControls)
      .set({ linkGeneration: randomUUID() })
      .where(and(eq(providerSyncControls.userId, userId), eq(providerSyncControls.boardType, 'tension')));
    const login = vi.spyOn(AuroraClimbingClient.prototype, 'signIn');
    await expect(getAuroraLiveToken(userId, 'tension', binding, signal())).rejects.toBeInstanceOf(
      AuroraLiveCredentialChangedError,
    );
    expect(login).not.toHaveBeenCalled();
  });
  it('does not store a login response for a different upstream identity', async () => {
    vi.spyOn(AuroraClimbingClient.prototype, 'signIn').mockResolvedValue({ token: 'foreign-session', user_id: 999 });
    await expect(getAuroraLiveToken(userId, 'tension', binding, signal(), 'stored-session')).rejects.toBeInstanceOf(
      AuroraLiveCredentialChangedError,
    );
    const [stored] = await db.select().from(auroraCredentials).where(eq(auroraCredentials.id, binding.credentialId));
    expect(decrypt(stored.auroraToken!)).toBe('stored-session');
  });
  it('does not use Tension credentials for a different board product', async () => {
    await expect(getAuroraLiveToken(userId, 'decoy', binding, signal())).rejects.toBeInstanceOf(
      AuroraLiveCredentialChangedError,
    );
  });
  it('rolls back a replacement session when the request was cancelled during login', async () => {
    const controller = new AbortController();
    vi.spyOn(AuroraClimbingClient.prototype, 'signIn').mockImplementation(async () => {
      controller.abort();
      return { token: 'cancelled-session', user_id: 42 };
    });
    await expect(getAuroraLiveToken(userId, 'tension', binding, controller.signal, 'stored-session')).rejects.toThrow();
    const [stored] = await db.select().from(auroraCredentials).where(eq(auroraCredentials.id, binding.credentialId));
    expect(decrypt(stored.auroraToken!)).toBe('stored-session');
  });
});
