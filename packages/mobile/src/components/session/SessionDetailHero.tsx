import { View, StyleSheet } from 'react-native';
import type { SessionDetail } from '@boardsesh/shared-schema';
import { formatTickAbsoluteTime } from '@boardsesh/profile-stats';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { AvatarGroup } from '../you/AvatarGroup';
import { spacing } from '../../theme/tokens';
import { useTheme } from '../../providers/theme-provider';

function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

type SessionDetailHeroProps = {
  session: SessionDetail;
  /** Pre-resolved display name (session name or a generated fallback). */
  title: string;
};

/** Hero block for the session-detail screen: avatars, name, date, board, duration, goal. */
export function SessionDetailHero({ session, title }: SessionDetailHeroProps) {
  const { systemColors } = useTheme();

  const absoluteDate = formatTickAbsoluteTime(session.lastTickAt, 'MMM D, YYYY · h:mm A');

  return (
    <View style={styles.container}>
      <AvatarGroup participants={session.participants} size={44} />
      <Text variant="title2" style={styles.title}>
        {title}
      </Text>
      <Text variant="subheadline" color={systemColors.secondaryLabel}>
        {absoluteDate}
      </Text>

      {session.boardTypes.length > 0 && (
        <Text variant="footnote" color={systemColors.tertiaryLabel} style={styles.boards}>
          {session.boardTypes.join(' · ')}
        </Text>
      )}

      <View style={styles.metaRow}>
        {session.durationMinutes != null && session.durationMinutes > 0 && (
          <View style={styles.metaItem}>
            <Icon name="clock" size={14} color={systemColors.secondaryLabel} />
            <Text variant="footnote" color={systemColors.secondaryLabel}>
              {formatDuration(session.durationMinutes)}
            </Text>
          </View>
        )}
      </View>

      {session.goal ? (
        <View style={styles.goal}>
          <Icon name="flag" size={14} color={systemColors.secondaryLabel} />
          <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.goalText}>
            {session.goal}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[4],
    gap: spacing[1],
  },
  title: { fontWeight: '700', marginTop: spacing[2] },
  boards: { marginTop: spacing[1] },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: spacing[4], marginTop: spacing[2] },
  metaItem: { flexDirection: 'row', alignItems: 'center', gap: spacing[1] },
  goal: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing[2], marginTop: spacing[2] },
  goalText: { flex: 1 },
});
