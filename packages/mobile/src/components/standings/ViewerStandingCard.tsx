import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { nextRankGap, shouldShowPercentile, tiedWithCount } from '@boardsesh/leaderboard';
import { Text } from '../Text';
import { useTheme } from '../../providers/theme-provider';
import { borderRadius, spacing } from '../../theme/tokens';
import type { StandingsViewer } from '../../lib/graphql/hooks/use-standings';

/**
 * Where the reader sits.
 *
 * Two things this deliberately does NOT do:
 *
 * - It never names the climber above you. "Two more and you're 81st" names a
 *   rank; "two more and you pass Priya" names a person who may be standing in
 *   the same room.
 * - It hides the percentile inside a big tie. **1,026 of 1,203 globally active
 *   climbers share a score with ten or more others**, and there the number
 *   moves four points for one climb and then sits still for a week. The honest
 *   line is the tie itself, which is also the motivating one: a single climb
 *   breaks you out of a crowd of 47.
 */

type ViewerStandingCardProps = {
  viewer: StandingsViewer;
  cohortSize: number;
};

export function ViewerStandingCard({ viewer, cohortSize }: ViewerStandingCardProps) {
  const { t } = useTranslation('boards');
  const { systemColors, brandColors } = useTheme();

  const showPercentile = shouldShowPercentile({ cohortSize, tieSize: viewer.tieSize });
  const othersTied = tiedWithCount(viewer);
  const gap = useMemo(() => nextRankGap(viewer, viewer.scoresAbove), [viewer]);

  return (
    <View style={[styles.card, { backgroundColor: systemColors.secondaryBackground }]}>
      <View style={styles.headline}>
        <Text variant="headline">
          {othersTied > 0
            ? t('standings.viewer.rankTied', { rank: viewer.rank, others: othersTied, count: othersTied })
            : t('standings.viewer.rankOf', { rank: viewer.rank, total: cohortSize })}
        </Text>
        <Text variant="subheadline" color={systemColors.secondaryLabel}>
          {t('standings.viewer.climbs', { count: viewer.score })}
        </Text>
      </View>

      {showPercentile ? (
        <View style={styles.percentileTrack} accessibilityRole="progressbar">
          <View
            style={[
              styles.percentileFill,
              { backgroundColor: brandColors.accent, width: `${Math.round(viewer.percentile * 100)}%` },
            ]}
          />
        </View>
      ) : null}

      {gap ? (
        <Text variant="footnote" color={systemColors.secondaryLabel}>
          {t('standings.viewer.nextRank', { count: gap.climbsNeeded, rank: gap.rank })}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: spacing[4],
    padding: spacing[4],
    borderRadius: borderRadius.lg,
    gap: spacing[2],
  },
  headline: {
    gap: spacing[1],
  },
  percentileTrack: {
    height: 6,
    borderRadius: 3,
    overflow: 'hidden',
    backgroundColor: 'rgba(127,127,127,0.25)',
  },
  percentileFill: {
    height: 6,
    borderRadius: 3,
  },
});
