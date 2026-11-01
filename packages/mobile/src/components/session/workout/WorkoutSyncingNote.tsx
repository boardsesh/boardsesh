// The summary's note while this phone still holds ticks the server hasn't got
// (#6903): "Still saving 7 climbs. Your totals catch up once they're in.", or
// the offline wording when there is no connection to save them over.

import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../Icon';
import { Text } from '../../Text';
import { useTheme } from '../../../providers/theme-provider';
import { borderRadius, spacing } from '../../../theme/tokens';

export const WorkoutSyncingNote = memo(function WorkoutSyncingNote({
  pendingTicks,
  offline = false,
}: {
  pendingTicks: number;
  offline?: boolean;
}) {
  const { t } = useTranslation('session');
  const { systemColors } = useTheme();
  if (pendingTicks <= 0) return null;
  const message = offline
    ? t('mobile.workoutSummary.stillSavingOffline', { count: pendingTicks })
    : t('mobile.workoutSummary.stillSaving', { count: pendingTicks });
  return (
    <View
      style={[styles.note, { backgroundColor: systemColors.secondaryBackground }]}
      accessible
      accessibilityLabel={message}
      accessibilityLiveRegion="polite"
      testID="workout-syncing-note"
    >
      <Icon name={offline ? 'offline.unavailable' : 'refresh'} size={16} color={systemColors.secondaryLabel} />
      <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.text}>
        {message}
      </Text>
    </View>
  );
});

const styles = StyleSheet.create({
  note: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    padding: spacing[3],
    borderRadius: borderRadius.lg,
  },
  text: {
    flex: 1,
  },
});
