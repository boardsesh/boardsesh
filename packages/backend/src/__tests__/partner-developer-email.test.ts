import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vite-plus/test';
import { users, partnerDeveloperEmails } from '@boardsesh/db/schema/auth';
import { db } from '../db/client';
import {
  confirmPartnerDeveloperEmail,
  hasVerifiedPartnerDeveloperEmail,
  PARTNER_EMAIL_PROOF_LIFETIME_MS,
  requestPartnerDeveloperEmail,
} from '../auth/partner/developer-email';
import type { PartnerDatabase } from '../auth/partner/tables';

const database = db as unknown as PartnerDatabase;
async function account(emailVerified: Date | null = null) {
  const userId = `partner-proof-${randomUUID()}`;
  await db.insert(users).values({ id: userId, email: `${userId}@example.com`, emailVerified });
  return userId;
}
async function challenge(userId: string) {
  let token = '';
  await requestPartnerDeveloperEmail(database, userId, async (_email, rawToken) => {
    token = rawToken;
  });
  return token;
}

describe('independent partner developer email proof', () => {
  it('never trusts or writes the legacy verification flag; stores a hash and consumes once', async () => {
    const userId = await account();
    const token = await challenge(userId);
    const [stored] = await db.select().from(partnerDeveloperEmails).where(eq(partnerDeveloperEmails.userId, userId));
    expect(stored.tokenHash).not.toBe(token);
    expect(stored.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.expiresAt!.getTime() - stored.requestedAt.getTime()).toBe(PARTNER_EMAIL_PROOF_LIFETIME_MS);
    expect(await hasVerifiedPartnerDeveloperEmail(database, userId)).toBe(false);
    expect(await confirmPartnerDeveloperEmail(database, userId, token)).toBe(true);
    expect(await confirmPartnerDeveloperEmail(database, userId, token)).toBe(false);
    expect(await hasVerifiedPartnerDeveloperEmail(database, userId)).toBe(true);
    const [unchanged] = await db.select({ emailVerified: users.emailVerified }).from(users).where(eq(users.id, userId));
    expect(unchanged.emailVerified).toBeNull();
  });

  it('binds to the current account and exact email, even when legacy verified is set', async () => {
    const userId = await account(new Date());
    const otherUserId = await account(new Date());
    expect(await hasVerifiedPartnerDeveloperEmail(database, userId)).toBe(false);
    const token = await challenge(userId);
    expect(await confirmPartnerDeveloperEmail(database, otherUserId, token)).toBe(false);
    await db
      .update(users)
      .set({ email: `changed-${userId}@example.com` })
      .where(eq(users.id, userId));
    expect(await confirmPartnerDeveloperEmail(database, userId, token)).toBe(false);
    expect(await hasVerifiedPartnerDeveloperEmail(database, userId)).toBe(false);
  });

  it('preserves current-email proof when stale tabs resend concurrently, without sending mail', async () => {
    const userId = await account();
    const token = await challenge(userId);
    expect(await confirmPartnerDeveloperEmail(database, userId, token)).toBe(true);
    const [verified] = await db.select().from(partnerDeveloperEmails).where(eq(partnerDeveloperEmails.userId, userId));
    const notify = vi.fn().mockResolvedValue(undefined);
    await Promise.all(Array.from({ length: 4 }, () => requestPartnerDeveloperEmail(database, userId, notify)));
    expect(notify).not.toHaveBeenCalled();
    expect(await hasVerifiedPartnerDeveloperEmail(database, userId)).toBe(true);
    const [retained] = await db.select().from(partnerDeveloperEmails).where(eq(partnerDeveloperEmails.userId, userId));
    expect(retained).toEqual(verified);
  });

  it('locks the proof row before deciding whether to replace a challenge', async () => {
    const lockProof = vi.fn().mockResolvedValue([
      {
        email: 'owner@example.com',
        requestedAt: new Date(),
        verifiedAt: new Date(),
      },
    ]);
    const lockAccount = vi.fn().mockResolvedValue([{ email: 'owner@example.com' }]);
    const transaction = {
      select: vi
        .fn()
        .mockReturnValueOnce({ from: () => ({ where: () => ({ for: lockAccount }) }) })
        .mockReturnValueOnce({ from: () => ({ where: () => ({ for: lockProof }) }) }),
      execute: vi.fn().mockResolvedValue(undefined),
    };
    const lockedDatabase = {
      transaction: async (work: (current: typeof transaction) => Promise<unknown>) => work(transaction),
    } as unknown as PartnerDatabase;
    const notify = vi.fn();
    await requestPartnerDeveloperEmail(lockedDatabase, 'owner', notify);
    expect(lockAccount).toHaveBeenCalledWith('share');
    expect(lockProof).toHaveBeenCalledWith('update');
    expect(notify).not.toHaveBeenCalled();
  });

  it('requires a fresh challenge when a verified account changes its address', async () => {
    const userId = await account();
    const oldToken = await challenge(userId);
    expect(await confirmPartnerDeveloperEmail(database, userId, oldToken)).toBe(true);
    const changedEmail = `updated-${userId}@example.com`;
    await db.update(users).set({ email: changedEmail }).where(eq(users.id, userId));
    await db
      .update(partnerDeveloperEmails)
      .set({ requestedAt: new Date(Date.now() - 61_000) })
      .where(eq(partnerDeveloperEmails.userId, userId));
    expect(await hasVerifiedPartnerDeveloperEmail(database, userId)).toBe(false);
    const notify = vi.fn().mockResolvedValue(undefined);
    await requestPartnerDeveloperEmail(database, userId, notify);
    expect(notify).toHaveBeenCalledOnce();
    expect(notify.mock.calls[0][0]).toBe(changedEmail);
    expect(await confirmPartnerDeveloperEmail(database, userId, oldToken)).toBe(false);
    expect(await hasVerifiedPartnerDeveloperEmail(database, userId)).toBe(false);
    expect(await confirmPartnerDeveloperEmail(database, userId, notify.mock.calls[0][1])).toBe(true);
  });

  it('invalidates expired and replaced links, throttles resends, and only one racing confirmation wins', async () => {
    const userId = await account();
    const original = await challenge(userId);
    await expect(challenge(userId)).rejects.toMatchObject({ reason: 'busy' });
    await db
      .update(partnerDeveloperEmails)
      .set({ requestedAt: new Date(Date.now() - 61_000) })
      .where(eq(partnerDeveloperEmails.userId, userId));
    const replacement = await challenge(userId);
    expect(await confirmPartnerDeveloperEmail(database, userId, original)).toBe(false);
    const outcomes = await Promise.all([
      confirmPartnerDeveloperEmail(database, userId, replacement),
      confirmPartnerDeveloperEmail(database, userId, replacement),
    ]);
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    const expiredUserId = await account();
    const expired = await challenge(expiredUserId);
    await db
      .update(partnerDeveloperEmails)
      .set({ expiresAt: new Date(Date.now() - 1) })
      .where(
        and(
          eq(partnerDeveloperEmails.userId, expiredUserId),
          eq(partnerDeveloperEmails.email, `${expiredUserId}@example.com`),
        ),
      );
    expect(await confirmPartnerDeveloperEmail(database, expiredUserId, expired)).toBe(false);
  });
});
