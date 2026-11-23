import { useConsentSettled } from '../lib/consent-hooks';
import { useEffect } from 'react';
import { AppState } from 'react-native';
import * as Notifications from 'expo-notifications';
import { useTranslation } from 'react-i18next';
import { router } from 'expo-router';
import { useSprayCompletionUpdates } from './use-spray-completion-updates';
import { registerNotificationDevice } from './device-registration';
import { setupNotificationHandlers } from './handlers';
import { useDirectoryReportsEnabled, useFeatureFlagsResolved } from '../providers/feature-flags-provider';

/** Keep import progress and the bell current without background polling. */
export function useNotificationUpdates(authenticated: boolean, accountId: string | null | undefined) {
  const consentSettled = useConsentSettled();
  const { i18n } = useTranslation();
  const locale = i18n.language;
  const { refreshCompletion, refreshReports } = useSprayCompletionUpdates(authenticated, accountId);
  // Undefined until the flag bag is final, so a push tapped at launch is not
  // routed on a flag that has not loaded yet: the picker waits for it instead.
  const flagsResolved = useFeatureFlagsResolved();
  const directoryReportsFlag = useDirectoryReportsEnabled();
  const directoryReportsEnabled = flagsResolved ? directoryReportsFlag : undefined;
  useEffect(
    () =>
      setupNotificationHandlers(router, {
        canNavigate: authenticated && consentSettled,
        onSprayCompletion: refreshCompletion,
        onBugReportReply: refreshReports,
        directoryReportsEnabled,
      }),
    [authenticated, accountId, refreshCompletion, refreshReports, consentSettled, directoryReportsEnabled],
  );
  useEffect(() => {
    if (!authenticated) return;
    void registerNotificationDevice();
    const foreground = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        void registerNotificationDevice();
        refreshCompletion();
        refreshReports();
      }
    });
    const token = Notifications.addPushTokenListener((devicePushToken) => {
      void registerNotificationDevice(false, true, devicePushToken);
    });
    return () => {
      foreground.remove();
      token.remove();
    };
  }, [authenticated, accountId, locale, refreshCompletion, refreshReports]);
}
