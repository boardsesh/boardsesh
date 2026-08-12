import { useCallback, useEffect, useMemo } from 'react';
import { RefreshControl, StyleSheet, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useLocalSearchParams, useNavigation } from 'expo-router';
import { useTranslation } from 'react-i18next';
import type { PublicUserProfile } from '@boardsesh/shared-schema';
import { Text } from '../../src/components/Text';
import { Icon } from '../../src/components/Icon';
import { ActivityIndicator } from '../../src/components/ActivityIndicator';
import { OfflineState } from '../../src/components/OfflineState';
import { useOfflineQueryState } from '../../src/hooks/use-offline-query-state';
import {
  ClimberSearchErrorState,
  ClimberSearchPersonRow,
  type SocialPerson,
} from '../../src/components/you/ClimberSearch';
import { useFollowers, useFollowing, useProfile, useToggleUserFollow } from '../../src/lib/graphql/hooks';
import { useBottomChromeMetrics } from '../../src/hooks/use-bottom-chrome-metrics';
import { useTheme } from '../../src/providers/theme-provider';
import { spacing } from '../../src/theme/tokens';

const EMPTY_PEOPLE: SocialPerson[] = [];

type ConnectionsMode = 'followers' | 'following';

export default function ConnectionsScreen() {
  const params = useLocalSearchParams<{ userId: string; mode?: string }>();
  const userId = params.userId;
  const mode: ConnectionsMode = params.mode === 'following' ? 'following' : 'followers';

  const { t } = useTranslation('you');
  const { systemColors, brandColors } = useTheme();
  const navigation = useNavigation();
  const bottomChrome = useBottomChromeMetrics();
  const paddingBottom = bottomChrome.scrollBottomPadding + spacing[4];

  const { data: currentProfile } = useProfile();
  const currentUserId = currentProfile?.id;

  const followers = useFollowers(userId, mode === 'followers');
  const following = useFollowing(userId, mode === 'following');
  const activeQuery = mode === 'followers' ? followers : following;
  const toggleFollow = useToggleUserFollow(currentUserId);

  const people = useMemo<SocialPerson[]>(
    () => activeQuery.data?.pages.flatMap((page) => page.users) ?? EMPTY_PEOPLE,
    [activeQuery.data],
  );

  useEffect(() => {
    navigation.setOptions({
      headerShown: true,
      title: mode === 'followers' ? t('mobile.social.followers') : t('mobile.social.following'),
    });
  }, [navigation, mode, t]);

  const handleToggleFollow = useCallback(
    (person: PublicUserProfile) => {
      if (person.id === currentUserId) return;
      toggleFollow.mutate({ userId: person.id, isFollowedByMe: person.isFollowedByMe });
    },
    [currentUserId, toggleFollow],
  );

  const handleEndReached = useCallback(() => {
    if (activeQuery.hasNextPage && !activeQuery.isFetchingNextPage) void activeQuery.fetchNextPage();
  }, [activeQuery]);

  const renderItem = useCallback(
    ({ item }: { item: SocialPerson }) => {
      const isRowMutating = toggleFollow.isPending && toggleFollow.variables?.userId === item.id;
      return (
        <ClimberSearchPersonRow
          person={item}
          currentUserId={currentUserId}
          isMutating={isRowMutating}
          onToggleFollow={handleToggleFollow}
        />
      );
    },
    [currentUserId, handleToggleFollow, toggleFollow.isPending, toggleFollow.variables?.userId],
  );

  // Followers/following are network-only. An offline fetch pauses instead of
  // failing, so `isPending` never clears and neither branch below fires.
  const offline = useOfflineQueryState(activeQuery);
  const showOffline = offline.isBlocked && people.length === 0;
  const showSpinner = !showOffline && activeQuery.isPending && people.length === 0;
  const showError = !showOffline && activeQuery.isError && people.length === 0;

  return (
    <View style={[styles.flex, { backgroundColor: systemColors.background }]}>
      <FlashList
        data={showSpinner || showError || showOffline ? EMPTY_PEOPLE : people}
        renderItem={renderItem}
        keyExtractor={(person) => person.id}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingBottom }}
        onEndReached={handleEndReached}
        onEndReachedThreshold={0.5}
        ListEmptyComponent={
          showOffline && offline.reason ? (
            <OfflineState reason={offline.reason} onRetry={() => void activeQuery.refetch()} />
          ) : showSpinner ? (
            <View style={styles.stateBlock}>
              <ActivityIndicator size="large" />
            </View>
          ) : showError ? (
            <ClimberSearchErrorState onRetry={() => void activeQuery.refetch()} />
          ) : (
            <View style={styles.stateBlock}>
              <Icon name="people" size={48} color={systemColors.tertiaryLabel} />
              <Text variant="headline" style={styles.stateTitle}>
                {mode === 'followers' ? t('mobile.social.emptyFollowers') : t('mobile.social.emptyFollowing')}
              </Text>
            </View>
          )
        }
        ListFooterComponent={
          activeQuery.isFetchingNextPage ? (
            <View style={styles.footer}>
              <ActivityIndicator size="small" />
            </View>
          ) : null
        }
        refreshControl={
          <RefreshControl
            refreshing={activeQuery.isRefetching}
            onRefresh={() => void activeQuery.refetch()}
            tintColor={brandColors.primary}
          />
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
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
