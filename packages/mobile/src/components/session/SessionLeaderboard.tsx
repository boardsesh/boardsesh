import { useMemo } from 'react';
import { View, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { SessionDetailTick, SessionFeedParticipant } from '@boardsesh/shared-schema';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { type IconName } from '../icon-map';
import { Avatar } from '../Avatar';
import { ListRow } from '../ListRow';
import { SectionHeader } from '../SectionHeader';
import { gradeBadgeColor } from '../you/profile-chart-colors';
import { withAlpha } from '../../theme/colors';
import { iosSystemColors } from '../../theme/ios-colors';
import { spacing, borderRadius } from '../../theme/tokens';
import { useTheme } from '../../providers/theme-provider';
import { useGradeFormat } from '../../hooks/use-grade-format';

type SessionLeaderboardProps = {
  participants: SessionFeedParticipant[];
  /** The session's ticks — used to derive each climber's hardest grade. */
  ticks: SessionDetailTick[];
};

type Hardest = { difficulty: number; name: string | null };

/**
 * Per-climber leaderboard for multi-user sessions: ranked by sends (then flashes,
 * hardest grade, fewest attempts), with a crown on the leader and each climber's
 * hardest grade. The leading avatar on each climb row carries per-row attribution;
 * this section owns the totals. Renders nothing for solo sessions.
 */
export function SessionLeaderboard({ participants, ticks }: SessionLeaderboardProps) {
  const { t } = useTranslation('session');
  const { t: tYou } = useTranslation('you');
  const { brandColors } = useTheme();

  // Each climber's hardest grade (max difficulty among their sends/flashes).
  const hardestByUser = useMemo(() => {
    const best = new Map<string, Hardest>();
    for (const tick of ticks) {
      if (tick.status === 'attempt') continue;
      const difficulty = tick.difficulty ?? -1;
      const prev = best.get(tick.userId);
      if (!prev || difficulty > prev.difficulty)
        best.set(tick.userId, { difficulty, name: tick.difficultyName ?? null });
    }
    return best;
  }, [ticks]);

  const ranked = useMemo(
    () =>
      participants
        .map((participant) => ({ participant, hardest: hardestByUser.get(participant.userId) ?? null }))
        .sort((first, second) => {
          if (second.participant.sends !== first.participant.sends)
            return second.participant.sends - first.participant.sends;
          if (second.participant.flashes !== first.participant.flashes)
            return second.participant.flashes - first.participant.flashes;
          const byHardest = (second.hardest?.difficulty ?? -1) - (first.hardest?.difficulty ?? -1);
          if (byHardest !== 0) return byHardest;
          return first.participant.attempts - second.participant.attempts;
        }),
    [participants, hardestByUser],
  );

  if (participants.length <= 1) return null;

  return (
    <View>
      <SectionHeader title={t('mobileDetail.participants')} />
      {ranked.map((entry, index) => (
        <ListRow
          key={entry.participant.userId}
          title={entry.participant.displayName ?? tYou('mobile.unknownName')}
          leading={<RankAvatar participant={entry.participant} isLeader={index === 0} />}
          showSeparator
          trailing={
            <View style={styles.trailing}>
              {entry.hardest?.name ? <HardestPill grade={entry.hardest.name} /> : null}
              <View style={styles.chips}>
                {entry.participant.sends > 0 && (
                  <Chip icon="tick" label={`${entry.participant.sends}`} tint={brandColors.success} />
                )}
                {entry.participant.flashes > 0 && (
                  <Chip icon="flash" label={`${entry.participant.flashes}`} tint={brandColors.warning} />
                )}
                {entry.participant.attempts > 0 && (
                  <Chip icon="circle" label={`${entry.participant.attempts}`} tint={iosSystemColors.systemGray} />
                )}
              </View>
            </View>
          }
        />
      ))}
    </View>
  );
}

/** Avatar with a small crown badge on the session leader. */
function RankAvatar({ participant, isLeader }: { participant: SessionFeedParticipant; isLeader: boolean }) {
  const { brandColors } = useTheme();
  return (
    <View>
      <Avatar uri={participant.avatarUrl} name={participant.displayName} size={32} />
      {isLeader ? (
        <View style={[styles.crownBadge, { backgroundColor: brandColors.accent }]}>
          <Icon name="crown" size={10} color={iosSystemColors.white} />
        </View>
      ) : null}
    </View>
  );
}

/** Quiet grade-tinted pill showing a climber's hardest grade. */
function HardestPill({ grade }: { grade: string }) {
  const { formatGrade } = useGradeFormat();
  const gradeColor = gradeBadgeColor(grade);
  const displayGrade = formatGrade(grade) ?? grade;
  return (
    <View style={[styles.hardestPill, { backgroundColor: withAlpha(gradeColor, 0.15) }]}>
      <Text variant="caption1" color={gradeColor} style={styles.hardestText}>
        {displayGrade}
      </Text>
    </View>
  );
}

function Chip({ icon, label, tint }: { icon: IconName; label: string; tint: string }) {
  return (
    <View style={[styles.chip, { backgroundColor: withAlpha(tint, 0.15) }]}>
      <Icon name={icon} size={11} color={tint} />
      <Text variant="caption1" color={tint} style={styles.chipLabel}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  trailing: { flexDirection: 'row', alignItems: 'center', gap: spacing[2] },
  chips: { flexDirection: 'row', alignItems: 'center', gap: spacing[1] },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: spacing[2],
    paddingVertical: 2,
    borderRadius: borderRadius.full,
  },
  chipLabel: { fontWeight: '600' },
  hardestPill: {
    paddingHorizontal: spacing[2],
    paddingVertical: 2,
    borderRadius: borderRadius.full,
  },
  hardestText: { fontWeight: '700' },
  crownBadge: {
    position: 'absolute',
    top: -4,
    right: -4,
    width: 16,
    height: 16,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
