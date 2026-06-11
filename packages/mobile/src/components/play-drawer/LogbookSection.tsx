import { memo, useMemo } from 'react';
import { View, ActivityIndicator, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { BoardName } from '@boardsesh/shared-schema';
import { useLogbook } from '@boardsesh/board-react';
import { groupEntriesByAngle } from '@boardsesh/profile-stats';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { LogbookEntryRow } from './LogbookEntryRow';
import { useLocalPendingTicks } from '../../hooks/use-local-ticks';
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
  const { data: pendingTicks = 0 } = useLocalPendingTicks(climbUuid, boardName);

  const entries = useMemo(
    () =>
      logbook
        .filter((entry) => entry.climb_uuid === climbUuid)
        .sort((a, b) => new Date(b.climbed_at).getTime() - new Date(a.climbed_at).getTime()),
    [logbook, climbUuid],
  );

  // Only Tension/Decoy log mirrored sends, so the mirror tag is board-gated.
  const showMirrorTag = boardName === 'tension' || boardName === 'decoy';
  const pendingRow =
    pendingTicks > 0 ? (
      <View style={styles.row}>
        <Icon name="history" size={20} color={iosSystemColors.systemOrange} />
        <Text variant="subheadline" color={iosSystemColors.systemOrange}>
          {t('mobile.logbook.pendingSync', { count: pendingTicks })}
        </Text>
      </View>
    ) : null;

  // Entries bucketed under per-angle headers, steepest angle first (the
  // hardest version of the climb leads). Each header recaps the lifetime at
  // that angle — "13 tries over 3 sessions · 2 sends" — so the rows below drop
  // their own angle chip. Sessions = distinct days, matching the logbook's
  // day-scoped grouping.
  const angleSections = useMemo(() => groupEntriesByAngle(entries), [entries]);

  if (entries.length > 0) {
    return (
      <View style={styles.container}>
        {angleSections.map((section) => {
          // Segments pluralize individually; the recap TEMPLATE owns word order
          // and joining so a locale can rearrange the clauses.
          const triesLabel = t('mobile.logbook.lifetimeTries', { count: section.stats.totalTries });
          const sessionsLabel = t('mobile.logbook.lifetimeSessions', { count: section.stats.sessionCount });
          const recap =
            section.stats.sendCount > 0
              ? t('mobile.logbook.lifetimeRecapWithSends', {
                  tries: triesLabel,
                  sessions: sessionsLabel,
                  sends: t('mobile.logbook.lifetimeSends', { count: section.stats.sendCount }),
                })
              : t('mobile.logbook.lifetimeRecap', { tries: triesLabel, sessions: sessionsLabel });
          return (
            <View key={section.angle} style={styles.angleSection}>
              <View
                accessible
                accessibilityRole="header"
                accessibilityLabel={`${section.angle}°, ${recap}`}
                style={styles.angleHeader}
              >
                <Text variant="caption1" color={iosSystemColors.systemGray} style={styles.angleHeaderLabel}>
                  {`${section.angle}°`}
                </Text>
                <Text
                  variant="caption1"
                  color={iosSystemColors.systemGray}
                  style={styles.angleHeaderRecap}
                  numberOfLines={1}
                >
                  {recap}
                </Text>
              </View>
              {section.entries.map((entry) => (
                <LogbookEntryRow key={entry.uuid} entry={entry} showMirrorTag={showMirrorTag} showAngleChip={false} />
              ))}
            </View>
          );
        })}
        {pendingRow}
      </View>
    );
  }

  // Guard the fetch so the summary fallback never flashes before entries land.
  if (isLoading) {
    return (
      <View style={styles.container}>
        <View style={styles.emptyContainer}>
          <ActivityIndicator size="small" color={iosSystemColors.systemGray} />
        </View>
        {pendingRow}
      </View>
    );
  }

  // Fallback for unauthenticated/no-detail: show the denormalised count summary.
  const sends = userAscents ?? 0;
  const attempts = userAttempts ?? 0;

  if (sends === 0 && attempts === 0) {
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
  angleSection: {
    gap: spacing[1],
  },
  angleHeader: {
    flexDirection: 'row',
    // Wrap instead of colliding at accessibility type sizes — the recap drops
    // below the angle label when one line can't hold both.
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    columnGap: spacing[2],
    marginTop: spacing[1],
  },
  angleHeaderLabel: {
    fontWeight: '600',
  },
  angleHeaderRecap: {
    flexShrink: 1,
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
