import type { MoreFormModel, MoreSection } from '../../MoreForm.types';
import type { SettingsTranslate } from '../root/settings-pages';
import { buildSyncIssuesSection, type SyncIssuesSectionInput } from '../root/sync-issues-section';

export type AccountModelInput = {
  t: SettingsTranslate;
  /**
   * Stuck writes, or `null` when there are none: the same alert, under the same
   * condition, as the top of the Settings root.
   */
  syncIssues: SyncIssuesSectionInput | null;
  /** The signed-in email, shown under Edit profile. `null` while it loads, or offline. */
  email: string | null;
  onEditProfile: () => void;
  onExportData: () => void;
  onSignOut: () => void;
  onDeleteAccount: () => void;
};

/**
 * "Account": your profile, your data, and the two ways out.
 *
 * Stuck writes come first when there are any. Signing out deletes them, and the
 * sign-out dialog says to cancel and hit Retry sync first, so Retry sits on the
 * page the climber is signing out from.
 *
 * Sign out and Delete account sit together in the last section. Sign out is the
 * full-strength action; Delete account is the quieter one (`subtle`) so the two
 * never read as equal heavy red blocks. Delete account stays one tap from here,
 * beside Sign out, as App Review 5.1.1(v) asks.
 */
export function buildAccountModel(input: AccountModelInput): MoreFormModel {
  const { t } = input;
  const sections: MoreSection[] = [];
  if (input.syncIssues) sections.push(buildSyncIssuesSection(t, input.syncIssues));
  sections.push(
    {
      key: 'profile',
      footer: input.email ?? undefined,
      rows: [
        {
          kind: 'nav',
          key: 'editProfile',
          label: t('settings:profile.editAction'),
          icon: 'editProfile',
          onPress: input.onEditProfile,
        },
      ],
    },
    {
      key: 'yourData',
      title: t('settings:privacy.yourData'),
      rows: [
        {
          kind: 'nav',
          key: 'exportData',
          label: t('settings:export.title'),
          icon: 'export',
          onPress: input.onExportData,
        },
      ],
    },
    {
      key: 'accountActions',
      rows: [
        {
          kind: 'button',
          key: 'signOut',
          label: t('profile:mobile.signOut'),
          role: 'destructive',
          emphasis: 'primary',
          onPress: input.onSignOut,
        },
        {
          kind: 'button',
          key: 'deleteAccount',
          label: t('settings:deleteAccount.button'),
          role: 'destructive',
          emphasis: 'subtle',
          onPress: input.onDeleteAccount,
        },
      ],
    },
  );
  return { sections };
}
