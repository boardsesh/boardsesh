import { useConsentSettled } from '../lib/consent-hooks';
import { useEffect } from 'react';
import { AppState } from 'react-native';
import * as Notifications from 'expo-notifications';
import { useTranslation } from 'react-i18next';
import { router } from 'expo-router';
import { useSprayCompletionUpdates } from './use-spray-completion-updates';
import { registerNotificationDevice } from './device-registration';
import { setupNotificationHandlers } from './handlers';

/** Keep import progress and the bell current without background polling. */
export function useNotificationUpdates(authenticated: boolean, accountId: string | null | undefined) {
  const consentSettled = useConsentSettled();
  const { i18n } = useTranslation();
  const locale = i18n.language;
  const refreshCompletion = useSprayCompletionUpdates(authenticated, accountId);
  useEffect(
    () =>
      setupNotificationHandlers(router, {
        canNavigate: authenticated && consentSettled,
        onSprayCompletion: refreshCompletion,
      }),
    [authenticated, accountId, refreshCompletion, consentSettled],
  );
  useEffect(() => {
    if (!authenticated) return;
    void registerNotificationDevice();
    const foreground = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        void registerNotificationDevice();
        refreshCompletion();
      }
    });
    const token = Notifications.addPushTokenListener(() => {
      void registerNotificationDevice(false, true);
    });
    return () => {
      foreground.remove();
      token.remove();
    };
  }, [authenticated, accountId, locale, refreshCompletion]);
}
