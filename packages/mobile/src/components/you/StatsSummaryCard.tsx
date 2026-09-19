import { View, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { getGradeTextColor } from '@boardsesh/play-view';
import type { RawGradeHighlight } from '@boardsesh/profile-stats';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { type IconName } from '../icon-map';
import { Card } from '../Card';
import { gradeBadgeColor } from './profile-chart-colors';
import { spacing, borderRadius, opacity } from '../../theme/tokens';
import { useTheme } from '../../providers/theme-provider';
import { useVariantValue } from '../../theme/variants';

type Percentile = { percentile: number; totalActiveUsers: number } | null;

type StatsSummaryCardProps = {
  hardestSend: RawGradeHighlight | null;
  hardestFlash: RawGradeHighlight | null;
  percentile: Percentile;
  boardLabel: string;
};

/** Lifetime records stay explicitly scoped even when the charts show a shorter period. */
export function StatsSummaryCard({ hardestSend, hardestFlash, percentile, boardLabel }: StatsSummaryCardProps) {
  const { t } = useTranslation('profile');
  const { systemColors, m3 } = useTheme();
  const isMaterial = useVariantValue({ material: true, liquidGlass: false });
  return (
    <Card style={styles.card}>
      <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.caption}>
        {t('stats.progress.lifetimeRecords', { board: boardLabel })}
      </Text>
      <View style={styles.tiles}>
        {hardestSend ? (
          <GradeTile
            highlight={hardestSend}
            label={t('stats.send')}
            icon="tick"
            background={isMaterial ? m3.primaryContainer : undefined}
            textColor={isMaterial ? m3.onPrimaryContainer : undefined}
          />
        ) : null}
        {hardestFlash ? (
          <GradeTile
            highlight={hardestFlash}
            label={t('stats.flash')}
            icon="flash"
            background={isMaterial ? m3.secondaryContainer : undefined}
            textColor={isMaterial ? m3.onSecondaryContainer : undefined}
          />
        ) : null}
      </View>
      {percentile != null && percentile.percentile > 0 ? (
        <Text variant="caption1" color={systemColors.secondaryLabel} style={styles.percentile}>
          {t('stats.moreSentThan', { value: percentile.percentile.toFixed(0) })}
        </Text>
      ) : null}
    </Card>
  );
}

function GradeTile({
  highlight,
  label,
  icon,
  background,
  textColor,
}: {
  highlight: RawGradeHighlight;
  label: string;
  icon: IconName;
  /** Tonal container fill (Material). Glass falls back to the vivid grade fill. */
  background?: string;
  /** On-container text (Material). Glass falls back to the contrast-aware colour. */
  textColor?: string;
}) {
  // Glass: the whole tile is the grade's vivid colour, text picks the contrast
  // colour. Material: a tonal container carries the tile, so the grade hue lives
  // only on the leading glyph (the small accent) and text uses the on-container role.
  const gradeFill = gradeBadgeColor(highlight.label);
  const tileBackground = background ?? gradeFill;
  const onTile = textColor ?? getGradeTextColor(gradeFill);
  const accentColor = background ? gradeFill : onTile;
  return (
    <View style={[styles.tile, { backgroundColor: tileBackground }]}>
      <View style={styles.gradeRow}>
        <Icon name={icon} size={14} color={accentColor} />
        <Text variant="title3" color={onTile}>
          {highlight.label}
        </Text>
      </View>
      {/* Match the grade/icon's contrast-aware colour; secondaryLabel is a grey
          that washes out on saturated grade tiles. Dim slightly for hierarchy. */}
      <Text variant="caption1" color={onTile} style={styles.gradeTileLabel}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { marginHorizontal: spacing[4] },
  caption: { marginBottom: spacing[3] },
  tiles: { flexDirection: 'row', gap: spacing[2] },
  tile: {
    flex: 1,
    borderRadius: borderRadius.md,
    paddingVertical: spacing[3],
    paddingHorizontal: spacing[2],
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing[1],
  },
  gradeRow: { flexDirection: 'row', alignItems: 'center', gap: spacing[1] },
  gradeTileLabel: { opacity: opacity.subtle },
  percentile: { marginTop: spacing[3] },
});
