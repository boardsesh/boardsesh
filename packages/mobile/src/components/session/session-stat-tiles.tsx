import { View, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { type IconName } from '../icon-map';
import { GRADE_TINT_ALPHA, gradeBadgeColor, gradeTextOnTintColor } from '../you/profile-chart-colors';
import { withAlpha } from '../../theme/colors';
import { spacing, borderRadius } from '../../theme/tokens';
import { useTheme } from '../../providers/theme-provider';
import { useVariantValue } from '../../theme/variants';
import { useGradeFormat } from '../../hooks/use-grade-format';

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
export function GradeTile({ grade, boardName }: { grade: string; boardName?: string | null }) {
  const { t } = useTranslation('feed');
  const { formatGrade } = useGradeFormat();
  const { colorScheme } = useTheme();
  // A 15%-alpha grade tint (the participant-chip treatment) rather than a solid
  // slab, so the only saturated grade colour on screen is the chart. The tint
  // keeps the raw vivid hue; the text is lifted against that tint so it clears
  // 4.5:1 in dark mode.
  const gradeColor = gradeBadgeColor(grade);
  const gradeLabelColor = gradeTextOnTintColor(grade, colorScheme, GRADE_TINT_ALPHA);
  const displayGrade = formatGrade(grade, boardName) ?? grade;
  return (
    <View style={[styles.tile, { backgroundColor: withAlpha(gradeColor, GRADE_TINT_ALPHA) }]}>
      <Text variant="title2" color={gradeLabelColor}>
        {displayGrade}
      </Text>
      <Text variant="caption1" color={gradeLabelColor} style={styles.gradeLabel} numberOfLines={1}>
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
  gradeLabel: { opacity: 0.85 },
});
