import 'server-only';
import { GraphQLClient } from 'graphql-request';
import { z } from 'zod';
import { getStoredSetterSitemapSummary, SETTER_SUMMARY_MAX_AGE_MS } from '@boardsesh/db/queries/sitemap';
import { dbz } from '@/app/lib/db/db';
import { getGraphQLHttpUrl } from '@/app/lib/graphql/client';
import { reportHandledError } from '@/app/lib/observability/report-error';

const RETRY_FLOOR_MS = 60_000;
const REFRESH_TIMEOUT_MS = 90_000;
const REFRESH_MUTATION = `mutation RefreshSetterSitemapSummary {
  refreshSetterSitemapSummary {
    refreshed itemCount lastModified computedAt skipped
  }
}`;
const refreshResult = z.object({
  refreshSetterSitemapSummary: z
    .object({
      refreshed: z.boolean(),
      itemCount: z.number().int().positive().nullable(),
      lastModified: z.iso.datetime().nullable(),
      computedAt: z.iso.datetime().nullable(),
      skipped: z.enum(['fresh', 'locked']).nullable(),
    })
    .refine((result) =>
      result.refreshed
        ? result.itemCount !== null && result.computedAt !== null && result.skipped === null
        : result.skipped === 'locked' ||
          (result.skipped === 'fresh' && result.itemCount !== null && result.computedAt !== null),
    ),
});

let lastAttemptAt: number | null = null;
let refreshInFlight: Promise<void> | null = null;

/** Recover outside the index deadline. The backend owns every cache write. */
export async function refreshSetterSummaryIfStale(): Promise<void> {
  if (refreshInFlight) return refreshInFlight;
  if (lastAttemptAt !== null && Date.now() - lastAttemptAt < RETRY_FLOOR_MS) return;
  lastAttemptAt = Date.now();

  const refresh = (async () => {
    try {
      const stored = await getStoredSetterSitemapSummary(dbz);
      if (stored && Date.now() - stored.computedAt.getTime() < SETTER_SUMMARY_MAX_AGE_MS) return;
      const cronSecret = process.env.CRON_SECRET;
      if (!cronSecret) throw new Error('CRON_SECRET is required to refresh the setters sitemap summary');
      const client = new GraphQLClient(getGraphQLHttpUrl(), {
        headers: { Authorization: `Bearer ${cronSecret}` },
        signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
      });
      refreshResult.parse(await client.request<unknown>(REFRESH_MUTATION));
    } catch (error) {
      reportHandledError(error, { message: '[sitemap] backend setters summary refresh failed' });
    }
  })();
  refreshInFlight = refresh;
  try {
    await refresh;
  } finally {
    refreshInFlight = null;
  }
}

export function resetSetterSummaryRefreshForTests(): void {
  lastAttemptAt = null;
  refreshInFlight = null;
}
