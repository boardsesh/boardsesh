import { useCallback, useEffect } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { usePathname, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { offlineBoardKeyForBoard } from '@boardsesh/offline-sync';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { useDownloadActivity } from '../../sync/download-activity-store';
import { useOfflineBoards, useSetting } from '../../settings';
import { useAnySheetVisible } from '../../lib/sheet-visibility-store';
import { publishBottomOverlayHeight, useConnectivityCardHeight } from '../../lib/connectivity-banner-inset-store';
import { useBottomChromeMetrics } from '../../hooks/use-bottom-chrome-metrics';
import { useLaunchReady } from '../../providers/launch-ready-context';
import { useTheme } from '../../providers/theme-provider';
import { track } from '../../lib/analytics';
import { spacing, borderRadius } from '../../theme/tokens';
import { PressableSurface } from '../PressableSurface';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { OfflineDownloadProgressBar } from '../board-discovery/OfflineDownloadProgressBar';

const BOARD_NAMES: Record<string, string> = { kilter: 'Kilter', tension: 'Tension', moonboard: 'MoonBoard' };

/** One root subscriber; byte updates never invalidate the navigator or lists. */
export function OfflineDownloadPill() {
  const activity = useDownloadActivity();
  const boards = useOfflineBoards();
  const [hidden, setHidden] = useSetting('offlineDownloadIndicatorHidden');
  const pathname = usePathname();
  const router = useRouter();
  const sheetVisible = useAnySheetVisible();
  const ready = useLaunchReady();
  const connectivityHeight = useConnectivityCardHeight();
  const bottomChrome = useBottomChromeMetrics();
  const { systemColors } = useTheme();
  const { t } = useTranslation('boards');
  const visible =
    ready &&
    activity !== null &&
    !hidden &&
    !sheetVisible &&
    process.env.EXPO_PUBLIC_SCREENSHOT_MODE !== '1' &&
    !pathname.startsWith('/boards') &&
    !pathname.startsWith('/play');

  useEffect(() => {
    if (!visible) publishBottomOverlayHeight('download', 0);
    return () => publishBottomOverlayHeight('download', 0);
  }, [visible]);
  const publishHeight = useCallback((event: LayoutChangeEvent) => {
    publishBottomOverlayHeight('download', event.nativeEvent.layout.height + spacing[2] * 2);
  }, []);
  const openBoards = useCallback(() => {
    if (!activity) return;
    track(SHARED_EVENTS.OfflineDownloadIndicatorTapped, {
      scopeKey: activity.progress.scopeKey,
      phase: activity.progress.phase,
    });
    router.push('/boards/manage');
  }, [activity, router]);
  const hideProgress = useCallback(() => setHidden(true), [setHidden]);

  if (!visible || !activity) return null;
  const frame = activity.progress;
  const boardName =
    boards.find((board) => offlineBoardKeyForBoard(board) === frame.scopeKey)?.name ??
    BOARD_NAMES[frame.scopeKey.split(':')[0]] ??
    t('mobile.offline.pill.board');
  const phaseLabel =
    activity.status === 'done'
      ? t('mobile.offline.pill.done')
      : activity.status === 'failed'
        ? t('mobile.offline.pill.failed')
        : activity.status === 'waiting'
          ? t('mobile.offline.pill.waiting')
          : frame.phase === 'preparing'
            ? t('mobile.offline.bootstrapPreparing')
            : frame.phase === 'unpacking'
              ? t('mobile.offline.bootstrapImporting')
              : frame.phase === 'grades'
                ? t('mobile.offline.bootstrapGrades')
                : frame.phase === 'finishing'
                  ? t('mobile.offline.finalizing')
                  : t('mobile.offline.bootstrapping');
  const percent = frame.fraction === null ? null : Math.round(frame.fraction * 100);
  return (
    <View
      pointerEvents="box-none"
      style={[
        styles.overlay,
        {
          bottom: bottomChrome.connectivityBannerBottom + connectivityHeight + spacing[2],
        },
      ]}
    >
      <View
        onLayout={publishHeight}
        style={[
          styles.pill,
          { backgroundColor: systemColors.secondaryBackground, borderColor: systemColors.separator },
        ]}
      >
        <View style={styles.actions}>
          <PressableSurface
            onPress={openBoards}
            accessibilityRole="button"
            accessibilityLabel={`${t('mobile.offline.pill.open', { name: boardName })}. ${phaseLabel}`}
            accessibilityValue={percent === null ? undefined : { min: 0, max: 100, now: percent }}
            style={styles.details}
          >
            <Text variant="subheadline" numberOfLines={1}>
              {boardName}
            </Text>
            <Text variant="caption1" color={systemColors.secondaryLabel} numberOfLines={1}>
              {phaseLabel}
              {percent !== null ? ` · ${t('mobile.offline.pill.percent', { percent })}` : ''}
              {frame.fraction === null && frame.rowsProcessed !== undefined
                ? ` · ${t('mobile.offline.pill.rows', { count: frame.rowsProcessed })}`
                : ''}
              {frame.queuedScopes > 0 ? ` · ${t('mobile.offline.pill.more', { count: frame.queuedScopes })}` : ''}
            </Text>
          </PressableSurface>
          <PressableSurface
            onPress={hideProgress}
            accessibilityRole="button"
            accessibilityLabel={t('mobile.offline.pill.hide')}
            style={styles.hide}
          >
            <Icon name="close" size={18} color={systemColors.secondaryLabel} />
          </PressableSurface>
        </View>
        <OfflineDownloadProgressBar fraction={frame.fraction} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    left: spacing[3],
    right: spacing[3],
    alignItems: 'center',
    zIndex: 100,
    elevation: 100,
  },
  pill: {
    width: '100%',
    maxWidth: 520,
    padding: spacing[3],
    borderRadius: borderRadius.lg,
    borderWidth: StyleSheet.hairlineWidth,
  },
  actions: { flexDirection: 'row', alignItems: 'center', gap: spacing[2] },
  details: { flex: 1, minHeight: 44, justifyContent: 'center' },
  hide: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
});
