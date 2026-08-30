import { memo, useCallback, useMemo } from 'react';
import { Pressable, RefreshControl, StyleSheet, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import type { LocalBoard } from '../../lib/boards/local-board';
import { getLocalBoard } from '../../lib/boards/local-board-store';
import {
  getLocalProfileLogbookPage,
  getLocalProfileStats,
  LOCAL_PROFILE_LOGBOOK_PAGE_SIZE,
  type LocalProfileLogbookEntry,
  type LocalProfileStats,
} from '../../db/queries/local-profile-logbook';
import { getCachedDateTimeFormat } from '../../lib/intl-formatter-cache';
import { useGradeFormat } from '../../hooks/use-grade-format';
import { useBottomChromeMetrics } from '../../hooks/use-bottom-chrome-metrics';
import { useTheme } from '../../providers/theme-provider';
import { spacing, borderRadius } from '../../theme/tokens';
import { ActivityIndicator } from '../ActivityIndicator';
import { Icon } from '../Icon';
import { Text } from '../Text';

const LOCAL_PROFILE_LOGBOOK_KEY = ['logbook', 'local-profile'] as const;
const LOCAL_PROFILE_STATS_KEY = ['logbook', 'local-profile-stats'] as const;

function boardLabel(boardType: string): string {
  if (boardType === 'kilter') return 'Kilter';
  if (boardType === 'tension') return 'Tension';
  if (boardType === 'moonboard') return 'MoonBoard';
  return boardType;
}

type LocalLogbookRowProps = {
  entry: LocalProfileLogbookEntry;
  board: LocalBoard | null | undefined;
  dateLabel: string;
  gradeLabel: string | null;
  statusLabel: string;
  attemptsLabel: string;
  fallbackName: string;
  onOpen: (entry: LocalProfileLogbookEntry, board: LocalBoard) => void;
};

const LocalLogbookRow = memo(function LocalLogbookRow({
  entry,
  board,
  dateLabel,
  gradeLabel,
  statusLabel,
  attemptsLabel,
  fallbackName,
  onOpen,
}: LocalLogbookRowProps) {
  const { systemColors } = useTheme();
  const canOpen = board?.boardType === entry.boardType;
  const handlePress = useCallback(() => {
    if (canOpen && board) onOpen(entry, board);
  }, [board, canOpen, entry, onOpen]);

  return (
    <Pressable
      onPress={handlePress}
      disabled={!canOpen}
      accessibilityRole={canOpen ? 'button' : undefined}
      style={({ pressed }) => [
        styles.logbookRow,
        { borderBottomColor: systemColors.separator },
        pressed && canOpen && { backgroundColor: systemColors.fill },
      ]}
    >
      <View style={styles.rowCopy}>
        <Text variant="headline" numberOfLines={1}>
          {entry.climbName ?? fallbackName}
        </Text>
        <Text variant="footnote" color={systemColors.secondaryLabel} numberOfLines={1}>
          {[boardLabel(entry.boardType), `${entry.angle}°`, dateLabel].join(' · ')}
        </Text>
        {entry.setterUsername ? (
          <Text variant="caption1" color={systemColors.tertiaryLabel} numberOfLines={1}>
            {entry.setterUsername}
          </Text>
        ) : null}
      </View>
      <View style={styles.rowOutcome}>
        <Text variant="subheadline">{statusLabel}</Text>
        <Text variant="footnote" color={systemColors.secondaryLabel}>
          {[gradeLabel, attemptsLabel].filter(Boolean).join(' · ')}
        </Text>
      </View>
      {canOpen ? <Icon name="chevron.right" size={14} color={systemColors.tertiaryLabel} /> : null}
    </Pressable>
  );
});

type LocalYouHeaderProps = {
  stats: LocalProfileStats;
  onOpenMore: () => void;
};

const LocalYouHeader = memo(function LocalYouHeader({ stats, onOpenMore }: LocalYouHeaderProps) {
  const { t } = useTranslation('you');
  const { t: tCommon } = useTranslation('common');
  const { systemColors, brandColors } = useTheme();
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.header, { paddingTop: insets.top + spacing[3] }]}>
      <View style={styles.titleRow}>
        <View style={styles.titleCopy}>
          <Text variant="largeTitle">{t('mobile.local.title')}</Text>
          <Text variant="subheadline" color={systemColors.secondaryLabel}>
            {t('mobile.local.privateSubtitle')}
          </Text>
        </View>
        <Pressable
          onPress={onOpenMore}
          accessibilityRole="button"
          accessibilityLabel={tCommon('ariaLabels.settings')}
          hitSlop={8}
          style={({ pressed }) => [styles.settingsButton, pressed && { backgroundColor: systemColors.fill }]}
        >
          <Icon name="settings" size={22} color={brandColors.primary} />
        </Pressable>
      </View>

      <View style={styles.statsRow}>
        <View style={[styles.stat, { backgroundColor: systemColors.secondaryBackground }]}>
          <Text variant="title2">{stats.sends}</Text>
          <Text variant="caption1" color={systemColors.secondaryLabel}>
            {t('mobile.local.stats.sends')}
          </Text>
        </View>
        <View style={[styles.stat, { backgroundColor: systemColors.secondaryBackground }]}>
          <Text variant="title2">{stats.flashes}</Text>
          <Text variant="caption1" color={systemColors.secondaryLabel}>
            {t('mobile.local.stats.flashes')}
          </Text>
        </View>
        <View style={[styles.stat, { backgroundColor: systemColors.secondaryBackground }]}>
          <Text variant="title2">{stats.attempts}</Text>
          <Text variant="caption1" color={systemColors.secondaryLabel}>
            {t('mobile.local.stats.attempts')}
          </Text>
        </View>
      </View>

      <Text variant="title3" style={styles.logbookTitle}>
        {t('mobile.local.logbookTitle')}
      </Text>
    </View>
  );
});

