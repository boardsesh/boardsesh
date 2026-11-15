import type { SessionFeedTickHighlight } from '@boardsesh/shared-schema';
import { memo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { useTheme } from '../../providers/theme-provider';
import { borderRadius, spacing } from '../../theme/tokens';
import { Icon } from '../Icon';
import type { IconName } from '../icon-map';
import { Text } from '../Text';
import { gradeBadgeColor } from './profile-chart-colors';
const HERO_MEDIA = { width: 84, height: 104 } as const;
function tickStatusLabel(status: string, t: (key: string) => string): string {
  if (status === 'flash') return t('sessionFeedCard.status.flash');
  if (status === 'send') return t('sessionFeedCard.status.send');
  if (status === 'attempt') return t('sessionFeedCard.status.attempt');
  return status;
}
/** Hero for sessions with no beta: enlarged board art + the hardest send. */
export const SessionFeedHeroView = memo(function SessionFeedHeroView({
  tick,
  displayGrade,
  media,
}: {
  tick: SessionFeedTickHighlight;
  displayGrade: string | null;
  media?: ReactNode;
}) {
  const { t } = useTranslation('feed');
  const { systemColors } = useTheme();

  const statusLabel = tickStatusLabel(tick.status, t);
  const statusIcon: IconName = tick.status === 'flash' ? 'flash' : 'check.small';
  const attemptLabel = tick.attemptCount > 1 ? t('sessionFeedCard.attempts', { count: tick.attemptCount }) : null;

  return (
    <View style={styles.hero}>
      {media ?? (
        <View style={[styles.media, styles.mediaFallback, { backgroundColor: systemColors.fill }]}>
          <Icon name="lightbulb" size={26} color={systemColors.tertiaryLabel} />
        </View>
      )}
      <View style={styles.heroDetails}>
        <View style={styles.nameRow}>
          <Text variant="title3" numberOfLines={2} style={styles.flex}>
            {tick.climbName ?? t('sessionFeedCard.unknownClimb')}
          </Text>
          {displayGrade ? (
            <Text
              variant="title3"
              style={[styles.gradeText, { color: gradeBadgeColor(tick.difficultyName ?? displayGrade) }]}
            >
              {displayGrade}
            </Text>
          ) : null}
        </View>
        {/* Status stays shape-coded (flash glyph vs check) but greyscale, so the
            grade is the only colour on the card. */}
        <View style={styles.statusRow}>
          <Icon name={statusIcon} size={13} color={systemColors.secondaryLabel} />
          <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.statusText}>
            {statusLabel}
          </Text>
          {attemptLabel ? (
            <>
              <Text variant="footnote" color={systemColors.tertiaryLabel}>
                ·
              </Text>
              <Text variant="footnote" color={systemColors.secondaryLabel}>
                {attemptLabel}
              </Text>
            </>
          ) : null}
        </View>
      </View>
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
