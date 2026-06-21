import { useCallback } from 'react';
import { Platform } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { SessionSummary } from '@boardsesh/shared-schema';
import { Button } from '../Button';
import { useToast } from '../../providers/toast-provider';
import { manualSaveToAppleHealth, useHealthKitSaveState, type SessionExportContext } from '../../lib/integrations';

type SaveToAppleHealthButtonProps = {
  summary: SessionSummary;
  exportContext?: SessionExportContext;
};

/**
 * Manual "Save to Apple Health" action for the session summary. iOS-only.
 *
 * The live save state for this session (saving/saved/failed) is shared via
 * `useHealthKitSaveState`, so an in-flight auto-save at session end and this
 * manual button stay in sync — pressing the button while an auto-save is
 * running shows the same "Saving…" state.
 */
export function SaveToAppleHealthButton({ summary, exportContext = {} }: SaveToAppleHealthButtonProps) {
  const { t } = useTranslation('session');
  const { t: tSettings } = useTranslation('settings');
  const { showToast } = useToast();
  const saveState = useHealthKitSaveState(summary.sessionId);

  const handlePress = useCallback(() => {
    void (async () => {
      const result = await manualSaveToAppleHealth(summary, exportContext);
      if (result === 'denied') {
        showToast(tSettings('integrations.appleHealth.permissionDenied'), 'error');
      } else if (result === 'unavailable' || result === 'failed') {
        // No dedicated "save failed" string exists; reuse the retry label as the
        // toast so the copy stays consistent with the button's failed state.
        showToast(t('summary.saveToAppleHealthRetry'), 'error');
      }
    })();
  }, [summary, exportContext, showToast, t, tSettings]);

  if (Platform.OS !== 'ios') return null;

  if (saveState === 'saving') {
    return (
      <Button title={t('summary.savingToAppleHealth')} variant="outlined" onPress={handlePress} disabled loading />
    );
  }

  if (saveState === 'saved' || saveState === 'savedWithoutEnergy') {
    return (
      <Button
        title={
          saveState === 'savedWithoutEnergy'
            ? t('summary.savedToAppleHealthWithoutCalories')
            : t('summary.savedToAppleHealth')
        }
        variant="outlined"
        icon="check.small"
        onPress={handlePress}
        disabled
      />
    );
  }

  const title = saveState === 'failed' ? t('summary.saveToAppleHealthRetry') : t('summary.saveToAppleHealth');
  return <Button title={title} variant="outlined" onPress={handlePress} />;
}
