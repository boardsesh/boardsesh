import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vite-plus/test';
import { partnerConnectionNotices, PARTNER_CONNECTION_NOTICE_MAX_ATTEMPTS } from '@boardsesh/db/schema/auth';
import { db } from '../db/client';
import {
  runPartnerConnectionNotices,
  prunePartnerConnectionNotices,
  PARTNER_CONNECTION_NOTICE_RETENTION_MS,
} from '../services/partner-connection-notices';
import { attachPartnerState, createApp, createUser } from '../auth/partner/__tests__/revocation-fixtures';

async function pendingNotice() {
  const owner = await createUser(`notice-owner-${randomUUID()}`);
  const climber = await createUser(`notice-climber-${randomUUID()}`);
  const clientId = await createApp(owner);
  const rows = await attachPartnerState(climber, clientId);
  // Fixtures intentionally use .invalid; this test needs a deliverable address without calling SMTP.
  const { users } = await import('@boardsesh/db/schema/auth');
  await db
    .update(users)
    .set({ email: `${climber}@example.com` })
    .where(eq(users.id, climber));
  await db
    .insert(partnerConnectionNotices)
    .values({ connectionId: rows.connectionId, generation: 0, userId: climber, clientId });
  return rows.connectionId;
}

describe('durable partner connection notices', () => {
  it('keeps a failed email durable and retries without repeating a delivered notice', async () => {
    const connectionId = await pendingNotice();
    const send = vi.fn().mockRejectedValueOnce(new Error('SMTP unavailable')).mockResolvedValue(undefined);
    await runPartnerConnectionNotices(send);
    let [notice] = await db
      .select()
      .from(partnerConnectionNotices)
      .where(eq(partnerConnectionNotices.connectionId, connectionId));
    expect(notice.deliveredAt).toBeNull();
    expect(notice.attempts).toBe(1);
    await db
      .update(partnerConnectionNotices)
      .set({ nextAttemptAt: new Date(Date.now() - 1) })
      .where(eq(partnerConnectionNotices.connectionId, connectionId));
    await runPartnerConnectionNotices(send);
    [notice] = await db
      .select()
      .from(partnerConnectionNotices)
      .where(eq(partnerConnectionNotices.connectionId, connectionId));
    expect(notice.deliveredAt).not.toBeNull();
    await runPartnerConnectionNotices(send);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('stops retrying after the tenth failed delivery', async () => {
    const connectionId = await pendingNotice();
    await db
      .update(partnerConnectionNotices)
      .set({ attempts: PARTNER_CONNECTION_NOTICE_MAX_ATTEMPTS - 1 })
      .where(eq(partnerConnectionNotices.connectionId, connectionId));
    const send = vi.fn().mockRejectedValue(new Error('SMTP unavailable'));
    await runPartnerConnectionNotices(send);
    await db
      .update(partnerConnectionNotices)
      .set({ nextAttemptAt: new Date(Date.now() - 1) })
      .where(eq(partnerConnectionNotices.connectionId, connectionId));
    await runPartnerConnectionNotices(send);
    expect(send).toHaveBeenCalledOnce();
    const [notice] = await db
      .select()
      .from(partnerConnectionNotices)
      .where(eq(partnerConnectionNotices.connectionId, connectionId));
    expect(notice.attempts).toBe(PARTNER_CONNECTION_NOTICE_MAX_ATTEMPTS);
    expect(notice.deliveredAt).toBeNull();
  });

  it('does not spend final retries while a claimed batch is waiting for SMTP', async () => {
    const firstConnectionId = await pendingNotice();
    const secondConnectionId = await pendingNotice();
    for (const [index, connectionId] of [firstConnectionId, secondConnectionId].entries()) {
      await db
        .update(partnerConnectionNotices)
        .set({
          attempts: PARTNER_CONNECTION_NOTICE_MAX_ATTEMPTS - 1,
          nextAttemptAt: new Date(Date.now() - 2000 + index * 1000),
        })
        .where(eq(partnerConnectionNotices.connectionId, connectionId));
    }
    let releaseSmtp!: () => void;
    let smtpStarted!: () => void;
    const blockedSmtp = new Promise<void>((resolve) => {
      releaseSmtp = resolve;
    });
    const started = new Promise<void>((resolve) => {
      smtpStarted = resolve;
    });
    const send = vi
      .fn()
      .mockImplementationOnce(async () => {
        smtpStarted();
        await blockedSmtp;
      })
      .mockResolvedValue(undefined);
    const processing = runPartnerConnectionNotices(send);
    try {
      await started;
      // A process loss here must leave every leased notice eligible after its lease expires.
      for (const connectionId of [firstConnectionId, secondConnectionId]) {
        const [notice] = await db
          .select()
          .from(partnerConnectionNotices)
          .where(eq(partnerConnectionNotices.connectionId, connectionId));
        expect(notice.attempts).toBe(PARTNER_CONNECTION_NOTICE_MAX_ATTEMPTS - 1);
        expect(notice.deliveredAt).toBeNull();
      }
    } finally {
      releaseSmtp();
      await processing;
    }
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('retains pending notices and ages terminal notices from their settlement time', async () => {
    const connectionId = await pendingNotice();
    const [original] = await db
      .select()
      .from(partnerConnectionNotices)
      .where(eq(partnerConnectionNotices.connectionId, connectionId));
    const now = new Date();
    const old = new Date(now.getTime() - PARTNER_CONNECTION_NOTICE_RETENTION_MS - 1);
    const recent = new Date(now.getTime() - 1000);
    const boundary = new Date(now.getTime() - PARTNER_CONNECTION_NOTICE_RETENTION_MS);
    await db.insert(partnerConnectionNotices).values([
      { ...original, generation: 1, createdAt: old, deliveredAt: old },
      {
        ...original,
        generation: 2,
        createdAt: old,
        attempts: PARTNER_CONNECTION_NOTICE_MAX_ATTEMPTS,
        nextAttemptAt: old,
      },
      {
        ...original,
        generation: 3,
        createdAt: old,
        attempts: PARTNER_CONNECTION_NOTICE_MAX_ATTEMPTS - 1,
        nextAttemptAt: old,
      },
      { ...original, generation: 4, createdAt: old, deliveredAt: recent },
      {
        ...original,
        generation: 5,
        createdAt: old,
        attempts: PARTNER_CONNECTION_NOTICE_MAX_ATTEMPTS,
        nextAttemptAt: recent,
      },
      { ...original, generation: 6, createdAt: old, deliveredAt: boundary },
      {
        ...original,
        generation: 7,
        createdAt: old,
        attempts: PARTNER_CONNECTION_NOTICE_MAX_ATTEMPTS,
        nextAttemptAt: boundary,
      },
    ]);
    expect(await prunePartnerConnectionNotices(db, now)).toBe(2);
    const remaining = await db
      .select({ generation: partnerConnectionNotices.generation })
      .from(partnerConnectionNotices)
      .where(eq(partnerConnectionNotices.connectionId, connectionId));
    expect(remaining.map(({ generation }) => generation).sort((first, second) => first - second)).toEqual([
      0, 3, 4, 5, 6, 7,
    ]);
  });

  it('prunes at most 1000 settled notices per batch', async () => {
    const connectionId = await pendingNotice();
    const [original] = await db
      .select()
      .from(partnerConnectionNotices)
      .where(eq(partnerConnectionNotices.connectionId, connectionId));
    const now = new Date();
    const old = new Date(now.getTime() - PARTNER_CONNECTION_NOTICE_RETENTION_MS - 1);
    // The preceding test intentionally leaves terminal rows exactly on its cutoff.
    await prunePartnerConnectionNotices(db, now);
    await db.insert(partnerConnectionNotices).values(
      Array.from({ length: 1001 }, (_, index) => ({
        ...original,
        generation: index + 1,
        deliveredAt: old,
      })),
    );
    expect(await prunePartnerConnectionNotices(db, now)).toBe(1000);
    expect(await db.$count(partnerConnectionNotices, eq(partnerConnectionNotices.connectionId, connectionId))).toBe(2);
    expect(await prunePartnerConnectionNotices(db, now)).toBe(1);
    expect(await db.$count(partnerConnectionNotices, eq(partnerConnectionNotices.connectionId, connectionId))).toBe(1);
  });
});
