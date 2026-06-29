import { useState } from 'react';
import { View, StyleSheet, type LayoutChangeEvent } from 'react-native';
import { useTranslation } from 'react-i18next';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import type { RawAngleBreakdown } from '@boardsesh/profile-stats';
import { Text } from '../Text';
import { useTheme } from '../../providers/theme-provider';
import { borderRadius, spacing } from '../../theme/tokens';
import { angleChartColor } from './profile-chart-colors';
import { shiftLightness } from '../playlist/playlist-gradient';

type AngleBreakdownChartProps = {
  breakdown: RawAngleBreakdown;
};

// Fixed leading rule + angle-label gutter, so every row's bar starts at the same
// x regardless of which row is the home angle (the rule only paints on home).
const LEAD_WIDTH = 3;
const ANGLE_COL_WIDTH = 36;
// Room reserved at the right so the grade tip label ("V13" / "8C+") clears the
// longest bar without being clipped.
const TIP_RESERVE = 44;
const ROW_HEIGHT = 26;
const BAR_HEIGHT = 14;
// The faint volume track sits behind the grade bar, a touch taller so it reads
// as a band the bar floats on.
const TRACK_HEIGHT = ROW_HEIGHT - 6;
const BAR_RADIUS = borderRadius.sm;
const MIN_BAR = 4;

/**
 * "Your angle" — one horizontal row per wall angle (steep→slab). Each bar's
 * length is the angle's hardest grade relative to the overall hardest; the bar
 * is tinted by that grade's hue (`angleChartColor`) via a horizontal SVG
 * gradient, with the grade label at the tip and a faint volume track behind it
 * scaled by send count. The home angle (highest volume) gets a brand left rule +
 * caption. Every SVG/track/label colour is a plain `chartColors.*` hex — never a
 * PlatformColor — so react-native-svg fills stay valid. Parent gates the empty
 * case, so an empty `rows` simply renders nothing.
 */
export function AngleBreakdownChart({ breakdown }: AngleBreakdownChartProps) {
  const { chartColors, brandColors } = useTheme();
  const { t } = useTranslation('profile');
  const [width, setWidth] = useState(0);

  if (breakdown.rows.length === 0) return null;

  const onLayout = (event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width);
  // Deterministic bar area from a single container measurement (no per-row
  // onLayout churn): the SVG track region after the lead + angle gutters, less
  // the tip-label reserve so the grade label always fits.
  const barAreaWidth = Math.max(0, width - LEAD_WIDTH - spacing[2] - ANGLE_COL_WIDTH - spacing[2]);
  const trackWidth = Math.max(0, barAreaWidth - TIP_RESERVE);

  return (
    <View
      onLayout={onLayout}
      accessible
      accessibilityRole="image"
      accessibilityLabel={t('charts.angleA11y')}
      importantForAccessibility="no-hide-descendants"
    >
      {width > 0
        ? breakdown.rows.map((row) => {
            const isHome = breakdown.homeAngle === row.angle;
            const hue = angleChartColor(row.maxLabel);
            const gradeWidth =
              breakdown.maxDifficulty > 0
                ? Math.max(MIN_BAR, (row.maxDifficulty / breakdown.maxDifficulty) * trackWidth)
                : MIN_BAR;
            const volumeWidth = breakdown.maxSendCount > 0 ? (row.sendCount / breakdown.maxSendCount) * trackWidth : 0;
            const gradientId = `angle-${row.angle}`;
            return (
              <View key={row.angle} style={styles.rowGroup}>
                <View style={styles.barRow}>
                  <View style={[styles.lead, isHome ? { backgroundColor: brandColors.primary } : undefined]} />
                  <Text variant="caption1" color={chartColors.secondaryLabel} style={styles.angleLabel}>
                    {t('charts.angleUnit', { angle: row.angle })}
                  </Text>
                  <View style={[styles.barArea, { width: barAreaWidth }]}>
                    <Svg width={barAreaWidth} height={ROW_HEIGHT}>
                      <Defs>
                        <LinearGradient id={gradientId} x1="0" y1="0" x2="1" y2="0">
                          <Stop offset="0" stopColor={shiftLightness(hue, 16)} />
                          <Stop offset="1" stopColor={hue} />
                        </LinearGradient>
                      </Defs>
                      {volumeWidth > 0 ? (
                        <Rect
                          x={0}
                          y={(ROW_HEIGHT - TRACK_HEIGHT) / 2}
                          width={volumeWidth}
                          height={TRACK_HEIGHT}
                          rx={BAR_RADIUS}
                          ry={BAR_RADIUS}
                          fill={chartColors.secondaryBackground}
                        />
                      ) : null}
                      <Rect
                        x={0}
                        y={(ROW_HEIGHT - BAR_HEIGHT) / 2}
                        width={gradeWidth}
                        height={BAR_HEIGHT}
                        rx={BAR_RADIUS}
                        ry={BAR_RADIUS}
                        fill={`url(#${gradientId})`}
                      />
                    </Svg>
                    <Text
                      variant="caption1"
                      color={chartColors.label}
                      style={[styles.tipLabel, { left: gradeWidth + spacing[1] }]}
                      numberOfLines={1}
                    >
                      {row.maxLabel}
                    </Text>
                  </View>
                </View>
                {isHome ? (
                  <Text variant="caption2" color={brandColors.primary} style={styles.homeCaption}>
                    {t('charts.homeAngle')}
                  </Text>
                ) : null}
              </View>
            );
          })
        : null}
    </View>
  );
}

const styles = StyleSheet.create({
  rowGroup: {
    marginBottom: spacing[2],
  },
  barRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    height: ROW_HEIGHT,
  },
  lead: {
    width: LEAD_WIDTH,
    height: BAR_HEIGHT,
    borderRadius: borderRadius.full,
  },
  angleLabel: {
    width: ANGLE_COL_WIDTH,
    textAlign: 'right',
    fontVariant: ['tabular-nums'],
  },
  barArea: {
    height: ROW_HEIGHT,
    justifyContent: 'center',
  },
  tipLabel: {
    position: 'absolute',
    fontWeight: '600',
  },
  homeCaption: {
    marginLeft: LEAD_WIDTH + spacing[2] + ANGLE_COL_WIDTH + spacing[2],
    marginTop: 2,
  },
});
