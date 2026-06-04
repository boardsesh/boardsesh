import { memo, useMemo } from 'react';
import { View, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { SessionFeedItem } from '@boardsesh/shared-schema';
import { formatTickRelativeTime } from '@boardsesh/profile-stats';
import { getGradeTextColor } from '@boardsesh/play-view';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { type IconName } from '../icon-map';
import { Card } from '../Card';
import { AvatarGroup } from './AvatarGroup';
import { FeedSocialRow } from './FeedSocialRow';
import { StackedBarChart } from './YouCharts';
import { gradeBadgeColor, buildSessionGradeBars } from './profile-chart-colors';
import { brandColors, withAlpha } from '../../theme/colors';
import { iosSystemColors } from '../../theme/ios-colors';
import { spacing, borderRadius } from '../../theme/tokens';
import { useTheme } from '../../providers/theme-provider';

type SessionFeedCardProps = {
  session: SessionFeedItem;
  /** Per-viewer vote summary (count + userVote) for this session, if loaded. */
  voteSummary?: { upvotes: number; userVote: number | null };
  onOpenComments: (sessionId: string) => void;
  onPress: (sessionId: string) => void;
};

function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

export const SessionFeedCard = memo(function SessionFeedCard({
  session,
  voteSummary,
  onOpenComments,
  onPress,
}: SessionFeedCardProps) {
  const { t } = useTranslation('feed');
  const { systemColors } = useTheme();

  const names = session.participants
    .map((participant) => participant.displayName)
    .filter((name): name is string => !!name)
    .join(', ');

  const gradeBars = useMemo(() => buildSessionGradeBars(session.gradeDistribution), [session.gradeDistribution]);

  return (
    <View style={styles.wrapper}>
      {/* Only the summary region navigates; the social row sits below as a
          sibling so vote/comment taps never trigger navigation. */}
      <Card onPress={() => onPress(session.sessionId)}>
        <View style={styles.header}>
          <AvatarGroup participants={session.participants} size={32} />
          <View style={styles.headerText}>
            <Text variant="subheadline" style={styles.names} numberOfLines={1}>
              {names || t('sessionFeedCard.climbCount', { count: session.tickCount })}
            </Text>
            <View style={styles.meta}>
              <Text variant="caption1" color={systemColors.tertiaryLabel}>
                {formatTickRelativeTime(session.lastTickAt)}
              </Text>
              {session.durationMinutes != null && session.durationMinutes > 0 && (
                <View style={styles.metaItem}>
                  <Icon name="clock" size={11} color={systemColors.tertiaryLabel} />
                  <Text variant="caption1" color={systemColors.tertiaryLabel}>
                    {formatDuration(session.durationMinutes)}
                  </Text>
                </View>
              )}
            </View>
          </View>
          {session.hardestGrade ? <HardestBadge grade={session.hardestGrade} label={t('sessionFeedCard.hardest')} /> : null}
        </View>

        {session.goal ? (
          <View style={styles.goal}>
            <Icon name="flag" size={13} color={systemColors.secondaryLabel} />
            <Text variant="footnote" color={systemColors.secondaryLabel} numberOfLines={2}>
              {session.goal}
            </Text>
          </View>
        ) : null}

        {/* Hero stat: total sends, the headline number of the session. */}
        <View style={styles.hero}>
          <Text variant="title2" color={brandColors.success}>
            {session.totalSends}
          </Text>
          <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.heroLabel}>
            {t('sessionFeedCard.sendsLabel')}
          </Text>
        </View>

        <View style={styles.chips}>
          {session.totalFlashes > 0 && (
            <Chip icon="flash" label={`${session.totalFlashes}`} tint={brandColors.warning} />
          )}
          {session.totalAttempts > 0 && (
            <Chip icon="circle" label={`${session.totalAttempts}`} tint={iosSystemColors.systemGray} />
          )}
        </View>

        {gradeBars && (
          <View style={styles.chart}>
            <StackedBarChart bars={gradeBars} colorBy="grade" height={84} />
          </View>
        )}

        <View style={styles.boardRow}>
          <Text variant="caption1" color={systemColors.tertiaryLabel} numberOfLines={1} style={styles.flex}>
            {session.boardTypes.join(' · ')}
          </Text>
          <Text variant="caption1" color={systemColors.tertiaryLabel}>
            {t('sessionFeedCard.climbCount', { count: session.tickCount })}
          </Text>
        </View>
      </Card>

      <View style={styles.social}>
        <FeedSocialRow
          entityId={session.sessionId}
          upvotes={voteSummary?.upvotes ?? session.upvotes}
          userVote={voteSummary?.userVote ?? null}
          commentCount={session.commentCount}
          onOpenComments={onOpenComments}
        />
      </View>
    </View>
  );
});

function Chip({ icon, label, tint }: { icon: IconName; label: string; tint: string }) {
  return (
    <View style={[styles.chip, { backgroundColor: withAlpha(tint, 0.15) }]}>
      <Icon name={icon} size={12} color={tint} />
      <Text variant="caption1" color={tint} style={styles.chipLabel}>
        {label}
      </Text>
    </View>
  );
}

function HardestBadge({ grade, label }: { grade: string; label: string }) {
  const { systemColors } = useTheme();
  const background = gradeBadgeColor(grade);
  const textColor = getGradeTextColor(background);
  return (
    <View style={styles.hardest}>
      <View style={[styles.hardestPill, { backgroundColor: background }]}>
        <Icon name="flame" size={12} color={textColor} />
        <Text variant="footnote" color={textColor} style={styles.hardestGrade}>
          {grade}
        </Text>
      </View>
      <Text variant="caption2" color={systemColors.tertiaryLabel}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { marginHorizontal: spacing[4], marginTop: spacing[3] },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing[3] },
  headerText: { flex: 1 },
  names: { fontWeight: '600' },
  meta: { flexDirection: 'row', alignItems: 'center', gap: spacing[3], marginTop: 2 },
  metaItem: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  hardest: { alignItems: 'center', gap: 2 },
  hardestPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: spacing[2],
    paddingVertical: 3,
    borderRadius: borderRadius.full,
  },
  hardestGrade: { fontWeight: '700' },
  goal: { flexDirection: 'row', alignItems: 'center', gap: spacing[2], marginTop: spacing[3] },
  hero: { flexDirection: 'row', alignItems: 'baseline', gap: spacing[2], marginTop: spacing[3] },
  heroLabel: { textTransform: 'lowercase' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2], marginTop: spacing[2] },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: spacing[2],
    paddingVertical: 3,
    borderRadius: borderRadius.full,
  },
  chipLabel: { fontWeight: '600' },
  chart: { marginTop: spacing[3] },
  boardRow: { flexDirection: 'row', alignItems: 'center', marginTop: spacing[3], gap: spacing[2] },
  flex: { flex: 1 },
  social: { paddingHorizontal: spacing[1] },
});
