import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Pressable, StyleSheet, TextInput, KeyboardAvoidingView, Platform } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { BoardName, ClimbSearchInput } from '@boardsesh/shared-schema';
import { Text } from '../../../src/components/Text';
import { ActivityIndicator } from '../../../src/components/ActivityIndicator';
import { Button } from '../../../src/components/Button';
import { Icon } from '../../../src/components/Icon';
import { useTheme } from '../../../src/providers/theme-provider';
import { useSearchClimbsCount, useSetterStats } from '../../../src/lib/graphql/hooks';
import { withSetterSelection } from '../../../src/lib/climb-count-preview-input';
import { emitSetterFilterSelection } from '../../../src/lib/setter-filter-handoff';
import { hapticSelection } from '../../../src/lib/haptics';
import { textStyles } from '../../../src/theme/typography';
import { spacing, borderRadius } from '../../../src/theme/tokens';
import { useAuth } from '../../../src/providers/auth-provider';
import { useFollowedAuthors, useToggleAuthorFollow } from '../../../src/lib/graphql/hooks/use-followed-authors';

const SEARCH_DEBOUNCE_MS = 250;

// Stand-in input for the disabled count query when the route carries no usable
// `countInput` param (the query never runs with it).
const EMPTY_COUNT_INPUT: ClimbSearchInput = { boardName: '', layoutId: 0, sizeId: 0, setIds: '', angle: 0 };

type Params = {
  boardName?: string;
  layoutId?: string;
  sizeId?: string;
  setIds?: string;
  angle?: string;
  setters?: string;
  /** The filter sheet's count input (JSON) for its draft at push time. */
  countInput?: string;
};

type SetterStat = { setterUsername: string; climbCount: number };
const setterKey = (setter: SetterStat) => setter.setterUsername;

// Defensive parse of the serialized selection param: a malformed value falls back
// to an empty selection rather than crashing the route.
function parseSelectedSetters(serialized: string | undefined): string[] {
  if (!serialized) return [];
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is string => typeof value === 'string');
  } catch {
    return [];
  }
}

// Defensive parse of the count-input param. Anything missing the board fields a
// search needs falls back to null, and the footer shows the plain Apply label.
function parseCountInput(serialized: string | undefined): ClimbSearchInput | null {
  if (!serialized) return null;
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const candidate = parsed as Record<string, unknown>;
    if (typeof candidate.boardName !== 'string' || candidate.boardName.length === 0) return null;
    if (typeof candidate.layoutId !== 'number' || typeof candidate.sizeId !== 'number') return null;
    if (typeof candidate.setIds !== 'string' || typeof candidate.angle !== 'number') return null;
    return candidate as unknown as ClimbSearchInput;
  } catch {
    return null;
  }
}

const SetterSeparator = memo(function SetterSeparator() {
  const { systemColors } = useTheme();
  return <View style={[styles.separator, { backgroundColor: systemColors.separator }]} />;
});

type SetterRowProps = {
  setter: SetterStat;
  isSelected: boolean;
  onToggle: (username: string) => void;
  onOpen: (username: string) => void;
  onFollow: (username: string, follow: boolean) => void;
  following: boolean;
  canFollow: boolean;
  followPending: boolean;
};

