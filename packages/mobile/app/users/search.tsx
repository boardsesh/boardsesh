import { ReadableColumn } from '../../src/components/ReadableColumn';
import { useCallback, useMemo, useRef, useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { Stack, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import type { PublicUserProfile } from '@boardsesh/shared-schema';
import { ActivityIndicator } from '../../src/components/ActivityIndicator';
import { OfflineState } from '../../src/components/OfflineState';
import { SearchField } from '../../src/components/SearchField';
import { useOfflineQueryState } from '../../src/hooks/use-offline-query-state';
import {
  ClimberSearchEmptyState,
  ClimberSearchErrorState,
  ClimberSearchLoadingState,
  ClimberSearchPersonRow,
  mapSearchResults,
  useDebouncedClimberSearch,
  type SocialPerson,
} from '../../src/components/you/ClimberSearch';
import { useProfile, useSearchUsers, useToggleUserFollow } from '../../src/lib/graphql/hooks';
import { useTheme } from '../../src/providers/theme-provider';
import { spacing } from '../../src/theme/tokens';

const EMPTY_PEOPLE: SocialPerson[] = [];

export default function ClimberSearchScreen() {
  const { t } = useTranslation('you');
  const { systemColors } = useTheme();
  const insets = useSafeAreaInsets();
  const paddingBottom = insets.bottom + spacing[4];

  const inputRef = useRef<TextInput>(null);
  const { data: currentProfile } = useProfile();
  const currentUserId = currentProfile?.id;

  const [searchQuery, setSearchQuery] = useState('');
  const { trimmedSearchQuery, debouncedSearchQuery, searchIsDebouncing, canUseSearchQuery } =
    useDebouncedClimberSearch(searchQuery);

  const search = useSearchUsers(debouncedSearchQuery, canUseSearchQuery);
  const toggleFollow = useToggleUserFollow(currentUserId);

  // Focus the field once the push has finished — autoFocus alone races the
  // transition and the keyboard can fail to appear.
  useFocusEffect(
    useCallback(() => {
      const handle = setTimeout(() => inputRef.current?.focus(), 350);
      return () => clearTimeout(handle);
    }, []),
  );

  const people = useMemo(
    () => search.data?.pages.flatMap((page) => mapSearchResults(page.results)) ?? EMPTY_PEOPLE,
    [search.data],
  );

  const handleToggleFollow = useCallback(
    (person: PublicUserProfile) => {
      if (person.id === currentUserId) return;
      toggleFollow.mutate({ userId: person.id, isFollowedByMe: person.isFollowedByMe });
    },
    [currentUserId, toggleFollow],
  );

  const handleEndReached = useCallback(() => {
    if (canUseSearchQuery && search.hasNextPage && !search.isFetchingNextPage) void search.fetchNextPage();
  }, [canUseSearchQuery, search]);

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

  const showHint = trimmedSearchQuery.length < 2;
  // Climber search is network-only. Offline the fetch pauses instead of failing,
  // so without this it would sit on the loading state for good.
  const offline = useOfflineQueryState(search);
  const showOffline = !showHint && !searchIsDebouncing && offline.isBlocked && people.length === 0;
  const showInitialSpinner =
    !showOffline && !showHint && (searchIsDebouncing || (search.isPending && people.length === 0));
  const showError = !showOffline && !showHint && !searchIsDebouncing && search.isError && people.length === 0;
  const visiblePeople = showInitialSpinner || showHint || showError || showOffline ? EMPTY_PEOPLE : people;

  return (
    <View style={[styles.flex, { backgroundColor: systemColors.background }]}>
      {/* A push over the tabs (the root stack), so it takes the NATIVE header
          (HIG Navigation bars): the system back button keeps its long-press
          history menu and the edge swipe, which the old in-body Cancel could
          not. Opaque, so the search field lays out below the bar. */}
      <Stack.Screen
        options={{
          headerShown: true,
          headerTransparent: false,
          headerBlurEffect: undefined,
          title: t('mobile.social.searchTitle'),
        }}
      />

      <ReadableColumn style={styles.readableViewport}>
        <View style={styles.searchRow}>
          <SearchField
            ref={inputRef}
            value={searchQuery}
            onChangeText={setSearchQuery}
            placeholder={t('mobile.social.searchPlaceholder')}
            clearAccessibilityLabel={t('mobile.social.clearSearch')}
            autoFocus
          />
        </View>

        <FlashList
          data={visiblePeople}
          renderItem={renderItem}
          keyExtractor={(person) => person.id}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          contentContainerStyle={{ paddingBottom }}
          onEndReached={handleEndReached}
          onEndReachedThreshold={0.5}
          ListEmptyComponent={
            showOffline && offline.reason ? (
              <OfflineState reason={offline.reason} onRetry={() => void search.refetch()} />
            ) : showInitialSpinner ? (
              <ClimberSearchLoadingState />
            ) : showError ? (
              <ClimberSearchErrorState onRetry={() => void search.refetch()} />
            ) : (
              <ClimberSearchEmptyState query={trimmedSearchQuery} />
            )
          }
          ListFooterComponent={
            search.isFetchingNextPage ? (
              <View style={styles.footer}>
                <ActivityIndicator size="small" />
              </View>
            ) : null
          }
        />
      </ReadableColumn>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  readableViewport: { flex: 1, minHeight: 0, minWidth: 0 },
  searchRow: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[2],
    paddingBottom: spacing[2],
  },
  footer: {
    paddingVertical: spacing[5],
    alignItems: 'center',
  },
});
