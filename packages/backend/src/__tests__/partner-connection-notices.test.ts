import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vite-plus/test';
import { partnerConnectionNotices } from '@boardsesh/db/schema/auth';
import { db } from '../db/client';
import { runPartnerConnectionNotices } from '../services/partner-connection-notices';
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
});
