import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { scopedRouter as router } from '../../../lib/routing/scoped-navigation';
import { MoreForm } from '../../MoreForm';
import { useConfirmSignOut } from '../../../hooks/use-confirm-sign-out';
import { useProfile } from '../../../lib/graphql/hooks';
import {
  useProjectNewsEmailConsent,
  useSetProjectNewsEmailConsent,
} from '../../../lib/graphql/hooks/use-project-news-email';
import { selectEffectiveOffline, useConnectivityField } from '../../../lib/connectivity/use-connectivity';
import { hapticLight, hapticSelection } from '../../../lib/haptics';
import { withSettingTracking } from '../../../lib/settings-analytics';
import { useAuth } from '../../../providers/auth-provider';
import { useSyncIssuesSection } from '../root/use-sync-issues';
import { buildAccountModel, type ProjectNewsEmailInput } from './account-model';

/**
 * Screenshot mode never shows anything about supporting Boardsesh, and the
 * project news switch mentions it, so store captures leave it out.
 */
const SCREENSHOT_MODE = process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1';

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

  const showProjectNews = isAuthenticated && !SCREENSHOT_MODE;
  const projectNewsQuery = useProjectNewsEmailConsent(showProjectNews);
  const setProjectNews = useSetProjectNewsEmailConsent();
  const effectiveOffline = useConnectivityField(selectEffectiveOffline);
  const { isPending: projectNewsSaving, isError: projectNewsSaveFailed, pendingValue, reset, mutate } = setProjectNews;
  const projectNewsEmail = useMemo((): ProjectNewsEmailInput | null => {
    if (!showProjectNews) return null;
    const loaded = projectNewsQuery.data;
    return {
      value: pendingValue ?? loaded?.subscribed ?? false,
      disabled: !loaded || projectNewsSaving || effectiveOffline,
      failure: projectNewsSaveFailed ? 'save' : projectNewsQuery.isError && !loaded ? 'load' : null,
      onValueChange: (next) => {
        hapticSelection();
        reset();
        mutate(next);
      },
    };
  }, [
    showProjectNews,
    projectNewsQuery.data,
    projectNewsQuery.isError,
    pendingValue,
    projectNewsSaving,
    projectNewsSaveFailed,
    effectiveOffline,
    reset,
    mutate,
  ]);

  const model = useMemo(
    () =>
      withSettingTracking(
        buildAccountModel({
          t,
          syncIssues,
          email,
          projectNewsEmail,
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
    [t, syncIssues, email, projectNewsEmail, confirmSignOut],
  );

  return <MoreForm model={model} />;
}
