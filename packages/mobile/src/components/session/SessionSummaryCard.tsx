import { View, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { SessionDetail } from '@boardsesh/shared-schema';
import { formatTickAbsoluteTime } from '@boardsesh/profile-stats';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { Card } from '../Card';
import { AvatarGroup } from '../you/AvatarGroup';
import { FeedSocialRow } from '../you/FeedSocialRow';
import { spacing } from '../../theme/tokens';
import { useTheme } from '../../providers/theme-provider';
import { formatSessionWhen } from '../../lib/format-session-when';
import { StatTile, GradeTile } from './session-stat-tiles';

function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

type SessionSummaryCardProps = {
  session: SessionDetail;
  /** Pre-resolved display name (session name or a generated date fallback). */
  title: string;
  /** True when the title IS the date (unnamed session) — line 2 then shows a
   *  human "Sunday morning" instead of repeating the date. */
  titleIsDate: boolean;
  onOpenComments: (entityId: string) => void;
  voteSummary?: { upvotes: number; userVote: number | null };
};

/**
 * One merged header unit for the session-detail screen: avatars + title + date +
 * board · duration + goal, the Sends/Flashes/Attempts/Hardest tiles, and the
 * session-level reactions — all inside a single Card. Replaces the old stack of a
 * separate hero, a tiles card, and a standalone social row. Only the hardest-grade
 * tile carries colour, so the grade stays the one accent.
 */
export function SessionSummaryCard({
  session,
  title,
  titleIsDate,
  onOpenComments,
  voteSummary,
}: SessionSummaryCardProps) {
  const { systemColors } = useTheme();
  const { t } = useTranslation('you');
  const { t: tSession } = useTranslation('session');

  // Named sessions show the full date+time on line 2; unnamed sessions already
  // carry the date in the title, so line 2 becomes a human "Sunday morning".
  const whenLine = titleIsDate
    ? formatSessionWhen(session.lastTickAt, tSession)
    : formatTickAbsoluteTime(session.lastTickAt, 'MMM D, YYYY · h:mm A');
  const board = session.boardTypes.join(' · ');
  const duration =
    session.durationMinutes != null && session.durationMinutes > 0 ? formatDuration(session.durationMinutes) : null;

  return (
    <Card style={styles.card}>
      <View style={styles.headerRow}>
        <AvatarGroup participants={session.participants} size={44} />
        <View style={styles.headerText}>
          <Text variant="title2" numberOfLines={1}>
            {title}
          </Text>
          <Text variant="subheadline" color={systemColors.secondaryLabel}>
            {whenLine}
          </Text>
        </View>
      </View>

      {board || duration ? (
        <View style={styles.metaRow}>
          {board ? (
            <Text variant="footnote" color={systemColors.secondaryLabel}>
              {board}
            </Text>
          ) : null}
          {board && duration ? (
            <Text variant="footnote" color={systemColors.secondaryLabel}>
              ·
            </Text>
          ) : null}
          {duration ? (
            <View style={styles.metaItem}>
              <Icon name="clock" size={14} color={systemColors.secondaryLabel} />
              <Text variant="footnote" color={systemColors.secondaryLabel}>
                {duration}
              </Text>
            </View>
          ) : null}
        </View>
      ) : null}

      {session.goal ? (
        <View style={styles.goal}>
          <Icon name="flag" size={14} color={systemColors.secondaryLabel} />
          <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.goalText}>
            {session.goal}
          </Text>
        </View>
      ) : null}

      <View style={styles.tiles}>
        <StatTile value={session.totalSends} label={t('mobile.sessions.weekly.sends')} icon="tick" />
        <StatTile value={session.totalFlashes} label={t('mobile.sessions.weekly.flashes')} icon="flash" />
        <StatTile value={session.totalAttempts} label={t('mobile.sessions.weekly.attempts')} icon="circle" />
        {session.hardestGrade ? <GradeTile grade={session.hardestGrade} /> : null}
      </View>

      <View style={styles.social}>
        <FeedSocialRow
          entityId={session.sessionId}
          upvotes={voteSummary?.upvotes ?? session.upvotes}
          userVote={voteSummary?.userVote ?? null}
          commentCount={session.commentCount}
          onOpenComments={onOpenComments}
        />
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { marginHorizontal: spacing[4], marginTop: spacing[4], gap: spacing[1] },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing[3] },
  headerText: { flex: 1 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: spacing[2], marginTop: spacing[1] },
  metaItem: { flexDirection: 'row', alignItems: 'center', gap: spacing[1] },
  goal: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing[2], marginTop: spacing[2] },
  goalText: { flex: 1 },
  tiles: { flexDirection: 'row', gap: spacing[2], marginTop: spacing[3] },
  social: { marginTop: spacing[3] },
});
