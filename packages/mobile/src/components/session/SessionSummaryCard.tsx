import { View, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { SessionDetail, SocialEntityType } from '@boardsesh/shared-schema';
import { formatTickAbsoluteTime, getLayoutDisplayName } from '@boardsesh/profile-stats';
import { formatBoardDisplayName } from '@boardsesh/board-config';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { Card } from '../Card';
import { PressableSurface } from '../PressableSurface';
import { AvatarGroup } from '../you/AvatarGroup';
import { FeedSocialRow } from '../you/FeedSocialRow';
import { spacing } from '../../theme/tokens';
import { useTheme } from '../../providers/theme-provider';
import { formatSessionWhen } from '../../lib/format-session-when';
import { gradeChartColor } from '../you/profile-chart-colors';
import { useGradeFormat } from '../../hooks/use-grade-format';

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
  onOpenComments: (entityId: string, entityType: SocialEntityType) => void;
  voteSummary?: { upvotes: number; userVote: number | null };
  /** Owner-only: open the edit sheet (name + recap). Absent for non-owners. */
  onEditSession?: () => void;
};

/**
 * A compact recap: session context, sends and hardest grade lead. Long notes
 * live after the grade chart so the session's results remain easy to scan.
 */
export function SessionSummaryCard({
  session,
  title,
  titleIsDate,
  onOpenComments,
  voteSummary,
  onEditSession,
}: SessionSummaryCardProps) {
  const { systemColors, colorScheme } = useTheme();
  const { t } = useTranslation('you');
  const { t: tSession } = useTranslation('session');
  const { t: tFeed } = useTranslation('feed');
  const { formatGrade } = useGradeFormat();

  // Named sessions show the full date+time on line 2; unnamed sessions already
  // carry the date in the title, so line 2 becomes a human "Sunday morning".
  const whenLine = titleIsDate
    ? formatSessionWhen(session.lastTickAt, tSession)
    : formatTickAbsoluteTime(session.lastTickAt, 'MMM D, YYYY · h:mm A');
  const board = Array.from(
    new Set(
      session.boardTypes.flatMap((boardType) => {
        const boardTicks = session.ticks.filter((tick) => tick.boardType === boardType);
        return boardTicks.length > 0
          ? boardTicks.map((tick) => getLayoutDisplayName(tick.boardType, tick.layoutId))
          : [formatBoardDisplayName(boardType)];
      }),
    ),
  ).join(' · ');
  const duration =
    session.durationMinutes != null && session.durationMinutes > 0 ? formatDuration(session.durationMinutes) : null;

  return (
    <Card style={styles.card}>
      <View style={styles.headerRow}>
        <AvatarGroup participants={session.participants} size={32} />
        <View style={styles.headerText}>
          <Text variant="title3" numberOfLines={2}>
            {title}
          </Text>
          <Text variant="caption1" color={systemColors.secondaryLabel}>
            {whenLine}
          </Text>
        </View>
        {onEditSession ? (
          <PressableSurface
            onPress={onEditSession}
            feedback="opacity"
            opacityTo={0.6}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={tSession('detail.editSession')}
            style={styles.editButton}
          >
            <Icon name="edit" size={20} color={systemColors.secondaryLabel} />
          </PressableSurface>
        ) : null}
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

      <View style={styles.headlineStats}>
        <View style={styles.headlineStat}>
          <Text variant="largeTitle" style={styles.statNumber}>
            {session.totalSends}
          </Text>
          <Text variant="subheadline" color={systemColors.secondaryLabel}>
            {t('mobile.sessions.weekly.sends')}
          </Text>
        </View>
        {session.hardestGrade ? (
          <View style={[styles.headlineStat, styles.gradeStat, { borderLeftColor: systemColors.separator }]}>
            <View style={styles.gradeValue}>
              <View
                style={[styles.gradeAccent, { backgroundColor: gradeChartColor(session.hardestGrade, colorScheme) }]}
              />
              <Text variant="largeTitle" color={systemColors.label} style={[styles.statNumber, styles.gradeNumber]}>
                {formatGrade(session.hardestGrade) ?? session.hardestGrade}
              </Text>
            </View>
            <Text variant="subheadline" color={systemColors.secondaryLabel}>
              {tFeed('sessionFeedCard.hardest')}
            </Text>
          </View>
        ) : null}
      </View>
      <View style={styles.secondaryStats}>
        <View style={styles.metaItem}>
          <Icon name="flash" size={14} color={systemColors.secondaryLabel} />
          <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.secondaryNumber}>
            {tSession('detail.flashesCount', { count: session.totalFlashes })}
          </Text>
        </View>
        <View style={styles.metaItem}>
          <Icon name="circle" size={14} color={systemColors.secondaryLabel} />
          <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.secondaryNumber}>
            {tSession('detail.attemptsCount', { count: session.totalAttempts })}
          </Text>
        </View>
      </View>

      <View style={styles.social}>
        {/* A daily-highlight session has no board_sessions row of its own, so its
            votes/comments hang off the day's hardest tick instead — sessionId
            (possibly the synthetic `daily:<user>:<date>` feed key) would be
            rejected by the backend. socialEntityType/Id is the resolved target;
            see SessionDetail. */}
        <FeedSocialRow
          entityId={session.socialEntityId}
          entityType={session.socialEntityType}
          upvotes={voteSummary?.upvotes ?? session.upvotes}
          userVote={voteSummary?.userVote ?? null}
          commentCount={session.commentCount}
          onOpenComments={(entityId) => onOpenComments(entityId, session.socialEntityType)}
        />
      </View>
    </Card>
  );
}

