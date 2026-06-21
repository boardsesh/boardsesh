import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Pressable,
  RefreshControl,
  StyleSheet,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { FlashList, type FlashListRef } from '@shopify/flash-list';
import { useTranslation } from 'react-i18next';
import type { PublicUserProfile } from '@boardsesh/shared-schema';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { ActivityIndicator } from '../ActivityIndicator';
import { SegmentedControl } from '../SegmentedControl';
import {
  ClimberSearchEmptyState,
  ClimberSearchErrorState,
  ClimberSearchField,
  ClimberSearchPersonRow,
  mapSearchResults,
  useDebouncedClimberSearch,
  type SocialPerson,
} from './ClimberSearch';
import {
  useFollowers,
  useFollowing,
  usePublicProfile,
  useSearchUsers,
  useToggleUserFollow,
} from '../../lib/graphql/hooks';
import { useBottomChromeMetrics } from '../../hooks/use-bottom-chrome-metrics';
import { borderRadius, spacing } from '../../theme/tokens';
import { useTheme } from '../../providers/theme-provider';
import { ScreenTitle } from '../ScreenTitle';

type SocialMode = 'followers' | 'following' | 'search';

type SocialTabProps = {
  userId: string | undefined;
  onScroll?: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  topInset?: number;
  registerScrollToTop?: (scrollToTop: (() => void) | null) => void;
  /** In-body identity title (the own "You" tab passes "You"). Omitted when the
   *  surrounding screen supplies its own identity. */
  screenTitle?: string;
};

const EMPTY_PEOPLE: SocialPerson[] = [];

