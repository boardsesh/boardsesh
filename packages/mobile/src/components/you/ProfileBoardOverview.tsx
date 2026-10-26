import { memo } from 'react';
import { View, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { RawLayoutPercentage, RawStatisticsSummary } from '@boardsesh/profile-stats';
import { Text } from '../Text';
import { PressableSurface } from '../PressableSurface';
import { useTheme } from '../../providers/theme-provider';
import { getCachedNumberFormat } from '../../lib/intl-formatter-cache';
import { spacing, borderRadius } from '../../theme/tokens';
import { useVariantValue } from '../../theme/variants';
import { gradeBadgeColor } from './profile-chart-colors';
import type { ProfileTotalsStatus } from '../../lib/graphql/hooks/use-you-profile-data';

/**
 * The authoritative all-board total is independent of the progress filters. It
 * renders a number only once the totals request succeeded (`status: 'ready'`);
 * otherwise it says what state the totals are in, never a made-up 0.
 */
export const ProfileBoardOverview = memo(function ProfileBoardOverview({
  summary,
  status,
  onRetry,
  isOwnProfile = true,
}: {
  summary: RawStatisticsSummary;
  status: ProfileTotalsStatus;
  onRetry: () => void;
  isOwnProfile?: boolean;
}) {
  const { t, i18n } = useTranslation('profile');
  const { t: tCommon } = useTranslation('common');
  const { systemColors, brandColors, textStyles } = useTheme();
  const totalColor = useVariantValue({ liquidGlass: systemColors.accent, material: systemColors.label });
  return (
    <View style={styles.header} testID="profile-board-overview" accessible={status !== 'error'}>
      <Text variant="title2" style={styles.heading}>
        {isOwnProfile ? t('stats.boardOverview.title') : t('stats.boardOverview.publicTitle')}
      </Text>
      {status === 'ready' ? (
        <View style={styles.totalRow}>
          <Text variant="largeTitle" color={totalColor} style={styles.total}>
            {getCachedNumberFormat(i18n.language).format(summary.totalAscents)}
          </Text>
          <View style={styles.totalCaption}>
            <Text variant="subheadline">{t('stats.boardOverview.climbsLabel', { count: summary.totalAscents })}</Text>
            <Text variant="caption1" color={systemColors.secondaryLabel}>
              {t('stats.boardOverview.layouts', { count: summary.layoutPercentages.length })}
            </Text>
          </View>
        </View>
      ) : null}
      {status === 'loading' ? (
        <View
          style={styles.totalRow}
          testID="profile-board-overview-loading"
          accessibilityLabel={t('stats.boardOverview.totalsLoading')}
        >
          <View
            style={[
              styles.skeletonTotal,
              { height: textStyles.largeTitle.lineHeight, backgroundColor: systemColors.fill },
            ]}
          />
          <View style={[styles.totalCaption, styles.skeletonCaption]}>
            <View style={[styles.skeletonLine, { backgroundColor: systemColors.fill }]} />
            <View style={[styles.skeletonLineShort, { backgroundColor: systemColors.fill }]} />
          </View>
        </View>
      ) : null}
      {status === 'error' ? (
        <View style={styles.statusRow} testID="profile-board-overview-error">
          <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.statusText}>
            {t('stats.boardOverview.totalsError')}
          </Text>
          <PressableSurface
            testID="profile-board-overview-retry"
            onPress={onRetry}
            feedback="opacity"
            accessibilityRole="button"
            style={styles.retry}
          >
            <Text variant="subheadline" color={brandColors.primary}>
              {tCommon('actions.retry')}
            </Text>
          </PressableSurface>
        </View>
      ) : null}
      {status === 'offline' ? (
        <View testID="profile-board-overview-offline">
          <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.statusText}>
            {t('stats.boardOverview.totalsOffline')}
          </Text>
        </View>
      ) : null}
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
  // Same footprint as the loaded total so the list doesn't jump when it lands.
  skeletonTotal: { width: spacing[12], borderRadius: borderRadius.sm },
  skeletonCaption: { gap: spacing[2] },
  skeletonLine: { width: '50%', height: spacing[3], borderRadius: borderRadius.sm },
  skeletonLineShort: { width: '35%', height: spacing[3], borderRadius: borderRadius.sm },
  statusRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: spacing[3] },
  statusText: { paddingVertical: spacing[2] },
  retry: { minHeight: spacing[12], justifyContent: 'center' },
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
