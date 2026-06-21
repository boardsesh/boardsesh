import { View, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { getGradeTextColor } from '@boardsesh/play-view';
import type { RawGradeHighlight, RawStatisticsSummary } from '@boardsesh/profile-stats';
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
  statisticsSummary: RawStatisticsSummary;
  hardestSend: RawGradeHighlight | null;
  hardestFlash: RawGradeHighlight | null;
  percentile: Percentile;
};

export function StatsSummaryCard({ statisticsSummary, hardestSend, hardestFlash, percentile }: StatsSummaryCardProps) {
  const { t } = useTranslation('profile');
  const { systemColors, brandColors, m3 } = useTheme();
  const isMaterial = useVariantValue({ material: true, liquidGlass: false });

  const showPercentile = percentile != null && percentile.percentile > 0;
  // "Top X%" — invert the percentile, clamped so a 100th-percentile climber
  // reads "Top 0.1%" rather than "Top 0%".
  const topPercent = showPercentile ? Math.max(0.1, 100 - percentile.percentile) : 0;

  // On Material the three tiles read as one tonal family (neutral surfaceVariant ·
  // primary · secondary container — all brand violet, no amber) so they don't land
  // as two saturated grade-coloured alert blocks; the vivid grade hue survives only
  // as the small tick/flash glyph. On Liquid Glass the grade tiles stay full
  // grade-coloured fills (the original).
  const countTileColor = isMaterial ? m3.surfaceVariant : systemColors.fill;
  const countTextColor = isMaterial ? m3.onSurfaceVariant : undefined;
  const countLabelColor = isMaterial ? m3.onSurfaceVariant : systemColors.secondaryLabel;
  // Hairline the neutral count tile so it reads as a defined surface against the
  // card (it's the only tile without a saturated/tonal fill to delimit it). The
  // grade tiles carry their own fill and stay borderless.
  const countTileBorderColor = isMaterial ? m3.outlineVariant : systemColors.separator;

  // Percentile scale tonal family. On Material the track + fill stay in the M3
  // tonal palette (neutral surfaceVariant track · tonal primary fill) so the bar
  // reads as a calibrated scale on the white card instead of a saturated
  // brand-violet stripe. On Liquid Glass it keeps the original look (system fill
  // track, brand-violet fill). The median tick + "you are here" knob are pure
  // overlays positioned by percent, coloured from the matching token family.
  const percentileTrackColor = isMaterial ? m3.surfaceVariant : systemColors.fill;
  const percentileFillColor = isMaterial ? m3.primary : brandColors.primary;
  const percentileTickColor = isMaterial ? m3.outlineVariant : systemColors.separator;
  const percentileKnobColor = isMaterial ? m3.primary : brandColors.primary;
  const percentileKnobRingColor = isMaterial ? m3.surface : systemColors.elevatedSurface;

  return (
    <Card style={styles.card}>
      <View style={styles.tiles}>
        <View
          style={[
            styles.tile,
            styles.countTile,
            { backgroundColor: countTileColor, borderColor: countTileBorderColor },
          ]}
        >
          <Text variant="title2" color={countTextColor}>
            {statisticsSummary.totalAscents}
          </Text>
          <Text variant="caption1" color={countLabelColor}>
            {t('stats.problems')}
          </Text>
        </View>
        {hardestSend && (
          <GradeTile
            highlight={hardestSend}
            label={t('stats.send')}
            icon="tick"
            background={isMaterial ? m3.primaryContainer : undefined}
            textColor={isMaterial ? m3.onPrimaryContainer : undefined}
          />
        )}
        {hardestFlash && (
          <GradeTile
            highlight={hardestFlash}
            label={t('stats.flash')}
            icon="flash"
            background={isMaterial ? m3.secondaryContainer : undefined}
            textColor={isMaterial ? m3.onSecondaryContainer : undefined}
          />
        )}
      </View>

      {showPercentile && (
        <View style={styles.percentile}>
          <View style={styles.percentileRow}>
            <Text variant="footnote" color={systemColors.secondaryLabel}>
              {t('stats.percentile')}
            </Text>
            <Text variant="footnote" style={styles.percentileValue}>
              {t('stats.topPercent', { value: topPercent.toFixed(topPercent < 1 ? 1 : 0) })}
            </Text>
          </View>
          <View
            style={[styles.percentileTrack, { backgroundColor: percentileTrackColor }]}
            accessibilityRole="progressbar"
            accessibilityValue={{ min: 0, max: 100, now: percentile.percentile }}
          >
            <View
              style={[
                styles.percentileFill,
                { width: `${percentile.percentile}%`, backgroundColor: percentileFillColor },
              ]}
            />
            {/* 50% median reference tick — calibrates the bar as a scale, not just
                a fill. Centred hairline so the knob can be read as above/below median. */}
            <View style={[styles.percentileMedianTick, { backgroundColor: percentileTickColor }]} />
            {/* "You are here" knob at the climber's percentile. Ring in the card
                surface colour so it reads as punched through the fill. */}
            <View
              style={[
                styles.percentileKnob,
                {
                  left: `${percentile.percentile}%`,
                  backgroundColor: percentileKnobColor,
                  borderColor: percentileKnobRingColor,
                },
              ]}
            />
          </View>
          <Text variant="caption2" color={systemColors.tertiaryLabel} style={styles.percentileCaption}>
            {t('stats.moreSentThan', { value: percentile.percentile.toFixed(0) })}
          </Text>
        </View>
      )}
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
  card: {
    marginHorizontal: spacing[4],
  },
  tiles: {
    flexDirection: 'row',
    gap: spacing[2],
  },
  tile: {
    flex: 1,
    borderRadius: borderRadius.md,
    paddingVertical: spacing[3],
    paddingHorizontal: spacing[2],
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing[1],
  },
  countTile: {
    borderWidth: StyleSheet.hairlineWidth,
  },
  gradeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[1],
  },
  gradeTileLabel: {
    opacity: opacity.subtle,
  },
  percentile: {
    marginTop: spacing[5],
  },
  percentileRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
  },
  percentileValue: {
    fontWeight: '600',
  },
  percentileTrack: {
    height: 8,
    borderRadius: borderRadius.full,
    marginTop: spacing[2],
    overflow: 'hidden',
  },
  percentileFill: {
    height: '100%',
    borderRadius: borderRadius.full,
  },
  percentileMedianTick: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: '50%',
    width: StyleSheet.hairlineWidth,
  },
  percentileKnob: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: spacing[1],
    marginLeft: -spacing[1] / 2,
    borderRadius: borderRadius.full,
    borderWidth: StyleSheet.hairlineWidth,
  },
  percentileCaption: {
    marginTop: spacing[1],
  },
});
