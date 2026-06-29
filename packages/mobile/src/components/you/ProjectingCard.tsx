import { useState } from 'react';
import { View, StyleSheet, type LayoutChangeEvent } from 'react-native';
import { useTranslation } from 'react-i18next';
import { BarChart } from 'react-native-gifted-charts';
import { getGradeTextColor } from '@boardsesh/play-view';
import type { RawProjectingStats } from '@boardsesh/profile-stats';
import { Text } from '../Text';
import { useTheme } from '../../providers/theme-provider';
import { useVariantValue } from '../../theme/variants';
import { spacing, borderRadius } from '../../theme/tokens';
import { gradeBadgeColor } from './profile-chart-colors';
import { shiftLightness } from '../playlist/playlist-gradient';

const MATERIAL = { material: true, liquidGlass: false } as const;
const CHART_HEIGHT = 132;
const AXIS_LABEL_SIZE = 11;
const BAR_RADIUS = 4;

type ProjectingCardProps = {
  projectingStats: RawProjectingStats;
};

/**
 * "Your biggest fights" — a 4-bucket tries-to-send histogram (1 / 2–5 / 6–20 /
 * 20+) over a hairline, then the biggest-won project as a grade badge + tries
 * pill. Bars use the brand primary with the vertical in-chart gradient
 * (`showGradient` + `gradientColor`, never `gradientDirection` — not a BarChart
 * prop). Parent gates rendering on `projectingStats.unlocked`.
 */
export function ProjectingCard({ projectingStats }: ProjectingCardProps) {
  const { chartColors, brandColors, systemColors, m3 } = useTheme();
  const { t } = useTranslation('profile');
  const isMaterial = useVariantValue(MATERIAL);
  const [width, setWidth] = useState(0);

  const onLayout = (event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width);

  const count = projectingStats.buckets.length;
  const initialSpacing = 8;
  const barSpacing = 12;
  const barWidth =
    width > 0 && count > 0
      ? Math.max(8, Math.floor((width - initialSpacing * 2 - barSpacing * (count - 1)) / count))
      : 0;
  const labelBudget = barWidth + barSpacing;

  const gradientColor = shiftLightness(brandColors.primary, 16);
  const data = projectingStats.buckets.map((bucket) => ({
    value: bucket.value,
    label: bucket.label,
    labelWidth: labelBudget,
    frontColor: brandColors.primary,
    showGradient: true,
    gradientColor,
  }));
  const maxValue = Math.max(1, ...projectingStats.buckets.map((bucket) => bucket.value));

  const biggest = projectingStats.biggestProject;
  const pillBg = isMaterial ? m3.surfaceVariant : systemColors.fill;
  const badgeHex = biggest ? gradeBadgeColor(biggest.label) : brandColors.primary;

  return (
    <View>
      <View
        onLayout={onLayout}
        accessibilityRole="image"
        accessibilityLabel={t('charts.projectingA11y')}
        importantForAccessibility="no-hide-descendants"
      >
        {width > 0 && barWidth > 0 ? (
          <BarChart
            data={data}
            width={width}
            height={CHART_HEIGHT}
            barWidth={barWidth}
            spacing={barSpacing}
            initialSpacing={initialSpacing}
            barBorderRadius={BAR_RADIUS}
            maxValue={maxValue}
            hideRules
            hideYAxisText
            yAxisThickness={0}
            xAxisThickness={StyleSheet.hairlineWidth}
            xAxisColor={chartColors.separator}
            xAxisLabelTextStyle={{ color: chartColors.tertiaryLabel, fontSize: AXIS_LABEL_SIZE }}
            isAnimated={false}
            disableScroll
            disablePress
          />
        ) : null}
      </View>

      {biggest ? (
        <>
          <View style={[styles.hairline, { backgroundColor: chartColors.separator }]} />
          <View
            style={styles.biggestRow}
            accessibilityRole="text"
            accessibilityLabel={t('charts.biggestProjectA11y', { grade: biggest.label, count: biggest.tries })}
          >
            <View style={[styles.gradeBadge, { backgroundColor: badgeHex }]}>
              <Text variant="caption1" color={getGradeTextColor(badgeHex)} style={styles.gradeBadgeText}>
                {biggest.label}
              </Text>
            </View>
            <View style={[styles.triesPill, { backgroundColor: pillBg }]}>
              <Text variant="caption1" color={brandColors.accent} style={styles.triesText}>
                {t('charts.triesPill', { count: biggest.tries })}
              </Text>
            </View>
          </View>
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  hairline: {
    height: StyleSheet.hairlineWidth,
    alignSelf: 'stretch',
    marginVertical: spacing[3],
  },
  biggestRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
  gradeBadge: {
    borderRadius: borderRadius.sm,
    paddingHorizontal: spacing[2],
    paddingVertical: 2,
  },
  gradeBadgeText: {
    fontWeight: '700',
  },
  triesPill: {
    borderRadius: borderRadius.full,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[1],
  },
  triesText: {
    fontWeight: '600',
  },
});
