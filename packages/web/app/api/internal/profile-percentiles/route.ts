import { NextResponse } from 'next/server';
import { revalidateTag } from 'next/cache';
import { sql } from 'drizzle-orm';
import { getDb } from '@/app/lib/db/db';
import { USER_CLIMB_PERCENTILE_CACHE_TAG } from '@/app/lib/graphql/server-cached-client';
import { userClimbPercentiles } from '@boardsesh/db/schema';
import { refreshUserClimbPercentiles } from '@boardsesh/db/queries';
import { requireCronAuth } from '@/app/lib/auth/cron-auth';
import { createRequestLogger } from '@/app/lib/observability/request-logger';
import { reportHandledError } from '@/app/lib/observability/report-error';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(request: Request) {
  const log = createRequestLogger(request);
  const authError = requireCronAuth(request);
  if (authError) {
    return authError;
  }

  try {
    const db = getDb();

    // Single statement is already atomic — no explicit transaction needed.
    await refreshUserClimbPercentiles(db);

    const [countResult] = await db.select({ count: sql<number>`count(*)::int` }).from(userClimbPercentiles);

    revalidateTag(USER_CLIMB_PERCENTILE_CACHE_TAG, { expire: 0 });

    return NextResponse.json({
      refreshedUsers: Number(countResult?.count ?? 0),
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    reportHandledError(error, { logger: log, message: 'Profile percentile refresh failed' });
    return NextResponse.json({ error: 'Profile percentile refresh failed' }, { status: 500 });
  }
}
