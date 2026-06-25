import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, RefreshControl, Pressable, StyleSheet } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import type { BottomSheet } from '@expo/ui/community/bottom-sheet';
import type { AscentFeedItem } from '@boardsesh/graphql/operations';
import { toAscentFeedInput } from '@boardsesh/logbook';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { track } from '../../lib/analytics';
import { Text } from '../Text';
import { ScreenTitle } from '../ScreenTitle';
import { Icon } from '../Icon';
import { ActivityIndicator } from '../ActivityIndicator';
import { SearchHeader, type SearchHeaderHandle } from '../SearchHeader';
import { LogbookRow } from './LogbookRow';
import { LogbookEditSheet } from './LogbookEditSheet';
import { LogbookFilterSheet } from './LogbookFilterSheet';
import { useLogbookSearch, countActiveLogbookFilters } from './use-logbook-search';
import { useUserAscentsFeed } from '../../lib/graphql/hooks';
import { openClimbInPlayDrawer } from '../../lib/open-climb-in-play-drawer';
import { tickToClimb } from '../../lib/tick-to-climb';
import { getBoardConfigForPlaylist } from '../../lib/playlists/board-details-for-playlist';
import { useBottomChromeMetrics } from '../../hooks/use-bottom-chrome-metrics';
import { useDrawerHost } from '../../providers/drawer-host-provider';
import { useFeatureFlag } from '../../providers/feature-flags-provider';
import { normalizeSearchName } from '../../lib/search-name';
import { hapticSelection } from '../../lib/haptics';
import { iosSystemColors } from '../../theme/ios-colors';
import { spacing, borderRadius } from '../../theme/tokens';
import { useTheme } from '../../providers/theme-provider';

const SEARCH_DEBOUNCE_MS = 300;

type LogbookTabProps = {
  userId: string | undefined;
  /** Measured chrome height — the fixed toolbar insets its top by this so it
   *  rests below the floating chrome and results scroll beneath the toolbar. */
  topInset?: number;
  /**
   * Whether the signed-in user owns this logbook. Defaults to true (the You
   * tab). When false (viewing another climber's profile) a row opens the climb
   * read-only in the play drawer instead of the editable LogbookEditSheet.
   */
  viewerIsOwner?: boolean;
  /** In-body identity title (the own "You" tab passes "You"). Omitted on another
   *  climber's profile, where the name lives in the public-profile header. */
  screenTitle?: string;
};

