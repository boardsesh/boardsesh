import { NextResponse } from 'next/server';
import { requireCronAuth } from '@/app/lib/auth/cron-auth';
import { climbSitemapsEnabled } from '@/app/lib/seo/sitemap/climb-sitemaps-enabled';
import { refreshClimbSitemapStore } from '@/app/lib/seo/sitemap/climb-store';

/**
 * Rebuilds the climb sitemap store: the summary row `/sitemap.xml` answers from
 * in a millisecond instead of missing its 3 s deadline and dropping ~52,000 URLs
 * out of the index (#4523), and the `sitemap_climb_urls` rows
 * `/sitemaps/climbs/N.xml` serves as an ordinal range read instead of a 51 s
 * full rebuild per cold page (#4552).
 *
 * Fired every six hours by the Railway scheduler's `refresh-sitemap-climbs` job
 * (packages/scheduler/src/jobs/registry.ts, docs/scheduler.md), and reachable by
 * hand for the first refresh after a re-enable; `requireCronAuth` checks
 * `Authorization: Bearer $CRON_SECRET` either way. With the switch off it answers
 * `skipped: "disabled"` after the auth check and scans nothing.
 *
 * `?force=1` bypasses the >50%-shrink guard. It exists so the guard cannot wedge
 * the store permanently: if the catalogue genuinely shrank, every scheduled run
 * would otherwise decline forever while the read path kept serving a frozen count.
 */
export const dynamic = 'force-dynamic';
/**
 * Vercel's Pro ceiling, kept only because the frozen rollback deployment still
 * runs there. On the Railway container it is inert, and the real bound is the
 * scheduler job's `timeoutMs` (15 minutes) — the sixteen sequential
 * `DISTINCT ON` scans behind this route have been measured at 51 s and have no
 * reason to fit inside 300.
 */
export const maxDuration = 300;

export async function GET(request: Request) {
  const authError = requireCronAuth(request);
  if (authError) {
    return authError;
  }

  if (!climbSitemapsEnabled()) {
    return NextResponse.json({ shard: 'climbs', skipped: 'disabled' });
  }

  const force = new URL(request.url).searchParams.get('force') === '1';

  try {
    const result = await refreshClimbSitemapStore({ force });
    const body = {
      shard: 'climbs',
      itemCount: result.itemCount,
      previousItemCount: result.previousItemCount,
      lastModified: result.lastModified ? result.lastModified.toISOString() : null,
      scanDurationMs: result.scanDurationMs,
      skipped: result.skipped,
      forced: force,
    };

    // A refusal to write is NOT a success. `empty` and `shrank` mean the store is
    // frozen at whatever it held while the read path keeps serving it, and a 200
    // would leave that visible only to whoever greps the logs. 409 makes a wedged
    // store visible to the operator who requested the refresh.
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
