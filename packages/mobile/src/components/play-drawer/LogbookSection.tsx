import { memo, useMemo } from 'react';
import { View, ActivityIndicator, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { BoardName } from '@boardsesh/shared-schema';
import { useLogbook } from '@boardsesh/board-react';
import { deriveAngleLifetimeStats } from '@boardsesh/profile-stats';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { LogbookEntryRow } from './LogbookEntryRow';
import { iosSystemColors } from '../../theme/ios-colors';
import { spacing } from '../../theme/tokens';

type LogbookSectionProps = {
  climbUuid: string;
  boardName: string;
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
  const { logbook, isLoading } = useLogbook(boardName as BoardName, [climbUuid]);

  const entries = useMemo(
    () =>
      logbook
        .filter((entry) => entry.climb_uuid === climbUuid)
        .sort((a, b) => new Date(b.climbed_at).getTime() - new Date(a.climbed_at).getTime()),
    [logbook, climbUuid],
  );

  // Only Tension/Decoy log mirrored sends, so the mirror tag is board-gated.
  const showMirrorTag = boardName === 'tension' || boardName === 'decoy';

  // Lifetime per angle — "13 tries over 3 sessions". The logbook list shows
  // per-day truth; the climb's own view is where the whole journey lives.
  // Sessions = distinct days, matching the logbook's day-scoped grouping.
  const angleLifetime = useMemo(() => deriveAngleLifetimeStats(entries), [entries]);

  if (entries.length > 0) {
    return (
      <View style={styles.container}>
        {angleLifetime.length > 0 ? (
          <View style={styles.lifetimeBlock}>
            {angleLifetime.map((stats) => (
              <Text key={stats.angle} variant="footnote" color={iosSystemColors.systemGray}>
                {`${stats.angle}° — ${t('mobile.logbook.lifetimeTries', { count: stats.totalTries })} ${t('mobile.logbook.lifetimeSessions', { count: stats.sessionCount })}`}
                {stats.sendCount > 0 ? ` · ${t('mobile.logbook.lifetimeSends', { count: stats.sendCount })}` : ''}
              </Text>
            ))}
          </View>
        ) : null}
        {entries.map((entry) => (
          <LogbookEntryRow key={entry.uuid} entry={entry} showMirrorTag={showMirrorTag} />
        ))}
      </View>
    );
  }

  // Guard the fetch so the summary fallback never flashes before entries land.
  if (isLoading) {
    return (
      <View style={styles.emptyContainer}>
        <ActivityIndicator size="small" color={iosSystemColors.systemGray} />
      </View>
    );
  }

  // Fallback for unauthenticated/no-detail: show the denormalised count summary.
  const sends = userAscents ?? 0;
  const attempts = userAttempts ?? 0;

  if (sends === 0 && attempts === 0) {
    return (
      <View style={styles.emptyContainer}>
        <Icon name="history" size={20} color={iosSystemColors.systemGray} />
        <Text variant="subheadline" color={iosSystemColors.systemGray}>
          {t('mobile.logbook.noEntries')}
        </Text>
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
    <View style={styles.row}>
      <Icon name="tick" size={20} color={iosSystemColors.systemGreen} />
      <Text variant="body">{summaryText}</Text>
    </View>
  );
});

const styles = StyleSheet.create({
  lifetimeBlock: {
    gap: 2,
    marginBottom: spacing[2],
  },
  container: {
    gap: spacing[1],
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
