import { View, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { PeriodComparisonMode, RawPeriodComparison } from '@boardsesh/profile-stats';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { Card } from '../Card';
import { SegmentedControl } from '../SegmentedControl';
import { spacing, borderRadius } from '../../theme/tokens';
import { useTheme } from '../../providers/theme-provider';

type PeriodComparisonCardProps = {
  periodComparison: RawPeriodComparison | null;
  comparisonMode: PeriodComparisonMode;
  onComparisonModeChange: (mode: PeriodComparisonMode) => void;
};

function formatPercent(value: number | null): string {
  if (value == null) return '';
  const rounded = Math.round(value);
  return `${rounded > 0 ? '+' : ''}${rounded}%`;
}

/**
 * Sends this period vs. the prior comparable period (trailing or
 * year-over-year, toggled by the segmented control). Returns null when the
 * active timeframe isn't week/month/year — `buildPeriodComparison` only
 * produces a comparison for those three, mirroring every other chart card's
 * data-absent convention.
 */
export function PeriodComparisonCard({
  periodComparison,
  comparisonMode,
  onComparisonModeChange,
}: PeriodComparisonCardProps) {
  const { t } = useTranslation('profile');
  const { systemColors, brandColors } = useTheme();

  if (!periodComparison) return null;

  const { current, previous, sendsDelta, sendsPercentChange } = periodComparison;
  // No comparison-period history (new climber, or the comparison period
  // predates their first tick) — show a first-period message instead of a
  // divide-by-zero "+Infinity%".
  const hasComparison = previous.sends > 0;
  const deltaColor =
    sendsDelta > 0 ? brandColors.success : sendsDelta < 0 ? brandColors.error : systemColors.secondaryLabel;

  const modeOptions = [
    { key: 'trailing' as const, label: t('stats.periodComparison.trailing') },
    { key: 'yearOverYear' as const, label: t('stats.periodComparison.yearOverYear') },
  ];

  return (
    <Card style={styles.card}>
      <SegmentedControl
        options={modeOptions}
        selectedKey={comparisonMode}
        onSelect={onComparisonModeChange}
        accessibilityLabel={t('stats.periodComparison.controlLabel')}
      />
      <View style={styles.tiles}>
        <View style={[styles.tile, { backgroundColor: systemColors.fill }]}>
          <Text variant="title2">{current.sends}</Text>
          <Text variant="caption1" color={systemColors.secondaryLabel}>
            {t('stats.periodComparison.sends')}
          </Text>
        </View>
        <View style={[styles.tile, { backgroundColor: systemColors.fill }]}>
          {hasComparison ? (
            <>
              <View style={styles.deltaRow}>
                {sendsDelta !== 0 && (
                  <Icon name={sendsDelta > 0 ? 'chevron.up' : 'chevron.down'} size={14} color={deltaColor} />
                )}
                <Text variant="title2" color={deltaColor}>
                  {formatPercent(sendsPercentChange)}
                </Text>
              </View>
              <Text variant="caption1" color={systemColors.secondaryLabel}>
                {comparisonMode === 'trailing'
                  ? t('stats.periodComparison.vsTrailing')
                  : t('stats.periodComparison.vsYearOverYear')}
              </Text>
            </>
          ) : (
            <Text variant="caption1" color={systemColors.tertiaryLabel} style={styles.noComparisonText}>
              {current.sends > 0
                ? t('stats.periodComparison.firstPeriod')
                : t('stats.periodComparison.noComparisonData')}
            </Text>
          )}
        </View>
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { marginHorizontal: spacing[4], marginTop: spacing[3] },
  tiles: {
    flexDirection: 'row',
    gap: spacing[2],
    marginTop: spacing[3],
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
  deltaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[1],
  },
  noComparisonText: {
    textAlign: 'center',
  },
});
