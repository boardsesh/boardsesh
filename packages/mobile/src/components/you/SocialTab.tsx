import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Pressable,
  RefreshControl,
  StyleSheet,
  TextInput,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { FlashList, type FlashListRef } from '@shopify/flash-list';
import { useTranslation } from 'react-i18next';
import type { PublicUserProfile, UserSearchResult } from '@boardsesh/shared-schema';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { Avatar } from '../Avatar';
import { ListRow } from '../ListRow';
import { Button } from '../Button';
import { ActivityIndicator } from '../ActivityIndicator';
import { SegmentedControl } from '../SegmentedControl';
import {
  useFollowers,
  useFollowing,
  usePublicProfile,
  useSearchUsers,
  useToggleUserFollow,
} from '../../lib/graphql/hooks';
import { useBottomChromeMetrics } from '../../hooks/use-bottom-chrome-metrics';
import { iosSystemColors } from '../../theme/ios-colors';
import { borderRadius, spacing } from '../../theme/tokens';
import { useTheme } from '../../providers/theme-provider';

type SocialMode = 'followers' | 'following' | 'search';

type SocialPerson = PublicUserProfile & {
  recentAscentCount?: number;
};

type SocialTabProps = {
  userId: string | undefined;
  onScroll?: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  topInset?: number;
  registerScrollToTop?: (scrollToTop: (() => void) | null) => void;
};

const EMPTY_PEOPLE: SocialPerson[] = [];

