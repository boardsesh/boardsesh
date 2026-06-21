import { useCallback, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import type { PublicUserProfile } from '@boardsesh/shared-schema';
import { Text } from '../../src/components/Text';
import { ActivityIndicator } from '../../src/components/ActivityIndicator';
import {
  ClimberSearchEmptyState,
  ClimberSearchErrorState,
  ClimberSearchField,
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
  const { t: tCommon } = useTranslation('common');
  const { systemColors, brandColors } = useTheme();
  const router = useRouter();
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

  // Focus the field once the modal has finished presenting — autoFocus alone
  // races the slide-up and the keyboard can fail to appear.
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
  const showInitialSpinner = !showHint && (searchIsDebouncing || (search.isPending && people.length === 0));
  const showError = !showHint && !searchIsDebouncing && search.isError && people.length === 0;
  const visiblePeople = showInitialSpinner || showHint || showError ? EMPTY_PEOPLE : people;

  return (
    <View style={[styles.flex, { backgroundColor: systemColors.background, paddingTop: insets.top }]}>
      {/* Full-screen takeover (presented modally in the root stack) so the tab bar
          is out of the way; we render our own search bar + Cancel instead of the
          native header. */}
      <Stack.Screen options={{ headerShown: false }} />

      <View style={styles.searchRow}>
        <View style={styles.searchFieldWrap}>
          <ClimberSearchField ref={inputRef} value={searchQuery} onChangeText={setSearchQuery} autoFocus />
        </View>
        <Pressable
          onPress={() => router.back()}
          accessibilityRole="button"
          hitSlop={8}
          style={({ pressed }) => [styles.cancelButton, pressed && styles.cancelPressed]}
        >
          <Text variant="body" color={brandColors.primary}>
            {tCommon('actions.cancel')}
          </Text>
        </Pressable>
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
          showInitialSpinner ? (
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
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    paddingHorizontal: spacing[4],
    paddingTop: spacing[2],
    paddingBottom: spacing[2],
  },
  searchFieldWrap: {
    flex: 1,
  },
  cancelButton: {
    minHeight: 44,
    justifyContent: 'center',
    paddingLeft: spacing[1],
  },
  cancelPressed: {
    opacity: 0.6,
  },
  footer: {
    paddingVertical: spacing[5],
    alignItems: 'center',
  },
});
