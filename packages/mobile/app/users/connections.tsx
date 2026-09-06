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
// By path, not the hooks barrel: `use-notifications` reaches expo-secure-store
// for its auth gate, and the barrel is imported by suites that mock only the
// GraphQL client (see the note at the barrel's re-export list).
import { useNotificationActors } from '../../src/lib/graphql/hooks/use-notifications';
import { useBottomChromeMetrics } from '../../src/hooks/use-bottom-chrome-metrics';
import { useTheme } from '../../src/providers/theme-provider';
import { spacing } from '../../src/theme/tokens';

const EMPTY_PEOPLE: SocialPerson[] = [];

/**
 * Per-mode copy, as literal `t` calls. The i18n linter hard-fails `t(variable)`,
 * so the key can't be built from `mode` — a lookup of thunks keeps each literal
 * statically visible to `check:i18n:orphans`.
 */
type Translate = (key: string) => string;
const MODE_TITLE_KEYS: Record<ConnectionsMode, (t: Translate) => string> = {
  followers: (t) => t('mobile.social.followers'),
  following: (t) => t('mobile.social.following'),
  newFollowers: (t) => t('mobile.social.newFollowers'),
};
const MODE_EMPTY_KEYS: Record<ConnectionsMode, (t: Translate) => string> = {
  followers: (t) => t('mobile.social.emptyFollowers'),
  following: (t) => t('mobile.social.emptyFollowing'),
  newFollowers: (t) => t('mobile.social.emptyNewFollowers'),
};

/**
 * `newFollowers` is the follow-back list behind a grouped "new follower"
 * notification. It ignores `userId` — the actors come from the caller's own
 * notifications — but shares every other line with the other two modes, which
 * is why it lives here rather than in a route of its own.
 */
type ConnectionsMode = 'followers' | 'following' | 'newFollowers';

function toConnectionsMode(mode: string | undefined): ConnectionsMode {
  if (mode === 'following') return 'following';
  if (mode === 'newFollowers') return 'newFollowers';
  return 'followers';
}

export default function ConnectionsScreen() {
  const params = useLocalSearchParams<{ userId: string; mode?: string }>();
  const userId = params.userId;
  const mode = toConnectionsMode(params.mode);

  const { t } = useTranslation('you');
  const { systemColors, brandColors } = useTheme();
  const navigation = useNavigation();
  const bottomChrome = useBottomChromeMetrics();
  const paddingBottom = bottomChrome.scrollBottomPadding + spacing[4];

  const { data: currentProfile } = useProfile();
  const currentUserId = currentProfile?.id;

  const followers = useFollowers(userId, mode === 'followers');
  const following = useFollowing(userId, mode === 'following');
  // `new_follower` notifications carry no entity type, and their entity id is
  // the recipient's own — so the group key is the type alone.
  const newFollowers = useNotificationActors('new_follower', null, null, mode === 'newFollowers');
  // All three return a FollowConnection page, which is what lets one list, one
  // renderItem and one set of placards serve every mode.
  const activeQuery = mode === 'followers' ? followers : mode === 'following' ? following : newFollowers;
  const toggleFollow = useToggleUserFollow(currentUserId);

  const people = useMemo<SocialPerson[]>(
    () => activeQuery.data?.pages.flatMap((page) => page.users) ?? EMPTY_PEOPLE,
    [activeQuery.data],
  );

  useEffect(() => {
    navigation.setOptions({
      headerShown: true,
      title: MODE_TITLE_KEYS[mode](t),
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
                {MODE_EMPTY_KEYS[mode](t)}
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
