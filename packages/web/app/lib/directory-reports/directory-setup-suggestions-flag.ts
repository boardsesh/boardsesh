import 'server-only';
import { DIRECTORY_SETUP_SUGGESTIONS_FLAG, DIRECTORY_SETUP_SUGGESTIONS_FLAG_DISTINCT_ID } from '@/app/flags';
import { getServerFeatureFlag } from '@/app/lib/feature-flags/server-feature-flag';

/**
 * Whether "Set up wrong" shows the setup fields (docs/product/directory-reports.md,
 * "The `directory-setup-suggestions` flag").
 *
 * The same question the backend asks before a suggestion may change a board,
 * for the same fixed id, so www offers the fields exactly when the server acts
 * on them. One answer for every visitor, like `isDirectoryReportsEnabled`, so it
 * is safe in a page the CDN shares. Off, the report dialog is the note-only one.
 *
 * Fails closed: `FEATURE_FLAG_OVERRIDES` decides first, then PostHog (cached
 * 60 s); no key, no answer or a throw reads as off.
 */
export async function isDirectorySetupSuggestionsEnabled(): Promise<boolean> {
  try {
    return await getServerFeatureFlag(DIRECTORY_SETUP_SUGGESTIONS_FLAG, {
      distinctId: DIRECTORY_SETUP_SUGGESTIONS_FLAG_DISTINCT_ID,
    });
  } catch (error) {
    console.error('directory-setup-suggestions flag read failed:', error);
    return false;
  }
}
