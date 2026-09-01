import { NextResponse } from 'next/server';
import { lt, inArray, sql } from 'drizzle-orm';
import { dbz as db } from '@/app/lib/db/db';
import { feedItems, notifications } from '@boardsesh/db/schema';
import { requireCronAuth } from '@/app/lib/auth/cron-auth';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const BATCH_SIZE = 5000;

// Leave 10s buffer before timeout
const DEADLINE_MS = (maxDuration - 10) * 1000;

export async function GET(request: Request) {
  // Triggered by the Railway scheduler (packages/scheduler, job `cleanup`)
  // rather than a Vercel cron — it sends the identical
  // `Authorization: Bearer $CRON_SECRET` header. This route stays the single
  // implementation; only the trigger moved. See docs/scheduler.md.
  const authError = requireCronAuth(request);
  if (authError) {
    return authError;
  }

  try {
    const deadline = Date.now() + DEADLINE_MS;
    let feedDeleted = 0;
    let notifDeleted = 0;

    // Batched feed item cleanup (180-day retention)
    while (Date.now() < deadline) {
      const batch = await db
        .select({ id: feedItems.id })
        .from(feedItems)
        .where(lt(feedItems.createdAt, sql`NOW() - INTERVAL '180 days'`))
        .limit(BATCH_SIZE);

      if (batch.length === 0) break;

      await db.delete(feedItems).where(
        inArray(
          feedItems.id,
          batch.map((r) => r.id),
        ),
      );

      feedDeleted += batch.length;
      if (batch.length < BATCH_SIZE) break;
    }

    // Batched notification cleanup (90-day retention)
    while (Date.now() < deadline) {
      const batch = await db
        .select({ id: notifications.id })
        .from(notifications)
        .where(lt(notifications.createdAt, sql`NOW() - INTERVAL '90 days'`))
        .limit(BATCH_SIZE);

      if (batch.length === 0) break;

      await db.delete(notifications).where(
        inArray(
          notifications.id,
          batch.map((r) => r.id),
        ),
      );

      notifDeleted += batch.length;
      if (batch.length < BATCH_SIZE) break;
    }

    if (feedDeleted > 0 || notifDeleted > 0) {
      console.info(`[Cleanup cron] Deleted ${feedDeleted} feed items, ${notifDeleted} notifications`);
    }

    return NextResponse.json({
      feedItemsDeleted: feedDeleted,
      notificationsDeleted: notifDeleted,
    });
  } catch (error) {
    console.error('[Cleanup cron] Error:', error);
    return NextResponse.json({ error: 'Cleanup failed' }, { status: 500 });
  }
}
