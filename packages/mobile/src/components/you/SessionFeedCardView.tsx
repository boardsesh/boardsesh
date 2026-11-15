import type { SessionFeedItem } from '@boardsesh/shared-schema';
import { memo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { useTheme } from '../../providers/theme-provider';
import { borderRadius, spacing } from '../../theme/tokens';
import { Card } from '../Card';
import { Icon } from '../Icon';
import { PressableSurface } from '../PressableSurface';
import { Text } from '../Text';
import { WorkoutHeadlineChip } from '../session/workout/WorkoutHeadlineChip';
import type { WorkoutHeadlineView } from '../session/workout/types';
import { workoutHeadlineText } from '../session/workout/workout-summary-format';

export type SessionFeedCardViewProps = {
  session: SessionFeedItem;
  metaLine: string;
  displayHardestGrade: string | null;
  onPress: () => void;
  workoutHeadline?: WorkoutHeadlineView;
  avatars: ReactNode;
  hero?: ReactNode;
  gradeStrip?: ReactNode;
  social?: ReactNode;
};
const HERO_MEDIA = { width: 84, height: 104 } as const;

/** Shared card presentation. Live actions, media and votes are supplied by its owner. */
export const SessionFeedCardView = memo(function SessionFeedCardView({
  session,
  metaLine,
  displayHardestGrade,
  onPress,
  workoutHeadline,
  avatars,
  hero,
  gradeStrip,
  social,
}: SessionFeedCardViewProps) {
  const { t } = useTranslation('feed');
  const { t: tSession } = useTranslation('session');
  const { systemColors } = useTheme();
  const names = session.participants
    .map((participant) => participant.displayName)
    .filter(Boolean)
    .join(', ');
  const title = names || t('sessionFeedCard.climbCount', { count: session.tickCount });
  const statLine = [
    t('sessionFeedCard.sendsCount', { count: session.totalSends }),
    session.totalFlashes > 0 ? t('sessionFeedCard.flashesCount', { count: session.totalFlashes }) : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const cardAccessibilityLabel = [
    title,
    metaLine,
    t('sessionFeedCard.sendsCount', { count: session.totalSends }),
    displayHardestGrade ? t('sessionFeedCard.hardestGrade', { grade: displayHardestGrade }) : null,
    workoutHeadline ? workoutHeadlineText(workoutHeadline, tSession).spoken : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <View testID="session-feed-card" style={styles.wrapper}>
      <Card>
        {/* Header opens the SESSION; the hero opens the beta video (when present)
            or the hardest-send CLIMB. Two tap targets so session detail stays
            reachable. */}
        <PressableSurface
          onPress={onPress}
          feedback="opacity"
          accessibilityRole="button"
          accessibilityLabel={cardAccessibilityLabel}
          accessibilityHint={t('sessionFeedCard.openHint')}
          style={styles.heroPressable}
        >
          <View style={styles.header}>
            {avatars}
            <View style={styles.headerText}>
              <Text variant="subheadline" style={styles.title} numberOfLines={1}>
                {title}
              </Text>
              {/* One line, sends first: counts in a bolder secondary colour, the
                  time·duration·board tail quieter. Weight+colour carry the tiers
                  at one 12pt size, so there's no orphaned second line. */}
              <Text variant="caption1" color={systemColors.secondaryLabel} numberOfLines={1} style={styles.metaLine}>
                {statLine ? (
                  <Text variant="caption1" color={systemColors.secondaryLabel} style={styles.statEmphasis}>
                    {statLine}
                  </Text>
                ) : null}
                {statLine ? ' · ' : ''}
                {metaLine}
              </Text>
            </View>
          </View>

          {workoutHeadline ? (
            <View style={styles.workoutChip}>
              <WorkoutHeadlineChip headline={workoutHeadline} />
            </View>
          ) : null}

          {session.goal ? (
            <View style={styles.goal}>
              <Icon name="flag" size={13} color={systemColors.secondaryLabel} />
              <Text variant="footnote" color={systemColors.secondaryLabel} numberOfLines={2} style={styles.flex}>
                {session.goal}
              </Text>
            </View>
          ) : null}
        </PressableSurface>

        {/* The session's grade SPREAD — the "this is a session" signal the
            single-climb hero can't carry. Self-hides unless there are 2+ grades. */}
        {gradeStrip}

        {hero}

        <View style={[styles.divider, { backgroundColor: systemColors.separator }]} />

        <View style={styles.footer}>{social}</View>
      </Card>
    </View>
  );
});

const styles = StyleSheet.create({
  wrapper: { marginHorizontal: spacing[4], marginTop: spacing[3] },
  heroPressable: {
    margin: -spacing[1],
    padding: spacing[1],
    borderRadius: borderRadius.md,
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing[3] },
  headerText: { flex: 1 },
  title: { fontWeight: '600' },
  metaLine: { marginTop: 2 },
  statEmphasis: { fontWeight: '600' },
  workoutChip: { marginTop: spacing[2] },
  goal: { flexDirection: 'row', alignItems: 'center', gap: spacing[2], marginTop: spacing[2] },
  hero: { flexDirection: 'row', gap: spacing[3], marginTop: spacing[2] },
  media: { width: HERO_MEDIA.width, height: HERO_MEDIA.height, borderRadius: borderRadius.md },
  mediaFallback: { alignItems: 'center', justifyContent: 'center' },
  betaMedia: { width: HERO_MEDIA.width, height: HERO_MEDIA.height, borderRadius: borderRadius.md, overflow: 'hidden' },
  playOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playBadge: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  platformBadge: {
    position: 'absolute',
    top: 4,
    left: 4,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.9)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroDetails: { flex: 1, gap: spacing[1], justifyContent: 'center' },
  nameRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing[2] },
  gradeText: { fontWeight: '700' },
  betaEyebrow: { fontWeight: '700', letterSpacing: 0.6 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: spacing[1] },
  statusText: { fontWeight: '600' },
  divider: { height: StyleSheet.hairlineWidth, marginTop: spacing[2] },
  footer: { marginTop: spacing[2] },
  flex: { flex: 1 },
});