export function SocialTab({ userId, onScroll, topInset = 0, registerScrollToTop, screenTitle }: SocialTabProps) {
  const { t } = useTranslation('you');
  const { systemColors, brandColors } = useTheme();
  const bottomChrome = useBottomChromeMetrics();
  const paddingBottom = bottomChrome.scrollBottomPadding + spacing[4];

  const [mode, setMode] = useState<SocialMode>('followers');
  const [searchQuery, setSearchQuery] = useState('');
  const { trimmedSearchQuery, debouncedSearchQuery, searchIsDebouncing, canUseSearchQuery } =
    useDebouncedClimberSearch(searchQuery);

  const listRef = useRef<FlashListRef<SocialPerson>>(null);
  useEffect(() => {
    if (!registerScrollToTop) return;
    registerScrollToTop(() => listRef.current?.scrollToTop({ animated: true }));
    return () => registerScrollToTop(null);
  }, [listRef, registerScrollToTop]);

  const publicProfile = usePublicProfile(userId);
  const followers = useFollowers(userId, mode === 'followers');
  const following = useFollowing(userId, mode === 'following');
  const search = useSearchUsers(debouncedSearchQuery, mode === 'search' && canUseSearchQuery);
  const toggleFollow = useToggleUserFollow(userId);

  const followerCount = publicProfile.data?.followerCount ?? 0;
  const followingCount = publicProfile.data?.followingCount ?? 0;

  const people = useMemo<SocialPerson[]>(() => {
    if (mode === 'followers') {
      return followers.data?.pages.flatMap((page) => page.users) ?? EMPTY_PEOPLE;
    }

    if (mode === 'following') {
      return following.data?.pages.flatMap((page) => page.users) ?? EMPTY_PEOPLE;
    }

    return search.data?.pages.flatMap((page) => mapSearchResults(page.results)) ?? EMPTY_PEOPLE;
  }, [followers.data, following.data, mode, search.data]);

  const activeQuery = mode === 'followers' ? followers : mode === 'following' ? following : search;
  const showSearchHint = mode === 'search' && trimmedSearchQuery.length < 2;
  const canRefetchActiveQuery = mode !== 'search' || canUseSearchQuery;
  const isSearchDebouncing = mode === 'search' && searchIsDebouncing;
  const showInitialSpinner = isSearchDebouncing || (!showSearchHint && activeQuery.isPending && people.length === 0);
  const showError = !showSearchHint && !isSearchDebouncing && activeQuery.isError && people.length === 0;
  const isRefreshing = publicProfile.isRefetching || (canRefetchActiveQuery && activeQuery.isRefetching);

  const segmentOptions = useMemo(
    () => [
      { key: 'followers' as const, label: t('mobile.social.followers') },
      { key: 'following' as const, label: t('mobile.social.following') },
      { key: 'search' as const, label: t('mobile.social.findFriends') },
    ],
    [t],
  );

  const handleRefresh = useCallback(() => {
    void publicProfile.refetch();
    if (canRefetchActiveQuery) void activeQuery.refetch();
  }, [activeQuery, canRefetchActiveQuery, publicProfile]);

  const handleEndReached = useCallback(() => {
    if (canRefetchActiveQuery && activeQuery.hasNextPage && !activeQuery.isFetchingNextPage) {
      void activeQuery.fetchNextPage();
    }
  }, [activeQuery, canRefetchActiveQuery]);

  const handleToggleFollow = useCallback(
    (person: PublicUserProfile) => {
      if (person.id === userId) return;
      toggleFollow.mutate({ userId: person.id, isFollowedByMe: person.isFollowedByMe });
    },
    [toggleFollow, userId],
  );

  const renderItem = useCallback(
    ({ item }: { item: SocialPerson }) => {
      const isRowMutating = toggleFollow.isPending && toggleFollow.variables?.userId === item.id;

      return (
        <ClimberSearchPersonRow
          person={item}
          currentUserId={userId}
          isMutating={isRowMutating}
          onToggleFollow={handleToggleFollow}
        />
      );
    },
    [handleToggleFollow, toggleFollow.isPending, toggleFollow.variables?.userId, userId],
  );

  const header = useMemo(
    () => (
      <View>
        {screenTitle ? <ScreenTitle style={styles.screenTitle}>{screenTitle}</ScreenTitle> : null}

        <View style={styles.summaryRow}>
          <SocialStatCard
            label={t('mobile.social.followers')}
            value={followerCount}
            icon="people"
            active={mode === 'followers'}
            onPress={() => setMode('followers')}
          />
          <SocialStatCard
            label={t('mobile.social.following')}
            value={followingCount}
            icon="person.badge.plus"
            active={mode === 'following'}
            onPress={() => setMode('following')}
          />
        </View>

        <View style={styles.segmentWrap}>
          <SegmentedControl
            options={segmentOptions}
            selectedKey={mode}
            onSelect={setMode}
            trackColor={systemColors.fill}
            accessibilityLabel={t('mobile.social.title')}
          />
        </View>

        {mode === 'search' ? (
          <View style={styles.searchWrap}>
            <ClimberSearchField value={searchQuery} onChangeText={setSearchQuery} />
          </View>
        ) : null}
      </View>
    ),
    [followerCount, followingCount, mode, searchQuery, segmentOptions, systemColors.fill, t, screenTitle],
  );

  if (!userId) {
    return (
      <View style={[styles.centered, { paddingTop: topInset }]}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  return (
    <View style={styles.flex}>
      <FlashList
        ref={listRef}
        data={showInitialSpinner || showSearchHint || showError ? EMPTY_PEOPLE : people}
        renderItem={renderItem}
        keyExtractor={(person) => person.id}
        onScroll={onScroll}
        scrollEventThrottle={16}
        contentInsetAdjustmentBehavior="never"
        onEndReached={handleEndReached}
        onEndReachedThreshold={0.5}
        contentContainerStyle={{ paddingTop: topInset, paddingBottom }}
        scrollIndicatorInsets={{ top: topInset }}
        ListHeaderComponent={header}
        refreshControl={
          <RefreshControl refreshing={isRefreshing} onRefresh={handleRefresh} tintColor={brandColors.primary} />
        }
        ListEmptyComponent={
          showInitialSpinner ? (
            <View style={styles.stateBlock}>
              <ActivityIndicator size="large" />
            </View>
          ) : showError ? (
            <ClimberSearchErrorState onRetry={handleRefresh} />
          ) : mode === 'search' ? (
            <ClimberSearchEmptyState query={trimmedSearchQuery} />
          ) : (
            <SocialEmptyState mode={mode === 'followers' ? 'followers' : 'following'} />
          )
        }
        ListFooterComponent={
          activeQuery.isFetchingNextPage ? (
            <View style={styles.footer}>
              <ActivityIndicator size="small" />
            </View>
          ) : null
        }
      />
    </View>
  );
}

function SocialStatCard({
  label,
  value,
  icon,
  active,
  onPress,
}: {
  label: string;
  value: number;
  icon: 'people' | 'person.badge.plus';
  active: boolean;
  onPress: () => void;
}) {
  const { systemColors, brandColors } = useTheme();
  const color = active ? brandColors.primary : systemColors.secondaryLabel;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${value} ${label}`}
      style={({ pressed }) => [
        styles.statCard,
        {
          backgroundColor: systemColors.secondaryBackground,
          borderColor: active ? brandColors.primary : systemColors.separator,
        },
        pressed && { opacity: 0.75 },
      ]}
    >
      <Icon name={icon} size={20} color={color} />
      <Text variant="title3" style={styles.statValue}>
        {value.toLocaleString()}
      </Text>
      <Text variant="footnote" color={systemColors.secondaryLabel}>
        {label}
      </Text>
    </Pressable>
  );
}

function SocialEmptyState({ mode }: { mode: Exclude<SocialMode, 'search'> }) {
  const { t } = useTranslation('you');
  const { systemColors } = useTheme();

  const title = mode === 'followers' ? t('mobile.social.emptyFollowers') : t('mobile.social.emptyFollowing');

  return (
    <View style={styles.stateBlock}>
      <Icon name="people" size={48} color={systemColors.tertiaryLabel} />
      <Text variant="headline" style={styles.stateTitle}>
        {title}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  screenTitle: {
    paddingHorizontal: spacing[4],
    paddingTop: 0,
    paddingBottom: spacing[2],
  },
  summaryRow: {
    flexDirection: 'row',
    gap: spacing[3],
    paddingHorizontal: spacing[4],
    paddingTop: spacing[1],
  },
  statCard: {
    flex: 1,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: borderRadius.lg,
    padding: spacing[4],
    gap: spacing[1],
  },
  statValue: {
    fontWeight: '700',
  },
  segmentWrap: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[4],
    paddingBottom: spacing[2],
  },
  searchWrap: {
    paddingHorizontal: spacing[4],
    paddingBottom: spacing[2],
  },
  stateBlock: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: spacing[16],
    paddingHorizontal: spacing[8],
    gap: spacing[2],
  },
  stateTitle: {
    marginTop: spacing[3],
    opacity: 0.65,
    textAlign: 'center',
  },
  footer: {
    paddingVertical: spacing[5],
    alignItems: 'center',
  },
});
