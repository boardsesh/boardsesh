import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { useTheme } from '../../providers/theme-provider';
import { withAlpha } from '../../theme/colors';
import { borderRadius, spacing } from '../../theme/tokens';
import { useVariantValue } from '../../theme/variants';
import { Icon } from '../Icon';
import { type IconName } from '../icon-map';
import { Text } from '../Text';
import { gradeBadgeColor } from '../you/profile-chart-colors';

/**
 * Shared session stat tiles. The summary recap (post-session) and the
 * session-detail card both render the same Sends/Flashes/Attempts/Hardest row,
 * so the tile look lives here once rather than drifting between the two screens.
 */

/** Neutral tile — no colour tint, so only the grade tile stands out. */
export function StatTile({ value, label, icon }: { value: number; label: string; icon: IconName }) {
  const { systemColors } = useTheme();
  const tileBackground = useVariantValue({ liquidGlass: systemColors.tertiaryFill, material: systemColors.fill });
  return (
    <View style={[styles.tile, { backgroundColor: tileBackground }]}>
      <View style={styles.valueRow}>
        <Icon name={icon} size={14} color={systemColors.secondaryLabel} />
        <Text variant="title2" color={systemColors.label}>
          {value}
        </Text>
      </View>
      <Text variant="caption1" color={systemColors.secondaryLabel} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

/** Grade tile — the one saturated tile, tinted in the grade's own colour. */
export function GradeTileView({ grade, displayGrade }: { grade: string; displayGrade: string }) {
  const { t } = useTranslation('feed');
  // A 15%-alpha grade tint (the participant-chip treatment) rather than a solid
  // slab, so the only saturated grade colour on screen is the chart.
  const gradeColor = gradeBadgeColor(grade);
  return (
    <View style={[styles.tile, { backgroundColor: withAlpha(gradeColor, 0.15) }]}>
      <Text variant="title2" color={gradeColor}>
        {displayGrade}
      </Text>
      <Text variant="caption1" color={withAlpha(gradeColor, 0.85)} numberOfLines={1}>
        {t('sessionFeedCard.hardest')}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  tile: {
    flex: 1,
    borderRadius: borderRadius.md,
    paddingVertical: spacing[3],
    paddingHorizontal: spacing[2],
    alignItems: 'center',
    gap: spacing[1],
  },
  valueRow: { flexDirection: 'row', alignItems: 'center', gap: spacing[1] },
});
