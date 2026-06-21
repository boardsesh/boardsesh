import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../Button';
import { useToast } from '../../providers/toast-provider';
import { useIntegrationStatuses, useSyncSessionToIntegration } from '../../lib/graphql/hooks';
import { useFeatureFlag } from '../../providers/feature-flags-provider';
import { STRAVA_ORANGE } from './strava-brand';

type ShareToStravaButtonProps = {
  sessionId: string;
};

/**
 * Manual "Share to Strava" action for the session summary. Only renders when the
 * user has a connected Strava account.
 */
export function ShareToStravaButton({ sessionId }: ShareToStravaButtonProps) {
  const stravaEnabled = useFeatureFlag('strava-integration') === true;
  if (!stravaEnabled) return null;

  return <EnabledShareToStravaButton sessionId={sessionId} />;
}

function EnabledShareToStravaButton({ sessionId }: ShareToStravaButtonProps) {
  const { t } = useTranslation('session');
  const { showToast } = useToast();
  const { data: statuses, isLoading: statusesLoading } = useIntegrationStatuses();
  const syncSession = useSyncSessionToIntegration();

  const stravaConnected = statuses?.some((status) => status.provider === 'STRAVA' && status.connected) ?? false;

  const handlePress = useCallback(() => {
    syncSession.mutate(
      { provider: 'STRAVA', sessionId },
      {
        onSuccess: (data) => {
          // A resolved mutation can still carry a domain error (e.g. Strava
          // rejected the upload); treat that like a failure so the user can retry.
          if (data.syncSessionToIntegration.error) {
            showToast(t('summary.shareToStravaFailed'), 'error');
          }
        },
        onError: () => {
          showToast(t('summary.shareToStravaFailed'), 'error');
        },
      },
    );
  }, [syncSession, sessionId, showToast, t]);

  // Cold cache (fresh app start straight to the summary): the statuses query is
  // still settling, so we don't yet know whether Strava is connected. Hold the
  // space with a disabled button instead of rendering nothing — a connected
  // user would otherwise watch the action pop in after the fetch.
  if (statusesLoading) {
    return (
      <Button
        title={t('summary.shareToStrava')}
        variant="filled"
        tintColor={STRAVA_ORANGE}
        onPress={handlePress}
        disabled
      />
    );
  }

  if (!stravaConnected) return null;

  const succeeded = syncSession.isSuccess && !syncSession.data?.syncSessionToIntegration.error;

  if (syncSession.isPending) {
    return (
      <Button
        title={t('summary.sharingToStrava')}
        variant="filled"
        tintColor={STRAVA_ORANGE}
        onPress={handlePress}
        disabled
        loading
      />
    );
  }

  if (succeeded) {
    return (
      <Button
        title={t('summary.sharedToStrava')}
        variant="filled"
        tintColor={STRAVA_ORANGE}
        icon="check.small"
        onPress={handlePress}
        disabled
      />
    );
  }

  // Idle, or after a failure — allow a retry. The error toast already fired.
  return <Button title={t('summary.shareToStrava')} variant="filled" tintColor={STRAVA_ORANGE} onPress={handlePress} />;
}
