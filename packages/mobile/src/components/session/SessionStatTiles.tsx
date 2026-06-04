import { View, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { getGradeTextColor } from '@boardsesh/play-view';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { type IconName } from '../icon-map';
import { Card } from '../Card';
import { gradeBadgeColor } from '../you/profile-chart-colors';
import { brandColors } from '../../theme/colors';
import { iosSystemColors } from '../../theme/ios-colors';
import { spacing, borderRadius } from '../../theme/tokens';
import { useTheme } from '../../providers/theme-provider';

type SessionStatTilesProps = {
  sends: number;
  flashes: number;
  attempts: number;
  hardestGrade?: string | null;
};

/** Sends / Flashes / Attempts / Hardest tiles for the session-detail header. */
export function SessionStatTiles({ sends, flashes, attempts, hardestGrade }: SessionStatTilesProps) {
  const { t } = useTranslation('you');
  const { t: tFeed } = useTranslation('feed');

  return (
    <Card style={styles.card}>
      <View style={styles.tiles}>
        <StatTile value={sends} label={t('mobile.sessions.weekly.sends')} icon="tick" tint={brandColors.success} />
        <StatTile
          value={flashes}
          label={t('mobile.sessions.weekly.flashes')}
          icon="flash"
          tint={brandColors.warning}
        />
        <StatTile
          value={attempts}
          label={t('mobile.sessions.weekly.attempts')}
          icon="circle"
          tint={iosSystemColors.systemGray}
        />
        {hardestGrade ? <GradeTile grade={hardestGrade} label={tFeed('sessionFeedCard.hardest')} /> : null}
      </View>
    </Card>
  );
}

function StatTile({ value, label, icon, tint }: { value: number; label: string; icon: IconName; tint: string }) {
  const { systemColors } = useTheme();
  return (
    <View style={[styles.tile, { backgroundColor: systemColors.fill }]}>
      <View style={styles.valueRow}>
        <Icon name={icon} size={14} color={tint} />
        <Text variant="title3" color={tint}>
          {value}
        </Text>
      </View>
      <Text variant="caption1" color={systemColors.secondaryLabel} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

function GradeTile({ grade, label }: { grade: string; label: string }) {
  const background = gradeBadgeColor(grade);
  const textColor = getGradeTextColor(background);
  return (
    <View style={[styles.tile, { backgroundColor: background }]}>
      <Text variant="title3" color={textColor}>
        {grade}
      </Text>
      <Text variant="caption1" color={textColor} style={styles.gradeLabel} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { marginHorizontal: spacing[4], marginTop: spacing[4] },
  tiles: { flexDirection: 'row', gap: spacing[2] },
  tile: {
    flex: 1,
    borderRadius: borderRadius.md,
    paddingVertical: spacing[3],
    paddingHorizontal: spacing[2],
    alignItems: 'center',
    gap: spacing[1],
  },
  valueRow: { flexDirection: 'row', alignItems: 'center', gap: spacing[1] },
  gradeLabel: { opacity: 0.85 },
});
