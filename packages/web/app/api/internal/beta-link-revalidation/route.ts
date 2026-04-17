import { NextResponse } from 'next/server';
import { runBetaLinkRevalidationBatch } from '@/app/lib/beta-link-revalidation';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const CRON_SECRET = process.env.CRON_SECRET;

export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const result = await runBetaLinkRevalidationBatch({
      batchSize: 250,
      concurrency: 6,
      deadlineMs: 45_000,
    });

    if (result.processed > 0) {
      console.log(
        `[Beta link revalidation] Processed ${result.processed} links (${result.madeAccessible} accessible, ${result.madeInaccessible} inaccessible). ${result.remainingEligible} remaining.`,
      );
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error('[Beta link revalidation] Error:', error);
    return NextResponse.json(
      { error: 'Beta link revalidation failed' },
      { status: 500 },
    );
  }
}