/** Full goal and recap remain readable below the session's grade distribution. */
export function SessionNotesCard({ session }: { session: Pick<SessionDetail, 'goal' | 'notes'> }) {
  const { systemColors } = useTheme();
  const { t } = useTranslation('session');
  const notes = session.notes?.trim();
  if (!session.goal && !notes) return null;
  return (
    <Card style={styles.card}>
      {session.goal ? (
        <View style={styles.goal}>
          <Icon name="flag" size={14} color={systemColors.secondaryLabel} />
          <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.goalText}>
            {session.goal}
          </Text>
        </View>
      ) : null}
      {notes ? (
        <View style={styles.notes}>
          <Text variant="caption1" color={systemColors.secondaryLabel}>
            {t('summary.recapTitle')}
          </Text>
          <Text variant="body">{notes}</Text>
        </View>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { marginHorizontal: spacing[4], marginTop: spacing[4], gap: spacing[1] },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing[3] },
  headerText: { flex: 1 },
  editButton: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  metaRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing[2], marginTop: spacing[1] },
  metaItem: { flexDirection: 'row', alignItems: 'center', gap: spacing[1] },
  goal: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing[2], marginTop: spacing[2] },
  goalText: { flex: 1 },
  notes: { marginTop: spacing[2], gap: spacing[1] },
  headlineStats: { flexDirection: 'row', marginTop: spacing[3] },
  headlineStat: { flex: 1, minWidth: 0, gap: spacing[1] },
  gradeStat: { paddingLeft: spacing[4], borderLeftWidth: StyleSheet.hairlineWidth },
  gradeValue: { flexDirection: 'row', alignItems: 'center', gap: spacing[2], minWidth: 0 },
  gradeAccent: { width: spacing[1], height: spacing[6], borderRadius: spacing[1], flexShrink: 0 },
  gradeNumber: { flexShrink: 1, minWidth: 0 },
  statNumber: { fontWeight: '700', fontVariant: ['tabular-nums'] },
  secondaryNumber: { fontWeight: '600', fontVariant: ['tabular-nums'] },
  secondaryStats: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[4], marginTop: spacing[3] },
  social: { marginTop: spacing[2] },
});