export function SocialTab({ userId, onScroll, topInset = 0, registerScrollToTop }: SocialTabProps) {
  const { t } = useTranslation('you');
  const { systemColors, brandColors, variant } = useTheme();
  const bottomChrome = useBottomChromeMetrics();
  const paddingBottom = bottomChrome.scrollBottomPadding + spacing[4];

  const [mode, setMode] = useState<SocialMode>('followers');
  const [searchQuery, setSearchQuery] = useState('');
  const trimmedSearchQuery = searchQuery.trim();

  const listRef = useRef<FlashListRef<SocialPerson>>(null);
  useEffect(() => {
    if (!registerScrollToTop) return;
    registerScrollToTop(() => listRef.current?.scrollToTop({ animated: true }));
    return () => registerScrollToTop(null);
  }, [listRef, registerScrollToTop]);

  const publicProfile = usePublicProfile(userId);
  const followers = useFollowers(userId, mode === 'followers');
  const following = useFollowing(userId, mode === 'following');
  const search = useSearchUsers(trimmedSearchQuery, mode === 'search');
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

    return (
      search.data?.pages.flatMap((page) =>
        page.results.map((result: UserSearchResult) => ({
          ...result.user,
          recentAscentCount: result.recentAscentCount,
        })),
      ) ?? EMPTY_PEOPLE
    );
  }, [followers.data, following.data, mode, search.data]);

  const activeQuery = mode === 'followers' ? followers : mode === 'following' ? following : search;
  const showSearchHint = mode === 'search' && trimmedSearchQuery.length < 2;
  const showInitialSpinner = !showSearchHint && activeQuery.isPending && people.length === 0;
  const isRefreshing = publicProfile.isRefetching || activeQuery.isRefetching;

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
    void activeQuery.refetch();
  }, [activeQuery, publicProfile]);

  const handleEndReached = useCallback(() => {
    if (activeQuery.hasNextPage && !activeQuery.isFetchingNextPage) void activeQuery.fetchNextPage();
  }, [activeQuery]);

  const handleToggleFollow = useCallback(
    (person: PublicUserProfile) => {
      if (person.id === userId) return;
      toggleFollow.mutate({ userId: person.id, isFollowedByMe: person.isFollowedByMe });
    },
    [toggleFollow, userId],
  );

  const renderItem = useCallback(
    ({ item }: { item: SocialPerson }) => {
      const isCurrentUser = item.id === userId;
      const isRowMutating = toggleFollow.isPending && toggleFollow.variables?.userId === item.id;

      return (
        <ListRow
          title={item.displayName || t('mobile.unknownName')}
          subtitle={personSubtitle(item, t)}
          leading={<Avatar uri={item.avatarUrl} name={item.displayName} size={36} />}
          trailing={
            isCurrentUser ? (
              <Text variant="footnote" color={systemColors.secondaryLabel}>
                {t('mobile.social.you')}
              </Text>
            ) : (
              <Button
                title={item.isFollowedByMe ? t('mobile.social.followingAction') : t('mobile.social.followAction')}
                size="small"
                variant={item.isFollowedByMe ? 'outlined' : 'filled'}
                loading={isRowMutating}
                disabled={isRowMutating}
                onPress={() => handleToggleFollow(item)}
              />
            )
          }
        />
      );
    },
    [
      handleToggleFollow,
      systemColors.secondaryLabel,
      t,
      toggleFollow.isPending,
      toggleFollow.variables?.userId,
      userId,
    ],
  );

  const header = useMemo(
    () => (
      <View>
        {variant === 'material' ? null : (
          <Text variant="largeTitle" style={styles.screenTitle}>
            {t('metadata.dashboard.title')}
          </Text>
        )}

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
            <View style={[styles.searchField, { backgroundColor: systemColors.fill }]}>
              <Icon name="search" size={18} color={systemColors.secondaryLabel} />
              <TextInput
                value={searchQuery}
                onChangeText={setSearchQuery}
                placeholder={t('mobile.social.searchPlaceholder')}
                placeholderTextColor={iosSystemColors.systemGray}
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="search"
                accessibilityLabel={t('mobile.social.searchPlaceholder')}
                style={[styles.searchInput, { color: systemColors.label }]}
              />
              {searchQuery.length > 0 ? (
                <Pressable
                  onPress={() => setSearchQuery('')}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel={t('mobile.social.clearSearch')}
                >
                  <Icon name="close" size={16} color={systemColors.secondaryLabel} />
                </Pressable>
              ) : null}
            </View>
          </View>
        ) : null}
      </View>
    ),
    [
      followerCount,
      followingCount,
      mode,
      searchQuery,
      segmentOptions,
      systemColors.fill,
      systemColors.label,
      systemColors.secondaryLabel,
      t,
      variant,
    ],
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
        data={showInitialSpinner || showSearchHint ? EMPTY_PEOPLE : people}
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
          ) : (
            <SocialEmptyState mode={mode} query={trimmedSearchQuery} />
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

function personSubtitle(person: SocialPerson, t: (key: string, options?: Record<string, unknown>) => string) {
  if (person.recentAscentCount != null) {
    return t('mobile.social.recentAscents', { count: person.recentAscentCount });
  }

  return [
    t('mobile.social.followerCount', { count: person.followerCount }),
    t('mobile.social.followingCount', { count: person.followingCount }),
  ].join(' · ');
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

function SocialEmptyState({ mode, query }: { mode: SocialMode; query: string }) {
  const { t } = useTranslation('you');
  const { systemColors } = useTheme();

  const title =
    mode === 'followers'
      ? t('mobile.social.emptyFollowers')
      : mode === 'following'
        ? t('mobile.social.emptyFollowing')
        : query.length < 2
          ? t('mobile.social.searchHint')
          : t('mobile.social.emptySearch');

  return (
    <View style={styles.stateBlock}>
      <Icon name={mode === 'search' ? 'search' : 'people'} size={48} color={systemColors.tertiaryLabel} />
      <Text variant="headline" style={styles.stateTitle}>
        {title}
      </Text>
      {mode === 'search' && query.length >= 2 ? (
        <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.stateSubtitle}>
          {t('mobile.social.emptySearchBody', { query })}
        </Text>
      ) : null}
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
  searchField: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    minHeight: 42,
    borderRadius: 10,
    paddingHorizontal: spacing[3],
  },
  searchInput: {
    flex: 1,
    fontSize: 17,
    paddingVertical: 0,
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
  stateSubtitle: {
    textAlign: 'center',
  },
  footer: {
    paddingVertical: spacing[5],
    alignItems: 'center',
  },
});
