import type { MoreSection } from '../../MoreForm.types';
import type { SettingsTranslate } from './settings-pages';

/**
 * Writes the server rejected, or that ran out of retries while online, and the
 * tap that sends them again. `null` when there are none, or when the phone is
 * offline, where a waiting write is expected rather than stuck.
 */
export type SyncIssuesSectionInput = { count: number; onRetry: () => void };

/**
 * The "Sync issues" alert: how many writes are stuck, and Retry.
 *
 * Shown at the top of the Settings root and of the Account page, under the same
 * condition. The sign-out dialog tells a climber with stuck writes to cancel and
 * hit Retry sync first, and Sign out lives on Account, so Retry has to be there
 * too. Retry only: an unsynced write is never thrown away, it waits and re-sends.
 */
export function buildSyncIssuesSection(t: SettingsTranslate, syncIssues: SyncIssuesSectionInput): MoreSection {
  return {
    key: 'syncIssues',
    title: t('mobile.settings.syncIssues.title'),
    footer: t('mobile.settings.syncIssues.description', { count: syncIssues.count }),
    rows: [
      {
        kind: 'button',
        key: 'retrySync',
        label: t('mobile.settings.syncIssues.retry'),
        emphasis: 'primary',
        onPress: syncIssues.onRetry,
      },
    ],
  };
}