export function LocalYouScreen() {
  const db = useSQLiteContext();
  const router = useRouter();
  const { t, i18n } = useTranslation('you');
  const { systemColors, brandColors } = useTheme();
  const { formatGradeByDifficultyId } = useGradeFormat();
  const bottomChrome = useBottomChromeMetrics();
  const dateFormatter = useMemo(
    () => getCachedDateTimeFormat(i18n.resolvedLanguage, { year: 'numeric', month: 'short', day: 'numeric' }),
    [i18n.resolvedLanguage],
  );
  const boardQuery = useQuery({ queryKey: ['localBoard'], queryFn: getLocalBoard, staleTime: Infinity });
  const statsQuery = useQuery({ queryKey: LOCAL_PROFILE_STATS_KEY, queryFn: () => getLocalProfileStats(db) });
  const logbookQuery = useInfiniteQuery({
    queryKey: LOCAL_PROFILE_LOGBOOK_KEY,
    initialPageParam: 0,
    queryFn: ({ pageParam }) => getLocalProfileLogbookPage(db, pageParam),
    getNextPageParam: (lastPage, _pages, lastPageParam) =>
      lastPage.hasMore ? lastPageParam + LOCAL_PROFILE_LOGBOOK_PAGE_SIZE : undefined,
  });
  const entries = useMemo(
    () => logbookQuery.data?.pages.flatMap((page) => page.entries) ?? [],
    [logbookQuery.data?.pages],
  );

  const openMore = useCallback(() => router.push('/(tabs)/profile/more'), [router]);
  const openEntry = useCallback(
    (entry: LocalProfileLogbookEntry, board: LocalBoard) => {
      router.push({
        pathname: '/(tabs)/climbs/[climbUuid]',
        params: {
          climbUuid: entry.climbUuid,
          boardName: board.boardType,
          layoutId: String(board.layoutId),
          sizeId: String(board.sizeId),
          setIds: board.setIds,
          angle: String(entry.angle),
        },
      });
    },
    [router],
  );
  const refresh = useCallback(() => {
    void Promise.all([logbookQuery.refetch(), statsQuery.refetch()]);
  }, [logbookQuery, statsQuery]);
  const loadMore = useCallback(() => {
    if (logbookQuery.hasNextPage && !logbookQuery.isFetchingNextPage) void logbookQuery.fetchNextPage();
  }, [logbookQuery]);
  const keyExtractor = useCallback((entry: LocalProfileLogbookEntry) => entry.uuid, []);
  const renderItem = useCallback(
    ({ item }: { item: LocalProfileLogbookEntry }) => {
      const timestamp = new Date(item.climbedAt);
      const dateLabel = Number.isNaN(timestamp.getTime()) ? '' : dateFormatter.format(timestamp);
      const statusLabel =
        item.status === 'flash'
          ? t('mobile.local.status.flash')
          : item.status === 'send'
            ? t('mobile.local.status.send')
            : t('mobile.local.status.attempt');
      return (
        <LocalLogbookRow
          entry={item}
          board={boardQuery.data}
          dateLabel={dateLabel}
          gradeLabel={formatGradeByDifficultyId(item.difficulty)}
          statusLabel={statusLabel}
          attemptsLabel={t('mobile.local.tries', { count: item.attemptCount })}
          fallbackName={t('mobile.local.unknownClimb')}
          onOpen={openEntry}
        />
      );
    },
    [boardQuery.data, dateFormatter, formatGradeByDifficultyId, openEntry, t],
  );
  const header = useMemo(
    () => <LocalYouHeader stats={statsQuery.data ?? { sends: 0, flashes: 0, attempts: 0 }} onOpenMore={openMore} />,
    [openMore, statsQuery.data],
  );

  if ((logbookQuery.isLoading || statsQuery.isLoading) && entries.length === 0) {
    return (
      <View style={[styles.centered, { backgroundColor: systemColors.background }]}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  if (logbookQuery.isError || statsQuery.isError) {
    return (
      <View style={[styles.centered, styles.errorPadding, { backgroundColor: systemColors.background }]}>
        <Icon name="error" size={48} color={systemColors.tertiaryLabel} />
        <Text variant="headline">{t('mobile.local.errorTitle')}</Text>
        <Pressable onPress={refresh} accessibilityRole="button" style={styles.retryButton}>
          <Text color={brandColors.primary}>{t('mobile.local.retry')}</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: systemColors.background }]}>
      <FlashList
        data={entries}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        ListHeaderComponent={header}
        onEndReached={loadMore}
        onEndReachedThreshold={0.5}
        contentContainerStyle={{ paddingBottom: bottomChrome.scrollBottomPadding + spacing[4] }}
        refreshControl={
          <RefreshControl
            refreshing={logbookQuery.isRefetching || statsQuery.isRefetching}
            onRefresh={refresh}
            tintColor={brandColors.primary}
          />
        }
        ListFooterComponent={logbookQuery.isFetchingNextPage ? <ActivityIndicator size="small" /> : null}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Icon name="tick.outline" size={48} color={systemColors.tertiaryLabel} />
            <Text variant="headline" style={styles.emptyTitle}>
              {t('mobile.local.empty')}
            </Text>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing[3] },
  errorPadding: { paddingHorizontal: spacing[6] },
  retryButton: { padding: spacing[3] },
  header: { paddingHorizontal: spacing[4] },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing[3] },
  titleCopy: { flex: 1, gap: spacing[1] },
  settingsButton: {
    width: 44,
    height: 44,
    borderRadius: borderRadius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  statsRow: { flexDirection: 'row', gap: spacing[2], paddingTop: spacing[5] },
  stat: { flex: 1, alignItems: 'center', paddingVertical: spacing[3], borderRadius: borderRadius.lg, gap: spacing[1] },
  logbookTitle: { paddingTop: spacing[6], paddingBottom: spacing[2] },
  logbookRow: {
    minHeight: 76,
    marginHorizontal: spacing[4],
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    paddingVertical: spacing[3],
  },
  rowCopy: { flex: 1, gap: spacing[1] },
  rowOutcome: { alignItems: 'flex-end', gap: spacing[1] },
  empty: { alignItems: 'center', paddingHorizontal: spacing[6], paddingVertical: spacing[12] },
  emptyTitle: { paddingTop: spacing[3], textAlign: 'center' },
});