const SetterRow = memo(function SetterRow({
  setter,
  isSelected,
  onToggle,
  onOpen,
  onFollow,
  following,
  canFollow,
  followPending,
}: SetterRowProps) {
  const { t } = useTranslation('climbs');
  const { brandColors } = useTheme();
  return (
    <View style={styles.row}>
      <Pressable
        onPress={() => onToggle(setter.setterUsername)}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: isSelected }}
        accessibilityLabel={setter.setterUsername}
        hitSlop={12}
      >
        <Icon name={isSelected ? 'check.small' : 'add'} size={24} color={brandColors.primary} />
      </Pressable>
      <Pressable style={styles.rowText} onPress={() => onOpen(setter.setterUsername)} accessibilityRole="button">
        <Text variant="body">{setter.setterUsername}</Text>
        <Text variant="footnote" style={styles.count}>
          {t('mobile.search.climbsCount', { count: setter.climbCount })}
        </Text>
      </Pressable>
      {canFollow ? (
        <Pressable
          disabled={followPending}
          accessibilityState={{ disabled: followPending, busy: followPending }}
          onPress={() => onFollow(setter.setterUsername, !following)}
          accessibilityRole="button"
          hitSlop={8}
        >
          <Text variant="footnote" color={brandColors.primary}>
            {following ? t('authors.unfollow') : t('authors.follow')}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
});

/**
 * Full-screen route variant for the setter search filter. The climb filter sheet
 * suspends and pushes this route. Two ways out:
 * - The pinned "Show N climbs" button hands the selection back with
 *   `apply: true`; the sheet applies it and closes, landing on the results.
 * - The back chevron or swipe-back hands the selection back on blur, and the
 *   sheet merges it into its draft and re-presents.
 * A pushed route is used (not a stacked sheet) because native sheets can't stack
 * above the filter sheet — see docs/mobile-sheets-vs-routes.md.
 */
export default function SettersFilterScreen() {
  const params = useLocalSearchParams<Params>();
  const navigation = useNavigation();
  const router = useRouter();
  const { isAuthenticated } = useAuth();
  const follows = useFollowedAuthors();
  const followMutation = useToggleAuthorFollow();
  const pendingSettersRef = useRef(new Set<string>());
  const [pendingSetters, setPendingSetters] = useState<ReadonlySet<string>>(new Set());
  const [followError, setFollowError] = useState(false);
  const [followingOnly, setFollowingOnly] = useState(false);
  const { t } = useTranslation('climbs');
  const { systemColors, brandColors } = useTheme();
  const insets = useSafeAreaInsets();

  const boardName = (params.boardName ?? '') as BoardName;
  const layoutId = Number(params.layoutId ?? 0);
  const sizeId = Number(params.sizeId ?? 0);
  const setIds = params.setIds ?? '';
  const angle = Number(params.angle ?? 0);

  const [selectedSetters, setSelectedSetters] = useState<string[]>(() => parseSelectedSetters(params.setters));
  // Mirror of the latest selection so the focus-effect cleanup hands back the
  // current value without re-subscribing on every toggle.
  const selectedSettersRef = useRef(selectedSetters);
  selectedSettersRef.current = selectedSetters;
  // Set once the footer button has handed the selection back with `apply`, so
  // the blur cleanup that follows the pop doesn't hand it back a second time.
  const appliedRef = useRef(false);

  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The screen sits below an opaque native header, and KeyboardAvoidingView
  // measures its frame relative to its parent, so on its own it under-pads by
  // the header height. Measuring this screen's top in the window lets the offset
  // below put the footer just above the keyboard.
  const rootRef = useRef<View>(null);
  const [windowTop, setWindowTop] = useState(0);
  const handleRootLayout = useCallback(() => {
    rootRef.current?.measureInWindow((_windowX, windowY) => setWindowTop(windowY));
  }, []);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  // Only removing the picker hands its draft back. Pushing a setter playlist
  // must not re-present the underlying filter sheet over that playlist.
  useEffect(
    () =>
      navigation.addListener('beforeRemove', () => {
        if (appliedRef.current) return;
        emitSetterFilterSelection(selectedSettersRef.current);
      }),
    [navigation],
  );

  const selectedSet = useMemo(() => new Set(selectedSetters), [selectedSetters]);
  // Mirror the Set for O(1) per-row lookups without re-creating renderRow on every
  // selection change (the FlashList re-renders via extraData instead).
  const selectedSetRef = useRef(selectedSet);
  selectedSetRef.current = selectedSet;

  const handleSearchChange = useCallback((text: string) => {
    setSearchInput(text);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setDebouncedSearch(text), SEARCH_DEBOUNCE_MS);
  }, []);

  const queryInput = useMemo(
    () => ({
      boardName,
      layoutId,
      sizeId,
      setIds,
      angle,
      onlyFollowedAuthors: (followingOnly && isAuthenticated) || undefined,
      ...(debouncedSearch.length > 0 ? { search: debouncedSearch } : {}),
    }),
    [boardName, layoutId, sizeId, setIds, angle, debouncedSearch, followingOnly, isAuthenticated],
  );

  const { data: setters, isLoading, isError, refetch } = useSetterStats(queryInput, boardName.length > 0);

  // Live "Show N climbs" count: the sheet's draft with this screen's picks swapped
  // in. Built with the same helper as the sheet's own count, so returning to the
  // sheet reads this result from the cache. No debounce: toggles are single taps.
  const baseCountInput = useMemo(() => parseCountInput(params.countInput), [params.countInput]);
  const countInput = useMemo(
    () => (baseCountInput ? withSetterSelection(baseCountInput, selectedSetters) : null),
    [baseCountInput, selectedSetters],
  );
  const { data: previewCount, isPlaceholderData: isCountForPreviousPicks } = useSearchClimbsCount(
    countInput ?? EMPTY_COUNT_INPUT,
    countInput != null,
  );
  // The count hook holds the previous number while a new one loads. That number
  // belongs to the previous picks, so show plain "Apply" until the real one lands.
  const applyLabel =
    previewCount != null && !isCountForPreviousPicks
      ? t('mobile.filter.showCount', { count: previewCount })
      : t('mobile.filter.apply');

  const toggle = useCallback((username: string) => {
    hapticSelection();
    setSelectedSetters((previous) => {
      const next = new Set(previous);
      if (next.has(username)) {
        next.delete(username);
      } else {
        next.add(username);
      }
      return Array.from(next);
    });
  }, []);

  const clear = useCallback(() => {
    hapticSelection();
    setSelectedSetters([]);
  }, []);

  // Apply straight from here: the sheet applies its draft with these picks and
  // closes, then the pop lands on the results. A second tap during the pop is
  // ignored.
  const handleApply = useCallback(() => {
    if (appliedRef.current) return;
    appliedRef.current = true;
    emitSetterFilterSelection(selectedSettersRef.current, { apply: true });
    navigation.goBack();
  }, [navigation]);

  // "Clear all" lives in the native header's headerRight, shown only when setters
  // are selected. The footer button applies; the back chevron / swipe-back keeps
  // the picks as a draft (handed back on blur via the focus-cleanup above).
  useEffect(() => {
    navigation.setOptions({
      headerRight:
        selectedSet.size > 0
          ? () => (
              <Pressable onPress={clear} hitSlop={8} accessibilityRole="button">
                <Text variant="subheadline" color={brandColors.primary}>
                  {t('mobile.filter.clearAll')}
                </Text>
              </Pressable>
            )
          : undefined,
    });
  }, [navigation, selectedSet.size, clear, brandColors.primary, t]);

  const openSetter = useCallback(
    (username: string) => {
      router.push({ pathname: '/(tabs)/climbs/setter/[username]', params: { username } });
    },
    [router],
  );
  const followSetter = useCallback(
    (username: string, follow: boolean) => {
      if (pendingSettersRef.current.has(username)) return;
      pendingSettersRef.current.add(username);
      setPendingSetters(new Set(pendingSettersRef.current));
      setFollowError(false);
      void followMutation
        .mutateAsync({ kind: 'setter', identifier: username, follow })
        .catch(() => setFollowError(true))
        .finally(() => {
          pendingSettersRef.current.delete(username);
          setPendingSetters(new Set(pendingSettersRef.current));
        });
    },
    [followMutation.mutateAsync],
  );
  const renderRow = useCallback(
    ({ item }: { item: SetterStat }) => (
      <SetterRow
        setter={item}
        isSelected={selectedSetRef.current.has(item.setterUsername)}
        onToggle={toggle}
        onOpen={openSetter}
        onFollow={followSetter}
        following={follows.setterNames.has(item.setterUsername)}
        canFollow={isAuthenticated && !!follows.data}
        followPending={pendingSetters.has(item.setterUsername)}
      />
    ),
    [toggle, openSetter, followSetter, follows.setterNames, follows.data, isAuthenticated, pendingSetters],
  );

  return (
    <View
      ref={rootRef}
      onLayout={handleRootLayout}
      style={[styles.container, { backgroundColor: systemColors.background }]}
    >
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        // The footer already pads by insets.bottom, which the keyboard covers, so
        // take it back off the offset: the button then rests spacing[3] above it.
        keyboardVerticalOffset={windowTop - insets.bottom}
      >
        <View style={[styles.searchBarWrapper, { backgroundColor: systemColors.secondaryBackground }]}>
          <Icon name="search" size={16} color={systemColors.secondaryLabel} />
          <TextInput
            value={searchInput}
            onChangeText={handleSearchChange}
            placeholder={t('mobile.filter.searchSetters')}
            placeholderTextColor={systemColors.secondaryLabel}
            accessibilityLabel={t('mobile.filter.searchSetters')}
            autoCorrect={false}
            autoCapitalize="none"
            returnKeyType="search"
            style={[styles.searchInput, { color: systemColors.label }]}
          />
        </View>

        {isAuthenticated ? (
          <View style={styles.selectionBar}>
            <Button
              title={followingOnly ? t('authors.following') : t('authors.allSetters')}
              onPress={() => setFollowingOnly((previous) => !previous)}
            />
          </View>
        ) : null}
        {followError ? <Text variant="footnote">{t('authors.followError')}</Text> : null}
        {isError ? (
          <View>
            <Text>{t('authors.syncNeeded')}</Text>
            <Button title={t('authors.retry')} onPress={() => void refetch()} />
          </View>
        ) : null}
        {selectedSet.size > 0 ? (
          <View style={styles.selectionBar}>
            <Text variant="footnote" style={styles.selectionCount}>
              {t('mobile.search.settersCount', { count: selectedSet.size })}
            </Text>
          </View>
        ) : null}

        <View style={styles.body}>
          {isLoading ? (
            <View style={styles.loading}>
              <ActivityIndicator size="small" />
            </View>
          ) : (
            <FlashList
              data={setters ?? []}
              extraData={selectedSetters}
              keyExtractor={setterKey}
              renderItem={renderRow}
              ItemSeparatorComponent={SetterSeparator}
              contentInsetAdjustmentBehavior="automatic"
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="on-drag"
              contentContainerStyle={styles.listContent}
              ListEmptyComponent={
                <View style={styles.empty}>
                  <Text variant="subheadline" style={styles.emptyText}>
                    {debouncedSearch.length > 0 ? t('mobile.emptyState.noMatches.title') : t('mobile.filter.noSetters')}
                  </Text>
                </View>
              }
            />
          )}
        </View>

        {/* Same footer as the climb filter sheet's, pinned under the list. */}
        <View
          style={[styles.footer, { paddingBottom: insets.bottom + spacing[3], borderTopColor: systemColors.separator }]}
        >
          <Button title={applyLabel} onPress={handleApply} variant="filled" size="large" style={styles.applyButton} />
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  searchBarWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    marginHorizontal: spacing[4],
    marginTop: spacing[1],
    marginBottom: spacing[2],
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
    borderRadius: borderRadius.lg,
  },
  searchInput: {
    flex: 1,
    fontSize: textStyles.callout.fontSize,
    paddingVertical: 0,
  },
  body: {
    flex: 1,
  },
  listContent: {
    paddingBottom: spacing[3],
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
    minHeight: 48,
    gap: spacing[3],
  },
  rowText: {
    flex: 1,
  },
  count: {
    opacity: 0.6,
    marginTop: spacing[1],
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    marginLeft: spacing[4],
  },
  selectionBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[2],
  },
  selectionCount: {
    opacity: 0.6,
  },
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  empty: {
    paddingTop: spacing[6],
    alignItems: 'center',
  },
  emptyText: {
    opacity: 0.6,
  },
  // Mirrors ClimbFilterSheet's footer: hairline top border, themed at the call site.
  footer: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[3],
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  applyButton: {
    width: '100%',
  },
});
