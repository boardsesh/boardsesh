import { NextResponse } from 'next/server';
import { requireCronAuth } from '@/app/lib/auth/cron-auth';
import { refreshStoredClimbSummary } from '@/app/lib/seo/sitemap/climb-store';

/**
 * Recomputes the climbs shard summary and stores it, so `/sitemap.xml` can answer
 * "how many climb pages are there" in a millisecond instead of missing its 3 s
 * deadline and dropping ~52,000 URLs out of the index (#4523).
 *
 * Scheduled six-hourly in `packages/web/vercel.json`, matching the shard's own
 * `s-maxage=21600` so no layer is staler than any other. Vercel injects
 * `Authorization: Bearer $CRON_SECRET`; `requireCronAuth` is what checks it.
 *
 * `?force=1` bypasses the >50%-shrink guard. It exists so the guard cannot wedge
 * the store permanently: if the catalogue genuinely shrank, every scheduled run
 * would otherwise decline forever while the read path kept serving a frozen count.
 */
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(request: Request) {
  const authError = requireCronAuth(request);
  if (authError) {
    return authError;
  }

  const force = new URL(request.url).searchParams.get('force') === '1';

  try {
    const result = await refreshStoredClimbSummary({ force });
    const body = {
      shard: 'climbs',
      itemCount: result.itemCount,
      previousItemCount: result.previousItemCount,
      lastModified: result.lastModified ? result.lastModified.toISOString() : null,
      durationMs: result.durationMs,
      skipped: result.skipped,
      forced: force,
    };

    // A refusal to write is NOT a success. `empty` and `shrank` mean the store is
    // frozen at whatever it held while the read path keeps serving it, and a 200
    // would leave that visible only to whoever greps the logs. 409 makes a wedged
    // store fail the cron run that discovered it.
    if (result.skipped === 'empty' || result.skipped === 'shrank') {
      return NextResponse.json(
        {
          ...body,
          error:
            result.skipped === 'empty'
              ? 'the refresh computed 0 climbs — refusing to store a count that would drop the shard from the index'
              : 'the refresh computed a >50% smaller catalogue — refusing to store it. Re-run with ?force=1 if the shrink is real.',
        },
        { status: 409 },
      );
    }

    // `locked` and `superseded` are benign concurrency: another instance is doing,
    // or has just done, this exact work. Nothing is wedged, so nothing should page.
    return NextResponse.json(body);
  } catch (error) {
    console.error('[refresh-sitemap-climbs] Error:', error);
    return NextResponse.json({ error: 'Sitemap climbs summary refresh failed' }, { status: 500 });
  }
}