export function LogbookTab({ userId, topInset = 0, viewerIsOwner = true, screenTitle }: LogbookTabProps) {
  const { t } = useTranslation('you');
  const { systemColors, brandColors } = useTheme();
  // The search + filter UI is unfinished; keep it dark until the flag is on.
  const logbookFiltersEnabled = useFeatureFlag('logbook-filters') === true;
  const router = useRouter();
  const { openPlayDrawer, openClimbActions } = useDrawerHost();
  const bottomChrome = useBottomChromeMetrics();
  const paddingBottom = bottomChrome.scrollBottomPadding + spacing[4];

  const editSheetRef = useRef<BottomSheet | null>(null);
  const [editAscent, setEditAscent] = useState<AscentFeedItem | null>(null);

  // Logbook search/filter/sort state. The committed name lives here; the visible
  // input value is debounced before it commits to the query.
  const logbookSearch = useLogbookSearch();
  const { filters, sort, name, setName, apply, hydrated } = logbookSearch;
  const activeFilterCount = useMemo(() => countActiveLogbookFilters(filters), [filters]);
  const [filterSheetOpen, setFilterSheetOpen] = useState(false);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchHeaderRef = useRef<SearchHeaderHandle>(null);

  useEffect(() => () => clearTimeout(debounceTimerRef.current ?? undefined), []);

  const handleSearchChange = useCallback(
    (text: string) => {
      const nextName = normalizeSearchName(text);
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = setTimeout(() => setName(nextName), SEARCH_DEBOUNCE_MS);
    },
    [setName],
  );

  // Clear the committed term AND the input field (silent: don't re-arm the
  // debounce). Wired to the sheet's Reset so "Reset" is a true clean slate.
  const clearSearch = useCallback(() => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    setName('');
    searchHeaderRef.current?.setText('', { silent: true });
  }, [setName]);

  const handleOpenFilters = useCallback(() => {
    hapticSelection();
    setFilterSheetOpen(true);
  }, []);

  const handleCloseFilters = useCallback(() => setFilterSheetOpen(false), []);

  // The query input is rebuilt only when the committed filters/sort/name change,
  // so the React Query key (and the FlashList data identity downstream) is stable
  // between unrelated re-renders.
  const feedInput = useMemo(() => toAscentFeedInput({ filters, sort, name }), [filters, sort, name]);

  // Gate on `hydrated` so the feed fetches once with the restored prefs rather
  // than once with defaults then again after persistence loads.
  const feed = useUserAscentsFeed(userId, feedInput, { enabled: hydrated });
  // Stabilise the FlashList `data` identity so it doesn't re-diff every render.
  const items = useMemo(() => feed.data?.pages.flatMap((page) => page.userAscentsFeed.items) ?? [], [feed.data]);

  // Tap → set the climb active and open the play drawer (own logbook and another
  // climber's read-only logbook alike). AscentFeedItem structurally satisfies the
  // `tick` kind, which builds the climb + board config from frames.
  const handleActivate = useCallback(
    (ascent: AscentFeedItem) => {
      track(SHARED_EVENTS.LogbookRowClicked, { climbUuid: ascent.climbUuid });
      // Default open mode is now "set active", so no option is needed here.
      openClimbInPlayDrawer({ kind: 'tick', tick: ascent }, { openPlayDrawer, router });
    },
    [openPlayDrawer, router],
  );

  // Swipe left-to-right → edit this tick (owner-only). The old tap behaviour.
  const handleEdit = useCallback((ascent: AscentFeedItem) => {
    setEditAscent(ascent);
    editSheetRef.current?.snapToIndex(0);
  }, []);

  // Long press → open the climb actions sheet. For the owner it carries an
  // "Edit entry" row wired back to the tick editor. No-op when the board can't
  // resolve (no frames / MoonBoard) — nothing to render in the actions sheet.
  const handleOpenActions = useCallback(
    (ascent: AscentFeedItem) => {
      // Fall back to the consensus grade so the reaction menu shows a grade even when
      // the climber didn't log a personal one (tickToClimb only reads difficultyName).
      const climb = tickToClimb({
        ...ascent,
        difficultyName: ascent.difficultyName ?? ascent.consensusDifficultyName,
      });
      const config = getBoardConfigForPlaylist(ascent.boardType, ascent.layoutId);
      if (!climb || !config) return;
      openClimbActions(
        climb,
        {
          boardName: config.boardName,
          layoutId: config.layoutId,
          sizeId: config.sizeId,
          setIds: config.setIds.join(','),
          angle: ascent.angle,
        },
        viewerIsOwner ? { onEditEntry: () => handleEdit(ascent) } : undefined,
      );
    },
    [openClimbActions, viewerIsOwner, handleEdit],
  );

  const handleEndReached = useCallback(() => {
    if (feed.hasNextPage && !feed.isFetchingNextPage) void feed.fetchNextPage();
  }, [feed.hasNextPage, feed.isFetchingNextPage, feed.fetchNextPage]);

  const handleRetry = useCallback(() => {
    void feed.refetch();
  }, [feed.refetch]);

  const renderItem = useCallback(
    ({ item }: { item: AscentFeedItem }) => (
      <LogbookRow
        ascent={item}
        onActivate={handleActivate}
        onOpenActions={handleOpenActions}
        onEdit={viewerIsOwner ? handleEdit : undefined}
      />
    ),
    [handleActivate, handleOpenActions, handleEdit, viewerIsOwner],
  );

  const handleRefresh = useCallback(() => void feed.refetch(), [feed.refetch]);

  if (!userId) {
    return (
      <View style={[styles.centered, { paddingTop: topInset }]}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  return (
    <View style={styles.flex}>
      {/* Fixed top toolbar — all logbook actions concentrated here, below the
          floating chrome. Sibling of the list, so list virtualization is intact. */}
      <View style={[styles.toolbar, { paddingTop: topInset }]}>
        {screenTitle ? <ScreenTitle style={styles.screenTitle}>{screenTitle}</ScreenTitle> : null}
        {logbookFiltersEnabled ? (
          <View style={styles.toolbarRow}>
            <SearchHeader
              ref={searchHeaderRef}
              placeholder={t('mobile.logbook.searchPlaceholder')}
              onChangeText={handleSearchChange}
              initialValue={name}
              height={40}
            />
            <Pressable
              onPress={handleOpenFilters}
              accessibilityRole="button"
              accessibilityLabel={t('mobile.logbook.filter')}
              style={({ pressed }) => [
                styles.filterButton,
                { backgroundColor: brandColors.accent },
                pressed && styles.filterButtonPressed,
              ]}
            >
              <Icon name="filter" size={18} color={iosSystemColors.black} />
              {activeFilterCount > 0 ? (
                <View style={[styles.filterBadge, { backgroundColor: iosSystemColors.black }]}>
                  <Text variant="caption2" color={brandColors.accent} style={styles.filterBadgeText}>
                    {activeFilterCount}
                  </Text>
                </View>
              ) : null}
            </Pressable>
          </View>
        ) : null}
      </View>

      {feed.isPending ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" />
        </View>
      ) : feed.isError ? (
        <View style={styles.errorContainer}>
          <Icon name="error" size={48} color={systemColors.tertiaryLabel} />
          <Text variant="headline" style={styles.errorTitle}>
            {t('mobile.logbook.errorTitle')}
          </Text>
          <Text variant="subheadline" style={styles.errorBody}>
            {t('mobile.logbook.errorBody')}
          </Text>
          <Pressable
            onPress={handleRetry}
            disabled={feed.isRefetching}
            accessibilityRole="button"
            accessibilityLabel={t('mobile.logbook.retry')}
            style={({ pressed }) => [
              styles.retryButton,
              { borderColor: brandColors.primary },
              feed.isRefetching && styles.retryButtonDisabled,
              pressed && !feed.isRefetching && { backgroundColor: `${brandColors.primary}1A` },
            ]}
          >
            <Text variant="footnote" color={brandColors.primary}>
              {t('mobile.logbook.retry')}
            </Text>
          </Pressable>
        </View>
      ) : (
        <FlashList
          data={items}
          renderItem={renderItem}
          keyExtractor={keyExtractor}
          contentInsetAdjustmentBehavior="never"
          onEndReached={handleEndReached}
          onEndReachedThreshold={0.5}
          contentContainerStyle={{ paddingBottom }}
          refreshControl={
            <RefreshControl refreshing={feed.isRefetching} onRefresh={handleRefresh} tintColor={brandColors.primary} />
          }
          ListFooterComponent={
            feed.isFetchingNextPage ? (
              <View style={styles.footer}>
                <ActivityIndicator size="small" />
              </View>
            ) : null
          }
          ListEmptyComponent={
            <View style={styles.empty}>
              <Icon name="tick.outline" size={48} color={systemColors.tertiaryLabel} />
              <Text variant="headline" style={styles.emptyTitle}>
                {activeFilterCount > 0 || name ? t('mobile.logbook.emptyFiltered') : t('mobile.logbook.empty')}
              </Text>
            </View>
          }
        />
      )}

      {viewerIsOwner ? (
        <LogbookEditSheet sheetRef={editSheetRef} ascent={editAscent} onClose={() => setEditAscent(null)} />
      ) : null}

      {logbookFiltersEnabled && filterSheetOpen ? (
        <LogbookFilterSheet
          onDismiss={handleCloseFilters}
          currentFilters={filters}
          currentSort={sort}
          onApply={apply}
          onClearSearch={clearSearch}
        />
      ) : null}
    </View>
  );
}

