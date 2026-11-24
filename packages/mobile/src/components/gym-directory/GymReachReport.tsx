import { ScrollView, StyleSheet, View, type DimensionValue } from 'react-native';
import { useTranslation } from 'react-i18next';
import { formatGymReportingTime, gymReachCards, gymReachTrend, type GymTrendSelection } from '@boardsesh/graphql';
import type { GymReachOverview, GymStats } from '@boardsesh/shared-schema';
import { useTheme } from '../../providers/theme-provider';
import { spacing, borderRadius } from '../../theme/tokens';
import { Text } from '../Text';
import { PressableSurface } from '../PressableSurface';
import { SegmentedControl } from '../SegmentedControl';

type Props = { stats: GymStats; overview: GymReachOverview; selection: GymTrendSelection };

export function GymReachReport({ stats, overview, selection }: Props) {
  const { t, i18n } = useTranslation('boards');
  const { systemColors, brandColors } = useTheme();
  const locale = i18n.language || 'en-US';
  const cards = gymReachCards(stats, overview, locale, t);
  const { bars, selected } = gymReachTrend(overview.weeklyTrend, selection.metric, selection.week, locale, t);

  return (
    <View style={styles.section}>
      <View style={styles.cards}>
        {cards.map((card) => (
          <View key={card.key} style={[styles.card, { backgroundColor: systemColors.secondaryBackground }]}>
            <Text accessibilityRole="header" variant="subheadline">
              {card.title}
            </Text>
            <Text variant="title2" numeric>
              {card.value}
            </Text>
            <Text variant="footnote" color={systemColors.secondaryLabel}>
              {card.description}
            </Text>
            {!!card.note && (
              <Text variant="footnote" color={systemColors.secondaryLabel}>
                {card.note}
              </Text>
            )}
            <Text variant="footnote">{card.comparison}</Text>
          </View>
        ))}
      </View>
      <Text variant="footnote" color={systemColors.secondaryLabel}>
        {overview.observationStartedAt
          ? t('gymReach.coverageFrom', {
              date: formatGymReportingTime(overview.observationStartedAt, stats.timeZone, locale),
            })
          : t('gymReach.coverageUnknown')}
      </Text>
      <View style={styles.trend}>
        <Text accessibilityRole="header" variant="headline">
          {t('gymReach.trend')}
        </Text>
        <SegmentedControl
          options={[
            { key: 'climbers', label: t('gymReach.trendClimbers') },
            { key: 'sends', label: t('gymReach.trendSends') },
          ]}
          selectedKey={selection.metric}
          onSelect={selection.setMetric}
          accessibilityLabel={t('gymReach.trendMetric')}
        />
        <ScrollView horizontal contentContainerStyle={styles.bars} showsHorizontalScrollIndicator>
          {bars.map((bar) => {
            const height: DimensionValue = `${bar.fraction * 100}%`;
            const isSelected = selected?.key === bar.key;
            return (
              <PressableSurface
                key={bar.key}
                feedback="opacity"
                style={[styles.bar, isSelected && { backgroundColor: systemColors.secondaryBackground }]}
                accessibilityLabel={bar.accessibilityLabel}
                accessibilityState={{ selected: isSelected }}
                onPress={() => selection.setWeek(bar.key)}
              >
                <View accessible={false} style={[styles.barTrack, { borderColor: systemColors.separator }]}>
                  {bar.fraction > 0 && (
                    <View
                      style={[
                        styles.barFill,
                        { height, backgroundColor: brandColors.primary, opacity: bar.coverage ? 0.6 : 1 },
                      ]}
                    />
                  )}
                </View>
                <Text variant="caption1" style={styles.barLabel}>
                  {bar.label}
                </Text>
                {bar.progress && (
                  <Text variant="caption1" style={styles.barLabel}>
                    {bar.progress}
                  </Text>
                )}
                {bar.coverage && (
                  <Text variant="caption1" color={systemColors.secondaryLabel} style={styles.barLabel}>
                    {bar.coverage}
                  </Text>
                )}
              </PressableSurface>
            );
          })}
        </ScrollView>
        {selected && (
          <Text variant="subheadline" accessibilityLiveRegion="polite">
            {selected.accessibilityLabel}
          </Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: spacing[4] },
  cards: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
  card: {
    minWidth: 150,
    flexBasis: 165,
    flexGrow: 1,
    padding: spacing[3],
    gap: spacing[1],
    borderRadius: borderRadius.lg,
  },
  trend: { gap: spacing[2] },
  bars: { gap: spacing[1] },
  bar: { width: 72, minHeight: 48, padding: spacing[1], gap: spacing[1], borderRadius: borderRadius.md },
  barTrack: {
    height: 92,
    borderBottomWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'flex-end',
  },
  barFill: { width: '55%', minHeight: 2, borderTopLeftRadius: borderRadius.sm, borderTopRightRadius: borderRadius.sm },
  barLabel: { textAlign: 'center' },
});
