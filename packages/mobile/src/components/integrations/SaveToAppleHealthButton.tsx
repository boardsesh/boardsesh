import { useCallback } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { SessionSummary } from '@boardsesh/shared-schema';
import { ActivityIndicator } from '../ActivityIndicator';
import { Icon } from '../Icon';
import { PressableSurface } from '../PressableSurface';
import { Text } from '../Text';
import { useTheme } from '../../providers/theme-provider';
import { borderRadius, spacing } from '../../theme/tokens';
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
 * manual action stay in sync. While an auto-save is running, a passive
 * "Saving…" status replaces the action.
 */
export function SaveToAppleHealthButton({ summary, exportContext = {} }: SaveToAppleHealthButtonProps) {
  const { t } = useTranslation('session');
  const { t: tSettings } = useTranslation('settings');
  const { showToast } = useToast();
  const { systemColors } = useTheme();
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

  if (saveState === 'saving' || saveState === 'saved' || saveState === 'savedWithoutEnergy') {
    const isSaving = saveState === 'saving';
    const title = isSaving
      ? t('summary.savingToAppleHealth')
      : saveState === 'savedWithoutEnergy'
        ? t('summary.savedToAppleHealthWithoutCalories')
        : t('summary.savedToAppleHealth');
    return (
      <View
        style={styles.row}
        accessible
        accessibilityRole="text"
        accessibilityLabel={title}
        accessibilityState={{ busy: isSaving }}
        accessibilityLiveRegion="polite"
      >
        {isSaving ? (
          <ActivityIndicator size="small" color={systemColors.secondaryLabel} />
        ) : (
          <Icon name="check.small" size={20} color={systemColors.secondaryLabel} />
        )}
        <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.label}>
          {title}
        </Text>
      </View>
    );
  }

  const title = saveState === 'failed' ? t('summary.saveToAppleHealthRetry') : t('summary.saveToAppleHealth');
  return (
    <PressableSurface
      style={[styles.row, styles.action, { backgroundColor: systemColors.secondaryBackground }]}
      feedback="opacity"
      accessibilityRole="button"
      accessibilityLabel={title}
      onPress={handlePress}
    >
      <Icon name="favorite" size={20} color={systemColors.accent} />
      <Text variant="body" color={systemColors.accent} style={styles.label}>
        {title}
      </Text>
      <Icon name="chevron.right" size={14} color={systemColors.tertiaryLabel} />
    </PressableSurface>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 44,
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
    gap: spacing[3],
  },
  action: {
    borderRadius: borderRadius.lg,
    overflow: 'hidden',
  },
  label: {
    flex: 1,
  },
});