function keyExtractor(item: AscentFeedItem) {
  return item.uuid;
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  footer: { paddingVertical: spacing[5], alignItems: 'center' },
  toolbar: {
    paddingHorizontal: spacing[4],
    paddingBottom: spacing[2],
  },
  toolbarRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
  screenTitle: {
    paddingHorizontal: 0,
    paddingTop: 0,
    paddingBottom: spacing[2],
  },
  filterButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  filterButtonPressed: { opacity: 0.85 },
  filterBadge: {
    position: 'absolute',
    top: -2,
    right: -2,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    paddingHorizontal: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  filterBadgeText: { fontWeight: '700' },
  empty: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 120,
    paddingHorizontal: spacing[8],
    gap: spacing[2],
  },
  emptyTitle: { opacity: 0.6, marginTop: spacing[3], textAlign: 'center' },
  errorContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing[8],
    gap: spacing[2],
  },
  errorTitle: { marginTop: spacing[3], textAlign: 'center' },
  errorBody: { opacity: 0.6, textAlign: 'center' },
  retryButton: {
    marginTop: spacing[3],
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[2],
    borderRadius: borderRadius.full,
    borderWidth: StyleSheet.hairlineWidth,
  },
  retryButtonDisabled: { opacity: 0.5 },
});
