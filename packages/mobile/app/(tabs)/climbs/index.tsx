import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { View, Pressable, StyleSheet, RefreshControl, Image } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useNavigation, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import type { Climb, BoardName } from '@boardsesh/shared-schema';
import { getGradeColor, DEFAULT_GRADE_COLOR } from '@boardsesh/board-constants/grade-colors';
import { ClimbListRow } from '../../../src/components/ClimbListRow';
import { ActivityIndicator } from '../../../src/components/ActivityIndicator';
import { Text } from '../../../src/components/Text';
import { Icon } from '../../../src/components/Icon';
import { Button } from '../../../src/components/Button';
import {
  ClimbFilterSheet,
  hasActiveFilters,
  DEFAULT_FILTERS,
  type ClimbFilters,
} from '../../../src/components/ClimbFilterSheet';
import { useSearchClimbs } from '../../../src/lib/graphql/hooks';
import { useEffectiveDefaultBoard } from '../../../src/lib/hooks/use-effective-default-board';
import { accumulateClimbs } from '../../../src/lib/climb-pagination';
import { getBoardRenderData } from '../../../src/lib/board-details';
import { brandColors } from '../../../src/theme/colors';
import { iosSystemColors } from '../../../src/theme/ios-colors';

const PAGE_SIZE = 30;
const SEARCH_DEBOUNCE_MS = 300;

