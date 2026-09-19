import { memo } from 'react';
import { View, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { RawLayoutPercentage, RawStatisticsSummary } from '@boardsesh/profile-stats';
import { Text } from '../Text';
import { useTheme } from '../../providers/theme-provider';
import { getCachedNumberFormat } from '../../lib/intl-formatter-cache';
import { spacing, borderRadius } from '../../theme/tokens';
import { gradeBadgeColor } from './profile-chart-colors';

/** The authoritative all-board total is independent of the progress filters. */
export const ProfileBoardOverview = memo(function ProfileBoardOverview({
  summary,
  isOwnProfile = true,
}: {
  summary: RawStatisticsSummary;
  isOwnProfile?: boolean;
}) {
  const { t, i18n } = useTranslation('profile');
  const { systemColors } = useTheme();
  return (
    <View style={styles.header} testID="profile-board-overview" accessible>
      <Text variant="title2" style={styles.heading}>
        {isOwnProfile ? t('stats.boardOverview.title') : t('stats.boardOverview.publicTitle')}
      </Text>
      <View style={styles.totalRow}>
        <Text variant="largeTitle" style={styles.total}>
          {getCachedNumberFormat(i18n.language).format(summary.totalAscents)}
        </Text>
        <View style={styles.totalCaption}>
          <Text variant="subheadline">{t('stats.boardOverview.climbsLabel', { count: summary.totalAscents })}</Text>
          <Text variant="caption1" color={systemColors.secondaryLabel}>
            {t('stats.boardOverview.layouts', { count: summary.layoutPercentages.length })}
          </Text>
        </View>
      </View>
      <Text variant="caption1" color={systemColors.secondaryLabel}>
        {t('stats.boardOverview.allTime')}
      </Text>
    </View>
  );
});

/** Rendered as an individual FlashList item, including when every layout is expanded. */
export const ProfileBoardRow = memo(function ProfileBoardRow({
  layout,
  largestCount,
  first,
  last,
}: {
  layout: RawLayoutPercentage;
  largestCount: number;
  first: boolean;
  last: boolean;
}) {
  const { t } = useTranslation('profile');
  const { systemColors, brandColors } = useTheme();
  const record = layout.hardestSend;
  const recordLabel = record ? t('stats.boardOverview.recordAria', { grade: record.label }) : '';
  const relativeWidth = largestCount > 0 ? Math.min(100, Math.max(0, (layout.count / largestCount) * 100)) : 0;

  return (
    <View
      testID={`profile-board-row-${layout.layoutKey}`}
      accessible
      accessibilityLabel={[
        t('stats.boardOverview.rowAria', { name: layout.displayName, count: layout.count }),
        recordLabel,
      ]
        .filter(Boolean)
        .join('. ')}
      style={[
        styles.row,
        {
          backgroundColor: systemColors.secondaryBackground,
          borderColor: systemColors.separator,
          borderTopLeftRadius: first ? borderRadius.lg : 0,
          borderTopRightRadius: first ? borderRadius.lg : 0,
          borderBottomLeftRadius: last ? borderRadius.lg : 0,
          borderBottomRightRadius: last ? borderRadius.lg : 0,
          borderBottomWidth: last ? 0 : StyleSheet.hairlineWidth,
        },
      ]}
    >
      <Text variant="headline" style={styles.layoutName}>
        {layout.displayName}
      </Text>
      <View style={styles.rowDetails}>
        <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.count}>
          {t('stats.boardOverview.climbs', { count: layout.count })}
        </Text>
        {record ? (
          <View style={styles.record}>
            <Text variant="caption1" color={systemColors.secondaryLabel}>
              {t('stats.boardOverview.bestSend')}
            </Text>
            <View style={[styles.gradeDot, { backgroundColor: gradeBadgeColor(record.label) }]} />
            <Text variant="headline" color={systemColors.label}>
              {record.label}
            </Text>
          </View>
        ) : null}
      </View>
      <View
        style={[styles.track, { backgroundColor: systemColors.fill }]}
        importantForAccessibility="no-hide-descendants"
        accessibilityElementsHidden
      >
        <View style={[styles.bar, { width: `${relativeWidth}%`, backgroundColor: brandColors.primary }]} />
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  header: { paddingHorizontal: spacing[4], paddingTop: spacing[4], paddingBottom: spacing[3], gap: spacing[1] },
  heading: { fontWeight: '600' },
  totalRow: { flexDirection: 'row', alignItems: 'center', gap: spacing[3] },
  total: { fontWeight: '700', fontVariant: ['tabular-nums'] },
  totalCaption: { flex: 1 },
  row: { marginHorizontal: spacing[4], paddingHorizontal: spacing[4], paddingVertical: spacing[3], gap: spacing[1] },
  layoutName: { flexShrink: 1 },
  rowDetails: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    columnGap: spacing[2],
    rowGap: spacing[1],
  },
  count: { flexShrink: 1 },
  record: { flexDirection: 'row', alignItems: 'baseline', gap: spacing[1] },
  gradeDot: { width: spacing[2], height: spacing[2], borderRadius: borderRadius.full, alignSelf: 'center' },
  track: { height: spacing[1], marginTop: spacing[1], borderRadius: spacing[1], overflow: 'hidden' },
  bar: { height: '100%', borderRadius: spacing[1] },
});
