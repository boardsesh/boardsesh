import { memo, useMemo } from 'react';
import { View, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { BoardName } from '@boardsesh/shared-schema';
import { useEffectiveClimbStats } from '@boardsesh/board-react';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { DifficultyByAngleChart } from './DifficultyByAngleChart';
import { ClimbModerationStatus } from './ClimbModerationStatus';
import { buildAngleGradeBars } from './community-utils';
import { useClimbStatsHistory } from '../../lib/graphql/hooks';
import { useGradeFormat } from '../../hooks/use-grade-format';
import { formatQuality } from '../../lib/format-climb-stats';
import { iosSystemColors } from '../../theme/ios-colors';
import { spacing } from '../../theme/tokens';

type CommunitySectionProps = {
  climbUuid: string;
  boardName: string;
  layoutId: number;
  angle: number;
  qualityAverage: string;
  ascensionistCount: number;
  /** `climb.is_hidden` — drives the "Hidden by the community" banner above the
   *  stats, before the proposal read lands. */
  isHidden?: boolean;
};

export const CommunitySection = memo(function CommunitySection({
  climbUuid,
  boardName,
  layoutId,
  angle,
  qualityAverage,
  ascensionistCount,
  isHidden = false,
}: CommunitySectionProps) {
  const { t } = useTranslation('session');
  const { gradeFormat } = useGradeFormat();
  const { data: history } = useClimbStatsHistory(boardName, climbUuid);
  const liveStats = useEffectiveClimbStats(boardName as BoardName, layoutId, climbUuid, angle, {
    ascensionistCount,
    qualityAverage,
  });

  const liveQualityAverage = liveStats.qualityAverage;
  const qualityNum = liveQualityAverage == null ? Number.NaN : parseFloat(liveQualityAverage);
  const hasQuality = qualityNum > 0;
  const formattedQuality = hasQuality && liveQualityAverage != null ? formatQuality(liveQualityAverage) : null;
  const hasAscensionists = liveStats.ascensionistCount > 0;

  const starIcons = useMemo(() => {
    if (!hasQuality) return null;
    const fullStars = Math.floor(qualityNum);
    return Array.from({ length: 5 }, (_, starIndex) => (
      <Icon
        key={starIndex}
        name={starIndex < fullStars ? 'star.fill' : 'star'}
        size={14}
        color={starIndex < fullStars ? iosSystemColors.starGold : iosSystemColors.systemGray4}
      />
    ));
  }, [qualityNum, hasQuality]);

  const angleBars = useMemo(() => buildAngleGradeBars(history, gradeFormat), [history, gradeFormat]);

  // A climb nobody has climbed yet can still carry a hide report, so the
  // moderation block rides above the empty state rather than being swallowed by
  // it. `ClimbModerationStatus` renders nothing when there is nothing to say.
  const moderationStatus = (
    <ClimbModerationStatus climbUuid={climbUuid} boardName={boardName} angle={angle} isHidden={isHidden} />
  );

  if (!hasQuality && !hasAscensionists && angleBars.length === 0) {
    return (
      <View style={styles.container}>
        {moderationStatus}
        <View style={styles.emptyContainer}>
          <Icon name="people" size={20} color={iosSystemColors.systemGray} />
          <Text variant="subheadline" color={iosSystemColors.systemGray}>
            {t('mobile.community.empty')}
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {moderationStatus}

      {hasQuality && (
        <View style={styles.statRow}>
          <View style={styles.starsRow}>{starIcons}</View>
          <Text variant="subheadline" color={iosSystemColors.systemGray}>
            {formattedQuality} &middot; {t('mobile.community.avgQuality')}
          </Text>
        </View>
      )}

      {hasAscensionists && (
        <View style={styles.statRow}>
          <Icon name="people" size={18} color={iosSystemColors.systemGray} />
          <Text variant="subheadline">
            {t('mobile.community.ascensionists', { count: liveStats.ascensionistCount })}
          </Text>
        </View>
      )}

      {angleBars.length > 0 && (
        <View style={styles.histogram}>
          <Text variant="footnote" color={iosSystemColors.systemGray}>
            {t('mobile.community.ascentsByAngle')}
          </Text>
          <DifficultyByAngleChart
            data={angleBars}
            accessibilityLabel={t('mobile.community.ascentsByAngle')}
            logScaleLabel={t('mobile.community.logScale')}
          />
        </View>
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    gap: spacing[3],
  },
  emptyContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
  statRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
  starsRow: {
    flexDirection: 'row',
    gap: 2,
  },
  histogram: {
    gap: spacing[2],
  },
});
