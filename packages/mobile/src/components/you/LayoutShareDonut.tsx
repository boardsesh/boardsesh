import { useCallback, useMemo, type ReactNode } from 'react';
import { View, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { PieChart } from 'react-native-gifted-charts';
import type { RawLayoutPercentage } from '@boardsesh/profile-stats';
import { Text } from '../Text';
import { layoutChartColor } from './profile-chart-colors';
import { spacing, borderRadius } from '../../theme/tokens';
import { useTheme } from '../../providers/theme-provider';

type LayoutShareDonutProps = {
  layoutPercentages: RawLayoutPercentage[];
  /** Center-label headline — the user's total distinct ascents. */
  totalAscents: number;
};

const DONUT_RADIUS = 62;
// Thin ring (≈14px) + a bigger hole reads as "data", not a 2010 pie; it also
// gives the centre total room to breathe.
const DONUT_INNER_RADIUS = 48;
/** Hairline seam between slices, cut in the card surface colour. */
const SLICE_SEPARATOR_WIDTH = 2;

/**
 * Each layout's share of the user's ascents as a donut, with the total ascents
 * in the hole and a colour-keyed legend beside it. Replaces the old thin stacked
 * bar — the donut reads each board's slice at a glance and the legend keeps the
 * labels off the (low-contrast) segments. Hidden for a single layout, where a
 * share chart says nothing.
 */
export function LayoutShareDonut({ layoutPercentages, totalAscents }: LayoutShareDonutProps) {
  const { systemColors, colorScheme, chartColors } = useTheme();
  const { t } = useTranslation('profile');

  // Single sorted source (largest share first) drives BOTH the arc sweep and the
  // legend so each swatch pairs with its slice position. Copy before sorting —
  // never mutate the prop. Called before the early return to keep hooks stable.
  const orderedLayouts = useMemo(() => [...layoutPercentages].sort((a, b) => b.count - a.count), [layoutPercentages]);

  const slices = useMemo(
    () =>
      orderedLayouts.map((layout) => ({
        value: layout.count,
        color: layoutChartColor(layout.layoutKey, colorScheme),
      })),
    [orderedLayouts, colorScheme],
  );

  // Stable identity so PieChart isn't handed a fresh component each render.
  const centerLabel = useCallback(
    (): ReactNode => (
      <View style={styles.center} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
        <Text
          variant="headline"
          color={systemColors.label}
          numberOfLines={1}
          adjustsFontSizeToFit
          maxFontSizeMultiplier={1.3}
        >
          {totalAscents}
        </Text>
        <Text
          variant="caption2"
          color={systemColors.secondaryLabel}
          numberOfLines={1}
          maxFontSizeMultiplier={1.2}
          style={styles.centerCaption}
        >
          {t('stats.problems')}
        </Text>
      </View>
    ),
    [totalAscents, systemColors.label, systemColors.secondaryLabel, t],
  );

  if (layoutPercentages.length <= 1) return null;

  return (
    <View style={styles.container}>
      <View
        accessible
        accessibilityRole="image"
        accessibilityLabel={t('stats.layoutShareAria', { count: totalAscents })}
      >
        <PieChart
          data={slices}
          donut
          radius={DONUT_RADIUS}
          innerRadius={DONUT_INNER_RADIUS}
          innerCircleColor="transparent"
          strokeColor={chartColors.secondaryBackground}
          strokeWidth={SLICE_SEPARATOR_WIDTH}
          centerLabelComponent={centerLabel}
        />
      </View>
      <View style={styles.legend}>
        {orderedLayouts.map((layout) => (
          <View
            key={layout.layoutKey}
            style={styles.legendItem}
            accessibilityRole="text"
            accessibilityLabel={t('stats.layoutLegendAria', {
              name: layout.displayName,
              percentage: layout.percentage,
              count: layout.count,
            })}
          >
            <View
              style={[
                styles.dot,
                {
                  backgroundColor: layoutChartColor(layout.layoutKey, colorScheme),
                  borderColor: chartColors.separator,
                },
              ]}
            />
            <Text variant="caption2" color={systemColors.secondaryLabel} style={styles.legendName} numberOfLines={1}>
              {layout.displayName}
            </Text>
            <Text variant="caption2" color={systemColors.label} style={styles.legendPercent}>
              {`${layout.percentage}%`}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
  },
  center: {
    alignItems: 'center',
    maxWidth: DONUT_INNER_RADIUS * 2 - spacing[2],
  },
  centerCaption: {
    marginTop: -spacing[1],
  },
  legend: {
    flex: 1,
    gap: spacing[2],
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
  dot: {
    width: spacing[3],
    height: spacing[3],
    borderRadius: borderRadius.full,
    borderWidth: 1,
  },
  legendName: {
    flex: 1,
  },
  legendPercent: {
    textAlign: 'right',
    minWidth: spacing[10],
    fontVariant: ['tabular-nums'],
    fontWeight: '600',
  },
});
