import { memo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Icon } from '../Icon';
import { Text } from '../Text';
import { useTheme } from '../../providers/theme-provider';
import { iosSystemColors } from '../../theme/ios-colors';
import { borderRadius, spacing } from '../../theme/tokens';
import { LIVE_TILE_GAP, LIVE_TILE_WIDTH } from './live-session-model';
import { useLiveSessionColors } from './use-live-session-colors';

const SKELETON_KEYS = ['live-skeleton-1', 'live-skeleton-2'] as const;

/** Two placeholder tiles at the real footprint, so data lands without a jump. */
export const LiveRailSkeleton = memo(function LiveRailSkeleton({ height }: { height: number }) {
  const { systemColors } = useTheme();
  const colors = useLiveSessionColors();
  const block = { backgroundColor: systemColors.fill };
  return (
    <View
      testID="live-sessions-skeleton"
      style={styles.skeletonRow}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {SKELETON_KEYS.map((key) => (
        <View
          key={key}
          style={[styles.skeletonTile, { height, backgroundColor: colors.surface, borderColor: colors.border }]}
        >
          <View style={styles.skeletonAvatars}>
            <View style={[styles.skeletonAvatar, block]} />
            <View style={[styles.skeletonAvatar, styles.skeletonAvatarOverlap, block]} />
          </View>
          <View style={[styles.skeletonLine, styles.skeletonLineWide, block]} />
          <View style={[styles.skeletonLine, styles.skeletonLineMid, block]} />
          <View style={[styles.skeletonLine, styles.skeletonLineShort, block]} />
          <View style={styles.flex} />
          <View style={styles.skeletonFooter}>
            <View style={[styles.skeletonLine, styles.skeletonLineShort, block]} />
            <View style={[styles.skeletonPill, block]} />
          </View>
        </View>
      ))}
    </View>
  );
});

/** Compact error row: a failed rail should not cost a 192pt dead tile. */
export const LiveRailErrorRow = memo(function LiveRailErrorRow({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation('feed');
  const { t: tCommon } = useTranslation('common');
  const { brandColors, systemColors } = useTheme();
  return (
    <View testID="live-sessions-error" style={[styles.stateRow, { borderColor: systemColors.separator }]}>
      <Icon name="error" size={20} color={iosSystemColors.systemRed} />
      <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.flex}>
        {t('mobile.liveSessions.error')}
      </Text>
      <Pressable
        onPress={onRetry}
        accessibilityRole="button"
        hitSlop={spacing[1]}
        style={({ pressed }) => [
          styles.retry,
          { borderColor: brandColors.primary },
          pressed && { backgroundColor: `${brandColors.primary}1A` },
        ]}
      >
        <Text variant="subheadline" color={brandColors.primary}>
          {tCommon('actions.retry')}
        </Text>
      </Pressable>
    </View>
  );
});

/**
 * No action: the rail refills on its own once the phone is back online. When
 * the climber switched Offline mode on themselves, say that rather than blame
 * their signal.
 */
export const LiveRailOfflineRow = memo(function LiveRailOfflineRow({ offlineMode }: { offlineMode: boolean }) {
  const { t } = useTranslation('feed');
  const { systemColors } = useTheme();
  return (
    <View testID="live-sessions-offline" style={[styles.stateRow, { borderColor: systemColors.separator }]}>
      <Icon name="offline.unavailable" size={20} color={systemColors.secondaryLabel} />
      <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.flex}>
        {offlineMode ? t('mobile.liveSessions.offlineMode') : t('mobile.liveSessions.offline')}
      </Text>
    </View>
  );
});

const styles = StyleSheet.create({
  flex: { flex: 1 },
  skeletonRow: {
    flexDirection: 'row',
    gap: LIVE_TILE_GAP,
    paddingHorizontal: spacing[4],
    overflow: 'hidden',
  },
  skeletonTile: {
    width: LIVE_TILE_WIDTH,
    padding: spacing[3],
    borderRadius: borderRadius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing[2],
  },
  skeletonAvatars: { flexDirection: 'row' },
  skeletonAvatar: { width: 40, height: 40, borderRadius: 20, opacity: 0.6 },
  skeletonAvatarOverlap: { marginLeft: -14 },
  skeletonLine: { height: 12, borderRadius: borderRadius.full, opacity: 0.5 },
  skeletonLineWide: { width: '70%', height: 16 },
  skeletonLineMid: { width: '58%' },
  skeletonLineShort: { width: '40%' },
  skeletonFooter: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  skeletonPill: { width: 72, height: 44, borderRadius: borderRadius.full, opacity: 0.5 },
  stateRow: {
    marginHorizontal: spacing[4],
    minHeight: 72,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: borderRadius.md,
    padding: spacing[3],
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
  retry: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: spacing[3],
    borderRadius: borderRadius.full,
    borderWidth: StyleSheet.hairlineWidth,
  },
});