export default function ClimbList() {
  const router = useRouter();
  const navigation = useNavigation();
  const { t } = useTranslation('climbs');
  const { t: tAuth } = useTranslation('auth');

  const [debouncedSearch, setDebouncedSearch] = useState('');
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [filters, setFilters] = useState<ClimbFilters>(DEFAULT_FILTERS);
  const [showFilters, setShowFilters] = useState(false);

  const filtersActive = hasActiveFilters(filters);

  const handleOpenFilters = useCallback(() => {
    setShowFilters(true);
  }, []);

  const handleDismissFilters = useCallback(() => {
    setShowFilters(false);
  }, []);

  const handleApplyFilters = useCallback((newFilters: ClimbFilters) => {
    setFilters(newFilters);
    setShowFilters(false);
  }, []);

  // Wire up the native search bar's onChangeText and header right filter button
  useEffect(() => {
    navigation.setOptions({
      headerSearchBarOptions: {
        placeholder: t('search.placeholders.climbs'),
        autoCapitalize: 'none',
        hideWhenScrolling: false,
        onChangeText: (event: { nativeEvent: { text: string } }) => {
          const text = event.nativeEvent.text;

          if (debounceTimerRef.current) {
            clearTimeout(debounceTimerRef.current);
          }
          debounceTimerRef.current = setTimeout(() => {
            setDebouncedSearch(text);
          }, SEARCH_DEBOUNCE_MS);
        },
      },
      headerRight: () => (
        <Pressable onPress={handleOpenFilters} hitSlop={8} accessibilityRole="button">
          <Icon name="filter" size={22} color={filtersActive ? brandColors.primary : iosSystemColors.systemGray} />
        </Pressable>
      ),
    });

    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, [navigation, t, filtersActive, handleOpenFilters]);

  const { data: defaultBoard, isLoading: isBoardLoading } = useEffectiveDefaultBoard();

  const boardName = defaultBoard?.boardType ?? '';
  const layoutId = defaultBoard?.layoutId ?? 0;
  const sizeId = defaultBoard?.sizeId ?? 0;
  const setIds = defaultBoard?.setIds ?? '';
  const angle = defaultBoard?.angle ?? 0;

  const hasBoardConfig = !!defaultBoard;

  // Pre-warm board images so they're cached before the user taps into a climb
  useEffect(() => {
    if (!defaultBoard) return;
    const parsedSetIds = defaultBoard.setIds.split(',').map(Number);
    const renderData = getBoardRenderData({
      boardName: defaultBoard.boardType as BoardName,
      layoutId: defaultBoard.layoutId,
      sizeId: defaultBoard.sizeId,
      setIds: parsedSetIds,
    });
    if (renderData?.imageUrls) {
      for (const url of renderData.imageUrls) {
        Image.prefetch(url);
      }
    }
  }, [defaultBoard]);

  // Track pagination
  const [pageNumber, setPageNumber] = useState(1);
  // Accumulate climbs across pages for infinite scroll
  const [accumulatedClimbs, setAccumulatedClimbs] = useState<Climb[]>([]);

  // Clear accumulated climbs and reset page when search or filters change
  useEffect(() => {
    setAccumulatedClimbs([]);
    setPageNumber(1);
  }, [debouncedSearch, filters]);

  const searchInput = useMemo(
    () => ({
      boardName,
      layoutId,
      sizeId,
      setIds,
      angle,
      ...(debouncedSearch.length > 0 ? { name: debouncedSearch } : {}),
      page: pageNumber,
      pageSize: PAGE_SIZE,
      sortBy: filters.sortBy,
      sortOrder: filters.sortOrder,
      ...(filters.minGrade != null ? { minGrade: filters.minGrade } : {}),
      ...(filters.maxGrade != null ? { maxGrade: filters.maxGrade } : {}),
      ...(filters.minAscents != null ? { minAscents: filters.minAscents } : {}),
      ...(filters.minRating != null ? { minRating: filters.minRating } : {}),
    }),
    [boardName, layoutId, sizeId, setIds, angle, debouncedSearch, pageNumber, filters],
  );

  const {
    data: searchResult,
    isLoading: isClimbsLoading,
    isRefetching,
    refetch,
  } = useSearchClimbs(searchInput, hasBoardConfig);
  const hasMore = searchResult?.hasMore ?? false;
  const isLoadingMoreRef = useRef(false);

  useEffect(() => {
    if (!searchResult?.climbs) return;

    isLoadingMoreRef.current = false;

    setAccumulatedClimbs((previous) => accumulateClimbs(previous, searchResult.climbs, pageNumber));
  }, [searchResult?.climbs, pageNumber]);

  const handleRefresh = useCallback(() => {
    setAccumulatedClimbs([]);
    setPageNumber(1);
    refetch();
  }, [refetch]);

  const handleEndReached = useCallback(() => {
    if (hasMore && !isClimbsLoading && !isRefetching && !isLoadingMoreRef.current) {
      isLoadingMoreRef.current = true;
      setPageNumber((previous) => previous + 1);
    }
  }, [hasMore, isClimbsLoading, isRefetching]);

  const handleClimbPress = useCallback(
    (climb: Climb) => {
      router.push({
        pathname: '/(tabs)/climbs/[climbUuid]',
        params: {
          climbUuid: climb.uuid,
          boardName,
          layoutId: String(layoutId),
          sizeId: String(sizeId),
          setIds,
          angle: String(angle),
        },
      });
    },
    [router, boardName, layoutId, sizeId, setIds, angle],
  );

  const isInitialLoading = isBoardLoading || (isClimbsLoading && accumulatedClimbs.length === 0);

  const renderClimbItem = useCallback(
    ({ item: climb }: { item: Climb }) => {
      const gradeColor = getGradeColor(climb.difficulty) ?? DEFAULT_GRADE_COLOR;

      return (
        <ClimbListRow
          climb={climb}
          gradeName={climb.difficulty}
          gradeColor={gradeColor}
          onPress={() => handleClimbPress(climb)}
        />
      );
    },
    [handleClimbPress],
  );

  if (!hasBoardConfig && !isBoardLoading) {
    return (
      <View style={styles.emptyContainer}>
        <Icon name="boards" size={48} color={iosSystemColors.systemGray4} />
        <Text variant="headline" style={styles.emptyTitle}>
          {t('mobile.emptyState.noBoard.title')}
        </Text>
        <Text variant="subheadline" style={styles.emptySubtitle}>
          {t('mobile.emptyState.noBoard.subtitle')}
        </Text>
        <Button
          title={tAuth('nativeStart.prompt.climbsNoBoardCTA')}
          variant="filled"
          size="medium"
          icon="boards"
          onPress={() => router.navigate('/(tabs)/boards')}
          style={styles.emptyCTA}
        />
      </View>
    );
  }

  if (isInitialLoading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  const isEmpty = accumulatedClimbs.length === 0 && !isClimbsLoading;

  return (
    <View style={styles.container}>
      <FlashList
        data={accumulatedClimbs}
        renderItem={renderClimbItem}
        keyExtractor={keyExtractor}
        estimatedItemSize={68}
        onEndReached={handleEndReached}
        onEndReachedThreshold={0.5}
        contentInsetAdjustmentBehavior="automatic"
        refreshControl={
          <RefreshControl refreshing={isRefetching} onRefresh={handleRefresh} tintColor={brandColors.primary} />
        }
        ListFooterComponent={
          isClimbsLoading && accumulatedClimbs.length > 0 ? (
            <View style={styles.footer}>
              <ActivityIndicator size="small" />
            </View>
          ) : null
        }
        ListEmptyComponent={
          isEmpty ? (
            <View style={styles.emptyContainer}>
              <Icon name="search" size={48} color={iosSystemColors.systemGray4} />
              <Text variant="headline" style={styles.emptyTitle}>
                {debouncedSearch.length > 0
                  ? t('mobile.emptyState.noMatches.title')
                  : t('mobile.emptyState.noClimbs.title')}
              </Text>
              <Text variant="subheadline" style={styles.emptySubtitle}>
                {debouncedSearch.length > 0
                  ? t('mobile.emptyState.noMatches.description', { query: debouncedSearch })
                  : t('mobile.emptyState.noClimbs.subtitle')}
              </Text>
            </View>
          ) : null
        }
      />
      <ClimbFilterSheet
        visible={showFilters}
        onDismiss={handleDismissFilters}
        boardName={boardName}
        currentFilters={filters}
        onApply={handleApplyFilters}
      />
    </View>
  );
}

function keyExtractor(item: Climb) {
  return item.uuid;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  loadingContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 120,
    paddingHorizontal: 32,
    gap: 8,
  },
  emptyTitle: {
    marginTop: 12,
    opacity: 0.6,
  },
  emptySubtitle: {
    opacity: 0.4,
    textAlign: 'center',
  },
  footer: {
    paddingVertical: 20,
    alignItems: 'center',
  },
  emptyCTA: {
    marginTop: 16,
  },
});
