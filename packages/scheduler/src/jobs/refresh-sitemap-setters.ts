import type { JobRun } from './types';
import { runBackendCronMutation } from './backend-cron-mutation';

export const REFRESH_SETTER_SITEMAP_SUMMARY_MUTATION = `
  mutation RefreshSetterSitemapSummary {
    refreshSetterSitemapSummary(force: true) {
      refreshed itemCount lastModified computedAt skipped
    }
  }
`;

/** Scheduled runs refresh even when the previous scan finished after its tick. */
export const refreshSitemapSetters: JobRun = async (context) => {
  const result = await runBackendCronMutation({
    context,
    mutationName: 'refreshSetterSitemapSummary',
    mutation: REFRESH_SETTER_SITEMAP_SUMMARY_MUTATION,
  });

  const validCount =
    typeof result.itemCount === 'number' && Number.isSafeInteger(result.itemCount) && result.itemCount > 0;
  const validClock = typeof result.computedAt === 'string' && Number.isFinite(Date.parse(result.computedAt));
  const validLastModified =
    result.lastModified === null ||
    (typeof result.lastModified === 'string' && Number.isFinite(Date.parse(result.lastModified)));
  const validSummary = validCount && validClock && validLastModified;
  const validMissingSummary = result.itemCount === null && result.computedAt === null && result.lastModified === null;
  const completed = result.refreshed === true && result.skipped === null && validSummary;
  const skipped =
    result.refreshed === false &&
    ((result.skipped === 'locked' && (validSummary || validMissingSummary)) ||
      (result.skipped === 'fresh' && validSummary));
  if (!completed && !skipped) {
    throw new Error('refreshSetterSitemapSummary returned an invalid result');
  }
  return result;
};
