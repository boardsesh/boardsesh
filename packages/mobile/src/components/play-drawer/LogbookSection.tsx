import { memo } from 'react';
import { View, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { iosSystemColors } from '../../theme/ios-colors';
import { spacing } from '../../theme/tokens';
import { useLocalPendingTicks } from '../../hooks/use-local-ticks';

type LogbookSectionProps = {
  climbUuid: string;
  boardName: string;
  angle: number;
  userAscents: number | null | undefined;
  userAttempts: number | null | undefined;
};

export const LogbookSection = memo(function LogbookSection({
  climbUuid,
  boardName,
  userAscents,
  userAttempts,
}: LogbookSectionProps) {
  const { t } = useTranslation('session');

  // Additive: ticks logged on this device that haven't synced to the server yet
  // (e.g. saved offline). Falls back to 0 if there's no local DB / the read fails,
  // so the server summary below renders unchanged in that case.
  const { data: pendingTicks } = useLocalPendingTicks(climbUuid, boardName);
  const pendingCount = pendingTicks ?? 0;

  const sends = userAscents ?? 0;
  const attempts = userAttempts ?? 0;

  const pendingRow =
    pendingCount > 0 ? (
      <View style={styles.row}>
        <Icon name="history" size={20} color={iosSystemColors.systemOrange} />
        <Text variant="subheadline" color={iosSystemColors.systemOrange}>
          {t('mobile.logbook.pendingSync', { count: pendingCount })}
        </Text>
      </View>
    ) : null;

  if (sends === 0 && attempts === 0) {
    // No server-side history yet. Still surface in-flight local ticks if any.
    return (
      <View style={styles.container}>
        <View style={styles.emptyContainer}>
          <Icon name="history" size={20} color={iosSystemColors.systemGray} />
          <Text variant="subheadline" color={iosSystemColors.systemGray}>
            {t('mobile.logbook.noEntries')}
          </Text>
        </View>
        {pendingRow}
      </View>
    );
  }

  let summaryText: string;
  if (sends > 0 && attempts > 0) {
    summaryText = t('mobile.logbook.sendsAndAttempts', { sends, attempts });
  } else if (sends > 0) {
    summaryText = t('mobile.logbook.sendsOnly', { sends });
  } else {
    summaryText = t('mobile.logbook.attemptsOnly', { attempts });
  }

  return (
    <View style={styles.container}>
      <View style={styles.row}>
        <Icon name="tick" size={20} color={iosSystemColors.systemGreen} />
        <Text variant="body">{summaryText}</Text>
      </View>
      {pendingRow}
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    gap: spacing[2],
  },
  emptyContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
});
