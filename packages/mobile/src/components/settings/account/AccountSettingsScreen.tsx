import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { scopedRouter as router } from '../../../lib/routing/scoped-navigation';
import { MoreForm } from '../../MoreForm';
import { useConfirmSignOut } from '../../../hooks/use-confirm-sign-out';
import { useProfile } from '../../../lib/graphql/hooks';
import { hapticLight } from '../../../lib/haptics';
import { withSettingTracking } from '../../../lib/settings-analytics';
import { useAuth } from '../../../providers/auth-provider';
import { useSyncIssuesSection } from '../root/use-sync-issues';
import { buildAccountModel } from './account-model';

export function AccountSettingsScreen() {
  const { t } = useTranslation('common');
  const { isAuthenticated } = useAuth();
  // Offline the profile may never load; the page still works; it just has no
  // email to show, and Sign out stays reachable.
  const { data: profile } = useProfile({ enabled: isAuthenticated });
  const confirmSignOut = useConfirmSignOut();
  // The Retry the sign-out dialog sends a climber with stuck writes to.
  const syncIssues = useSyncIssuesSection();
  const email = profile?.email ?? null;

  const model = useMemo(
    () =>
      withSettingTracking(
        buildAccountModel({
          t,
          syncIssues,
          email,
          onEditProfile: () => {
            hapticLight();
            router.push('/settings/edit');
          },
          onExportData: () => {
            hapticLight();
            router.push('/settings/export');
          },
          // No haptic on the two destructive actions, as before. The warning and
          // the wipe both live in the hook, shared with the user drawer's Log
          // out row so the two can't drift apart (issue #3621).
          onSignOut: () => {
            void confirmSignOut();
          },
          onDeleteAccount: () => router.push('/settings/delete-account'),
        }),
        'account',
      ),
    [t, syncIssues, email, confirmSignOut],
  );

  return <MoreForm model={model} />;
}
