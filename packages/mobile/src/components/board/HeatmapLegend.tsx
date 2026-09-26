import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import { Text } from '../Text';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';
import { formatCount } from '../../lib/format-climb-stats';
import { getCachedNumberFormat } from '../../lib/intl-formatter-cache';
import { hexWithAlpha } from '../create-climb/holdLayout';
import type { HeatLegend } from './heatmap-buckets';

type HeatmapLegendProps = {
  legend: HeatLegend;
  /** "Few climbs" / "Easier". */
  lowLabel: string;
  /** "Many climbs" / "Harder". */
  highLabel: string;
  /** "18,240 climbs", when the answer knows how many. */
  scopeLabel?: string | null;
  /** The real count at the bottom of each bucket, under its swatch (play drawer only). */
  showEdgeValues?: boolean;
  /** "Every hold used equally", shown in place of the two ends when nothing ranks. */
  allEqualLabel: string;
  /**
   * Let the row wrap on a narrow phone (German labels at 320pt). The create
   * board passes false: its line box must stay one line, so the labels shrink
   * and truncate instead.
   */
  wrap?: boolean;
  testID?: string;
};

/** "18,240 climbs": the full count in the reader's locale, never "18k". */
export function formatHeatmapClimbCount(
  t: (key: string, options: { count: number; formattedCount: string }) => string,
  count: number,
  locale: string | undefined,
): string {
  return t('mobile.heatmap.climbCount', { count, formattedCount: getCachedNumberFormat(locale).format(count) });
}

const SWATCH_SIZE = 12;

/**
 * What the heatmap's colours mean, on one line: the two ends in words, five
 * ring swatches drawn the way the renderer marks a hold (a saturated edge over
 * a see-through fill), and how many climbs the colours count. Shared by the play
 * drawer's panel and the create board, which shows it where the autosave note
 * sits while heat is on.
 */
export const HeatmapLegend = memo(function HeatmapLegend({
  legend,
  lowLabel,
  highLabel,
  scopeLabel,
  showEdgeValues = false,
  allEqualLabel,
  wrap = true,
  testID,
}: HeatmapLegendProps) {
  const { systemColors, heatRamp } = useTheme();
  const allEqual = legend.kind === 'count' && legend.allEqual === true;
  const labelStyle = wrap ? undefined : styles.shrinkLabel;

  if (allEqual) {
    const middle = heatRamp[Math.floor(heatRamp.length / 2)] ?? heatRamp[0];
    const summary = [allEqualLabel, scopeLabel].filter(Boolean).join(', ');
    return (
      <View style={[styles.row, wrap && styles.wrap]} testID={testID} accessible accessibilityLabel={summary}>
        <View style={[styles.swatch, { borderColor: middle, backgroundColor: hexWithAlpha(middle, 0.55) }]} />
        <Text variant="caption1" color={systemColors.secondaryLabel} numberOfLines={1} style={labelStyle}>
          {allEqualLabel}
        </Text>
        {scopeLabel ? (
          <Text variant="caption1" color={systemColors.secondaryLabel} numberOfLines={1} style={styles.scope}>
            {scopeLabel}
          </Text>
        ) : null}
      </View>
    );
  }

  const swatches = legend.kind === 'grade' && legend.swatches.length > 0 ? legend.swatches : heatRamp;
  const edgeValues = showEdgeValues && legend.kind === 'count' ? legend.edgeValues : null;
  const summary = [lowLabel, highLabel, scopeLabel].filter(Boolean).join(', ');

  return (
    <View style={[styles.row, wrap && styles.wrap]} testID={testID} accessible accessibilityLabel={summary}>
      <Text variant="caption1" color={systemColors.secondaryLabel} numberOfLines={1} style={labelStyle}>
        {lowLabel}
      </Text>
      <View style={styles.swatches}>
        {swatches.map((color, index) => (
          // A narrow grade span repeats a colour, so the position is part of the key.
          <View key={`${index}-${color}`} style={styles.swatchColumn}>
            <View style={[styles.swatch, { borderColor: color, backgroundColor: hexWithAlpha(color, 0.55) }]} />
            {edgeValues ? (
              <Text variant="caption2" color={systemColors.tertiaryLabel} numberOfLines={1}>
                {edgeValues[index] == null ? '–' : formatCount(edgeValues[index] ?? 0)}
              </Text>
            ) : null}
          </View>
        ))}
      </View>
      <Text variant="caption1" color={systemColors.secondaryLabel} numberOfLines={1} style={labelStyle}>
        {highLabel}
      </Text>
      {scopeLabel ? (
        <Text variant="caption1" color={systemColors.secondaryLabel} numberOfLines={1} style={styles.scope}>
          {scopeLabel}
        </Text>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
  // On a 320pt phone the German ends plus the scope count do not fit on one
  // line; the scope count drops to a second line instead of pushing off-screen.
  wrap: {
    flexWrap: 'wrap',
    rowGap: spacing[1],
  },
  shrinkLabel: {
    flexShrink: 1,
  },
  swatches: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing[1],
  },
  swatchColumn: {
    alignItems: 'center',
    minWidth: SWATCH_SIZE,
  },
  swatch: {
    width: SWATCH_SIZE,
    height: SWATCH_SIZE,
    borderRadius: SWATCH_SIZE / 2,
    borderWidth: 2,
  },
  scope: {
    flexShrink: 1,
    marginLeft: 'auto',
  },
});
