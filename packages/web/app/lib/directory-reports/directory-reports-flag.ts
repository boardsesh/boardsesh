import 'server-only';
import { DIRECTORY_REPORTS_FLAG, DIRECTORY_REPORTS_FLAG_DISTINCT_ID } from '@/app/flags';
import { getServerFeatureFlag } from '@/app/lib/feature-flags/server-feature-flag';

/**
 * Whether Report a problem is switched on (docs/product/directory-reports.md,
 * "The `directory-reports` flag").
 *
 * The same question the backend asks before `reportBoard` / `reportGym`, for the
 * same fixed id, so the gym page, the board list and the manage lock state show
 * the entry points exactly when the server takes reports. One answer for every
 * visitor: the id is not a person, so the answer is safe in a page the CDN
 * shares between visitors, and a plain 100% release condition turns it on.
 *
 * Fails closed: `FEATURE_FLAG_OVERRIDES` decides first, then PostHog (cached
 * 60 s); no key, no answer or a throw reads as off.
 */
export async function isDirectoryReportsEnabled(): Promise<boolean> {
  try {
    return await getServerFeatureFlag(DIRECTORY_REPORTS_FLAG, { distinctId: DIRECTORY_REPORTS_FLAG_DISTINCT_ID });
  } catch (error) {
    console.error('directory-reports flag read failed:', error);
    return false;
  }
}
