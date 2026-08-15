import { useCallback } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { GLOBAL_SCOPE, shouldShowPercentile, tiedWithCount } from '@boardsesh/leaderboard';
import { Card } from '../Card';
import { Icon } from '../Icon';
import { Text } from '../Text';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';
import { useStandings } from '../../lib/graphql/hooks/use-standings';

/**
 * The You-tab entry point into Standings.
 *
 * Sits beside the stats summary rather than inside it: the stats card is fed by
 * `useYouProfileData`, and this has its own query, its own loading state and its
 * own reason to be absent. Coupling them would make one card wait on the other.
 *
 * Renders nothing at all until there is something true to say. A climber who
 * logged nothing this month gets no rank — an empty "—th of —" would be worse
 * than silence, and 2,694 of 4,908 registered climbers have never logged a
 * climb at all.
 */
export function StandingsEntryCard() {
  const { t } = useTranslation('boards');
  const router = useRouter();
  const { systemColors, brandColors } = useTheme();

  // Global scope: the only one guaranteed to have the climber in it, and the
  // one whose rank is meaningful without explaining an attribution gap first.
  const query = useStandings(GLOBAL_SCOPE, 'month');
  const head = query.data?.pages?.[0];
  const viewer = head?.viewer ?? null;

  const handlePress = useCallback(() => {
    router.push('/(tabs)/profile/standings');
  }, [router]);

  if (!head || !viewer) return null;

  const othersTied = tiedWithCount(viewer);
  const showPercentile = shouldShowPercentile({ cohortSize: head.totalCount, tieSize: viewer.tieSize });
  const topPercent = Math.max(0.1, Math.round((1 - viewer.percentile) * 1000) / 10);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t('standings.entryCard.accessibility', {
        rank: viewer.rank,
        total: head.totalCount,
      })}
      onPress={handlePress}
    >
      <Card style={styles.card}>
        <View style={styles.headerRow}>
          <Text variant="caption1" color={systemColors.secondaryLabel}>
            {t('standings.title').toUpperCase()}
          </Text>
          <Icon name="chevron.right" size={14} color={systemColors.tertiaryLabel} />
        </View>

        <Text variant="headline">
          {othersTied > 0
            ? t('standings.viewer.rankTied', { rank: viewer.rank, others: othersTied, count: othersTied })
            : t('standings.viewer.rankOf', { rank: viewer.rank, total: head.totalCount })}
        </Text>

        <Text variant="footnote" color={systemColors.secondaryLabel}>
          {t('standings.viewer.climbs', { count: viewer.score })}
        </Text>

        {showPercentile ? (
          <View style={[styles.track, { backgroundColor: systemColors.fill }]}>
            <View
              style={[
                styles.fill,
                { backgroundColor: brandColors.primary, width: `${Math.round(viewer.percentile * 100)}%` },
              ]}
            />
          </View>
        ) : null}

        {showPercentile ? (
          <Text variant="caption1" color={systemColors.secondaryLabel}>
            {t('standings.entryCard.topPercent', { percent: topPercent })}
          </Text>
        ) : null}
      </Card>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: spacing[1],
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  track: {
    height: 6,
    borderRadius: 3,
    overflow: 'hidden',
    marginTop: spacing[2],
  },
  fill: {
    height: 6,
    borderRadius: 3,
  },
});
