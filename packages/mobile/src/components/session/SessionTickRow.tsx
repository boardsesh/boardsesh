import { memo } from 'react';
import { View, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { SessionDetailTick, SessionFeedParticipant } from '@boardsesh/shared-schema';
import { getGradeTextColor } from '@boardsesh/play-view';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { type IconName } from '../icon-map';
import { ListRow } from '../ListRow';
import { Avatar } from '../Avatar';
import { FeedSocialRow } from '../you/FeedSocialRow';
import { gradeBadgeColor } from '../you/profile-chart-colors';
import { brandColors } from '../../theme/colors';
import { iosSystemColors } from '../../theme/ios-colors';
import { spacing, borderRadius } from '../../theme/tokens';

type TickStatusMeta = { icon: IconName; color: string };

function statusMeta(status: string): TickStatusMeta {
  if (status === 'flash') return { icon: 'flash', color: brandColors.warning };
  if (status === 'send') return { icon: 'tick', color: brandColors.success };
  return { icon: 'circle', color: iosSystemColors.systemGray };
}

type TFunc = (key: string, options?: Record<string, unknown>) => string;

function ordinalSuffix(n: number, t: TFunc): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return t('detail.ordinalDefault', { n });
  switch (n % 10) {
    case 1:
      return t('detail.ordinalFirst', { n });
    case 2:
      return t('detail.ordinalSecond', { n });
    case 3:
      return t('detail.ordinalThird', { n });
    default:
      return t('detail.ordinalDefault', { n });
  }
}

/** Attempt subtitle, mirroring web's `formatAttemptText`. */
function formatAttemptText(tick: SessionDetailTick, t: TFunc): string | null {
  if (tick.status === 'flash') return null;
  const sessionAttempts = tick.attemptCount;
  const total = tick.totalAttempts;

  if (tick.status === 'send') {
    const parts = [t('detail.attemptOnNth', { ordinal: ordinalSuffix(sessionAttempts, t) })];
    if (total != null && total > sessionAttempts) parts.push(t('detail.totalAttempts', { count: total }));
    return parts.join(', ');
  }

  const parts = [t('detail.attemptCount', { count: sessionAttempts })];
  if (total != null && total > sessionAttempts) parts.push(t('detail.totalAttempts', { count: total }));
  return parts.join(', ');
}

type SessionTickRowProps = {
  tick: SessionDetailTick;
  isMultiUser: boolean;
  /** Participant who logged the tick, for the leading avatar in multi-user sessions. */
  participant?: SessionFeedParticipant;
  onPress: (tick: SessionDetailTick) => void;
  onOpenComments: (tickUuid: string) => void;
};

export const SessionTickRow = memo(function SessionTickRow({
  tick,
  isMultiUser,
  participant,
  onPress,
  onOpenComments,
}: SessionTickRowProps) {
  const { t } = useTranslation('session');

  const meta = statusMeta(tick.status);
  const attemptText = formatAttemptText(tick, t);
  const subtitleParts = [attemptText, tick.comment ?? null].filter((part): part is string => !!part);
  const subtitle = subtitleParts.length > 0 ? subtitleParts.join(' · ') : undefined;

  return (
    <ListRow
      title={tick.climbName ?? t('detail.unknownClimb')}
      subtitle={subtitle}
      onPress={() => onPress(tick)}
      leading={
        isMultiUser ? (
          <Avatar uri={participant?.avatarUrl} name={participant?.displayName} size={28} />
        ) : (
          <View style={[styles.badge, { backgroundColor: meta.color }]}>
            <Icon name={meta.icon} size={14} color={iosSystemColors.white} />
          </View>
        )
      }
      trailing={
        <View style={styles.trailing}>
          {tick.difficultyName ? (
            <View style={[styles.gradePill, { backgroundColor: gradeBadgeColor(tick.difficultyName) }]}>
              <Text
                variant="caption1"
                color={getGradeTextColor(gradeBadgeColor(tick.difficultyName))}
                style={styles.gradeText}
              >
                {tick.difficultyName}
              </Text>
            </View>
          ) : null}
          <FeedSocialRow
            entityId={tick.uuid}
            entityType="tick"
            upvotes={tick.upvotes}
            userVote={null}
            onOpenComments={onOpenComments}
            compact
          />
        </View>
      }
    />
  );
});

const styles = StyleSheet.create({
  badge: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  trailing: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
  gradePill: {
    paddingHorizontal: spacing[2],
    paddingVertical: 2,
    borderRadius: borderRadius.sm,
  },
  gradeText: { fontWeight: '700' },
});
