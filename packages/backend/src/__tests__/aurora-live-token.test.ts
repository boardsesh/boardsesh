import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { and, eq } from 'drizzle-orm';
import { encrypt, decrypt } from '@boardsesh/crypto';
import { AuroraClimbingClient, AuroraRequestError } from '@boardsesh/aurora-sync/api';
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

  it('releases transaction locks while login waits and refuses an in-flight relink', async () => {
    let finishLogin: (session: { token: string; user_id: number }) => void = () => {};
    const login = vi.spyOn(AuroraClimbingClient.prototype, 'signIn').mockImplementation(
      () =>
        new Promise((resolve) => {
          finishLogin = resolve;
        }),
    );
    const pending = getAuroraLiveToken(userId, 'tension', binding, signal(), 'stored-session');
    // Attach rejection handling before allowing the deliberately stale response.
    const refused = expect(pending).rejects.toBeInstanceOf(AuroraLiveCredentialChangedError);
    await vi.waitFor(() => expect(login).toHaveBeenCalledOnce());
    const replacementGeneration = randomUUID();
    const relink = db.transaction(async (transaction) => {
      await transaction
        .update(providerSyncControls)
        .set({ linkGeneration: replacementGeneration })
        .where(and(eq(providerSyncControls.userId, userId), eq(providerSyncControls.boardType, 'tension')));
      await transaction
        .update(auroraCredentials)
        .set({ auroraToken: encrypt('relinked-session') })
        .where(eq(auroraCredentials.id, binding.credentialId));
    });
    // This commit must finish before the outstanding HTTP response is released.
    await expect(
      Promise.race([
        relink.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1000)),
      ]),
    ).resolves.toBe(true);
    finishLogin({ token: 'old-link-response', user_id: 42 });
    await refused;
    const [stored] = await db.select().from(auroraCredentials).where(eq(auroraCredentials.id, binding.credentialId));
    expect(decrypt(stored.auroraToken!)).toBe('relinked-session');
  });

  it.each([false, true])('uses a concurrent stored-token winner after login refusal=%s', async (refusedLogin) => {
    const rejection = new AuroraRequestError({ code: 'invalid_credentials', message: 'Refused password', status: 422 });
    vi.spyOn(AuroraClimbingClient.prototype, 'signIn').mockImplementation(async () => {
      // A different instance or sync writer wins while our HTTP request is pending.
      await db
        .update(auroraCredentials)
        .set({ auroraToken: encrypt('winner-session') })
        .where(eq(auroraCredentials.id, binding.credentialId));
      if (refusedLogin) throw rejection;
      return { token: 'losing-session', user_id: 42 };
    });
    expect(await getAuroraLiveToken(userId, 'tension', binding, signal(), 'stored-session')).toBe('winner-session');
    const [stored] = await db.select().from(auroraCredentials).where(eq(auroraCredentials.id, binding.credentialId));
    expect(stored.syncStatus).not.toBe('expired');
    expect(decrypt(stored.auroraToken!)).toBe('winner-session');
  });

  it('keeps the first refusal retryable and expires the second until the account is relinked', async () => {
    const login = vi
      .spyOn(AuroraClimbingClient.prototype, 'signIn')
      .mockRejectedValue(
        new AuroraRequestError({ code: 'invalid_credentials', message: 'Refused password', status: 422 }),
      );
    await expect(getAuroraLiveToken(userId, 'tension', binding, signal(), 'stored-session')).rejects.toMatchObject({
      code: 'invalid_credentials',
    });
    const [firstRefusal] = await db
      .select()
      .from(auroraCredentials)
      .where(eq(auroraCredentials.id, binding.credentialId));
    const [firstControl] = await db
      .select()
      .from(providerSyncControls)
      .where(and(eq(providerSyncControls.userId, userId), eq(providerSyncControls.boardType, 'tension')));
    expect(firstRefusal.syncStatus).toBe('error');
    expect(firstRefusal.credentialFailureCount).toBe(1);
    expect(decrypt(firstRefusal.auroraToken!)).toBe('stored-session');
    expect(firstControl.linkGeneration).toBe(binding.linkGeneration);
    await expect(getAuroraLiveToken(userId, 'tension', binding, signal(), 'stored-session')).rejects.toMatchObject({
      code: 'invalid_credentials',
    });
    const [refused] = await db.select().from(auroraCredentials).where(eq(auroraCredentials.id, binding.credentialId));
    const [control] = await db
      .select()
      .from(providerSyncControls)
      .where(and(eq(providerSyncControls.userId, userId), eq(providerSyncControls.boardType, 'tension')));
    expect(refused.syncStatus).toBe('expired');
    expect(refused.credentialFailureCount).toBe(2);
    expect(refused.auroraToken).toBeNull();
    expect(control.linked).toBe(true);
    expect(control.linkGeneration).not.toBe(binding.linkGeneration);
    // A fresh call, including a reader that observed the new fence, cannot retry the password.
    await expect(getAuroraLiveToken(userId, 'tension', binding, signal())).rejects.toBeInstanceOf(
      AuroraLiveCredentialChangedError,
    );
    await expect(
      getAuroraLiveToken(userId, 'tension', { ...binding, linkGeneration: control.linkGeneration }, signal()),
    ).rejects.toBeInstanceOf(AuroraLiveCredentialChangedError);
    expect(login).toHaveBeenCalledTimes(2);
    const relinkGeneration = randomUUID();
    await db.transaction(async (transaction) => {
      await transaction
        .update(providerSyncControls)
        .set({ linkGeneration: relinkGeneration })
        .where(and(eq(providerSyncControls.userId, userId), eq(providerSyncControls.boardType, 'tension')));
      await transaction
        .update(auroraCredentials)
        .set({ syncStatus: 'pending', auroraToken: encrypt('relinked-session'), syncError: null })
        .where(eq(auroraCredentials.id, binding.credentialId));
    });
    expect(
      await getAuroraLiveToken(userId, 'tension', { ...binding, linkGeneration: relinkGeneration }, signal()),
    ).toBe('relinked-session');
    expect(login).toHaveBeenCalledTimes(2);
  });

  it('does not expire a replacement account when the old login is refused during relink', async () => {
    vi.spyOn(AuroraClimbingClient.prototype, 'signIn').mockImplementation(async () => {
      await db.transaction(async (transaction) => {
        await transaction
          .update(providerSyncControls)
          .set({ linkGeneration: randomUUID() })
          .where(and(eq(providerSyncControls.userId, userId), eq(providerSyncControls.boardType, 'tension')));
        await transaction
          .update(auroraCredentials)
          .set({ auroraToken: encrypt('replacement-session') })
          .where(eq(auroraCredentials.id, binding.credentialId));
      });
      throw new AuroraRequestError({ code: 'invalid_credentials', message: 'Refused password', status: 422 });
    });
    await expect(getAuroraLiveToken(userId, 'tension', binding, signal(), 'stored-session')).rejects.toBeInstanceOf(
      AuroraLiveCredentialChangedError,
    );
    const [stored] = await db.select().from(auroraCredentials).where(eq(auroraCredentials.id, binding.credentialId));
    expect(stored.syncStatus).not.toBe('expired');
    expect(decrypt(stored.auroraToken!)).toBe('replacement-session');
  });

  it.each([0, 1])('fences a legacy refusal when the initial failure count was %i', async (initialFailures) => {
    await db
      .delete(providerSyncControls)
      .where(and(eq(providerSyncControls.userId, userId), eq(providerSyncControls.boardType, 'tension')));
    const legacyBinding = { ...binding, linkGeneration: null };
    await db
      .update(auroraCredentials)
      .set({ credentialFailureCount: initialFailures })
      .where(eq(auroraCredentials.id, binding.credentialId));
    const login = vi.spyOn(AuroraClimbingClient.prototype, 'signIn').mockImplementation(async () => {
      // Another instance can record its refusal while our HTTP login waits.
      await db
        .update(auroraCredentials)
        .set({ credentialFailureCount: 1 })
        .where(eq(auroraCredentials.id, binding.credentialId));
      throw new AuroraRequestError({ code: 'invalid_credentials', message: 'Refused legacy password', status: 422 });
    });
    await expect(
      getAuroraLiveToken(userId, 'tension', legacyBinding, signal(), 'stored-session'),
    ).rejects.toMatchObject({ code: 'invalid_credentials' });
    const [control] = await db
      .select()
      .from(providerSyncControls)
      .where(and(eq(providerSyncControls.userId, userId), eq(providerSyncControls.boardType, 'tension')));
    const [stored] = await db.select().from(auroraCredentials).where(eq(auroraCredentials.id, binding.credentialId));
    expect(control.linked).toBe(true);
    expect(control.linkGeneration).toBeTypeOf('string');
    expect(stored.syncStatus).toBe('expired');
    await expect(getAuroraLiveToken(userId, 'tension', legacyBinding, signal())).rejects.toBeInstanceOf(
      AuroraLiveCredentialChangedError,
    );
    expect(login).toHaveBeenCalledOnce();
  });

  it('resets consecutive refusals after a successful refreshed login', async () => {
    const refusal = new AuroraRequestError({ code: 'invalid_credentials', message: 'Refused login', status: 422 });
    const login = vi
      .spyOn(AuroraClimbingClient.prototype, 'signIn')
      .mockRejectedValueOnce(refusal)
      .mockResolvedValueOnce({ token: 'recovered-session', user_id: 42 })
      .mockRejectedValueOnce(refusal);
    await expect(getAuroraLiveToken(userId, 'tension', binding, signal(), 'stored-session')).rejects.toThrow(refusal);
    expect(await getAuroraLiveToken(userId, 'tension', binding, signal(), 'stored-session')).toBe('recovered-session');
    const [recovered] = await db.select().from(auroraCredentials).where(eq(auroraCredentials.id, binding.credentialId));
    expect(recovered.credentialFailureCount).toBe(0);
    expect(recovered.lastCredentialFailureAt).toBeNull();
    await expect(getAuroraLiveToken(userId, 'tension', binding, signal(), 'recovered-session')).rejects.toThrow(
      refusal,
    );
    const [retryable] = await db.select().from(auroraCredentials).where(eq(auroraCredentials.id, binding.credentialId));
    expect(retryable.syncStatus).toBe('error');
    expect(retryable.credentialFailureCount).toBe(1);
    expect(login).toHaveBeenCalledTimes(3);
  });
});
