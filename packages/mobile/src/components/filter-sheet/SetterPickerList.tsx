import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useTranslation } from 'react-i18next';
import { AccessibleTextInput as TextInput } from '../AccessibleTextInput';
import { PressableSurface } from '../PressableSurface';
import { Text } from '../Text';
import { ActivityIndicator } from '../ActivityIndicator';
import { Button } from '../Button';
import { Icon } from '../Icon';
import { useTheme } from '../../providers/theme-provider';
import { useBottomChromeMetrics } from '../../hooks/use-bottom-chrome-metrics';
import { hapticSelection } from '../../lib/haptics';
import { textStyles } from '../../theme/typography';
import { spacing, borderRadius } from '../../theme/tokens';

const SEARCH_DEBOUNCE_MS = 250;

/** One setter row: the name and how many of the surface's items they set. */
export type SetterPickerItem = { setterUsername: string; count: number };

/**
 * Follow state on each row (the climbs picker). Each reader is O(1) per row;
 * memoise the object so the list re-renders rows only when follow state moves.
 */
export type SetterPickerFollowControls = {
  isFollowing: (setterUsername: string) => boolean;
  /** A follow or unfollow for this setter is in flight; its button is locked. */
  isPending: (setterUsername: string) => boolean;
  /**
   * Listed because the climber follows the setter's Boardsesh account rather
   * than the setter; the row says so. Asked only for setters not followed.
   */
  isViaUserFollow: (setterUsername: string) => boolean;
  /** Draws a Follow / Unfollow button on each row. Leave it out while following is unavailable. */
  onFollow?: (setterUsername: string, follow: boolean) => void;
};

/** The error block under the hints: what went wrong and a retry. */
export type SetterPickerError = { message: string; retryLabel: string; onRetry: () => void };

export type SetterPickerListProps = {
  /** Undefined while the first page loads (with `isLoading`). */
  setters: readonly SetterPickerItem[] | undefined;
  isLoading: boolean;
  /** Next page for a paged source. One page per end reach. */
  onEndReached?: () => void;
  /** A footer spinner while the next page loads. */
  isFetchingNextPage?: boolean;
  /** The search text, debounced; the caller feeds it to its query. */
  onSearchChange: (search: string) => void;
  searchPlaceholder: string;
  /** Names how many items a setter has, e.g. "5 climbs". */
  formatCount: (count: number) => string;
  selected: readonly string[];
  onToggle: (setterUsername: string) => void;
  onClearAll: () => void;
  /** Tapping the name opens the setter. Without it the whole row toggles the pick. */
  onOpenSetter?: (setterUsername: string) => void;
  follow?: SetterPickerFollowControls;
  /** Under the search field, e.g. the climbs picker's All / Following scope. */
  headerAccessory?: ReactNode;
  /** Muted footnote lines under the header. */
  hints?: readonly string[];
  /** One plain line, e.g. a failed follow. */
  notice?: string;
  error?: SetterPickerError | null;
  /** The empty state with no search typed. With a search it reads "No matches". */
  emptyLabel: string;
};

const setterKey = (setter: SetterPickerItem) => setter.setterUsername;

const SetterSeparator = memo(function SetterSeparator() {
  const { systemColors } = useTheme();
  return <View style={[styles.separator, { backgroundColor: systemColors.separator }]} />;
});

type SetterRowProps = {
  setter: SetterPickerItem;
  countLabel: string;
  isSelected: boolean;
  onToggle: (setterUsername: string) => void;
  onOpen?: (setterUsername: string) => void;
  onFollow?: (setterUsername: string, follow: boolean) => void;
  following: boolean;
  viaUserFollow: boolean;
  followPending: boolean;
};

const SetterRow = memo(function SetterRow({
  setter,
  countLabel,
  isSelected,
  onToggle,
  onOpen,
  onFollow,
  following,
  viaUserFollow,
  followPending,
}: SetterRowProps) {
  const { t } = useTranslation('climbs');
  const { brandColors } = useTheme();
  const { setterUsername } = setter;
  return (
    <View style={styles.row}>
      <PressableSurface
        onPress={() => onToggle(setterUsername)}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: isSelected }}
        accessibilityLabel={setterUsername}
        accessibilityHint={t('authors.selectHint')}
        style={styles.selectionTarget}
      >
        <View style={[styles.checkbox, { borderColor: brandColors.primary }]}>
          {isSelected ? <Icon name="check.small" size={18} color={brandColors.primary} /> : null}
        </View>
      </PressableSurface>
      <PressableSurface
        style={styles.rowText}
        onPress={() => (onOpen ? onOpen(setterUsername) : onToggle(setterUsername))}
        accessibilityRole="button"
      >
        <Text variant="body">{setterUsername}</Text>
        <Text variant="footnote" style={styles.count}>
          {countLabel}
        </Text>
        {viaUserFollow ? (
          <Text variant="caption2" style={styles.count}>
            {t('authors.viaUserFollow')}
          </Text>
        ) : null}
      </PressableSurface>
      {onFollow ? (
        <PressableSurface
          disabled={followPending}
          accessibilityLabel={`${following ? t('authors.unfollow') : t('authors.follow')}: ${setterUsername}`}
          accessibilityState={{ disabled: followPending, busy: followPending }}
          onPress={() => onFollow(setterUsername, !following)}
          accessibilityRole="button"
          hitSlop={8}
        >
          <Text variant="footnote" color={brandColors.primary}>
            {following ? t('authors.unfollow') : t('authors.follow')}
          </Text>
        </PressableSurface>
      ) : null}
    </View>
  );
});

/**
 * The body of a setter picker route: a search field, a multi-select list of
 * setters with counts, and the selection bar. The data comes from the caller,
 * so the climbs picker (setter stats for a board) and the Logbook picker
 * (setters of climbs you have logged) share one list. The route keeps the
 * selection, its header action and the hand-back to the sheet that pushed it.
 */
export function SetterPickerList({
  setters,
  isLoading,
  onEndReached,
  isFetchingNextPage = false,
  onSearchChange,
  searchPlaceholder,
  formatCount,
  selected,
  onToggle,
  onClearAll,
  onOpenSetter,
  follow,
  headerAccessory,
  hints,
  notice,
  error,
  emptyLabel,
}: SetterPickerListProps) {
  const { t } = useTranslation('climbs');
  const { systemColors, brandColors } = useTheme();
  const bottomChrome = useBottomChromeMetrics();

  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onSearchChangeRef = useRef(onSearchChange);
  onSearchChangeRef.current = onSearchChange;

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const handleSearchChange = useCallback((text: string) => {
    setSearchInput(text);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebouncedSearch(text);
      onSearchChangeRef.current(text);
    }, SEARCH_DEBOUNCE_MS);
  }, []);

  const selectedSet = useMemo(() => new Set(selected), [selected]);
  // Mirror the Set for O(1) per-row lookups without re-creating renderRow on every
  // selection change (the FlashList re-renders via extraData instead).
  const selectedSetRef = useRef(selectedSet);
  selectedSetRef.current = selectedSet;

  const toggle = useCallback(
    (setterUsername: string) => {
      hapticSelection();
      onToggle(setterUsername);
    },
    [onToggle],
  );

  const clearAll = useCallback(() => {
    hapticSelection();
    onClearAll();
  }, [onClearAll]);

  const renderRow = useCallback(
    ({ item }: { item: SetterPickerItem }) => {
      const following = follow?.isFollowing(item.setterUsername) ?? false;
      return (
        <SetterRow
          setter={item}
          countLabel={formatCount(item.count)}
          isSelected={selectedSetRef.current.has(item.setterUsername)}
          onToggle={toggle}
          onOpen={onOpenSetter}
          onFollow={follow?.onFollow}
          following={following}
          viaUserFollow={!following && (follow?.isViaUserFollow(item.setterUsername) ?? false)}
          followPending={follow?.isPending(item.setterUsername) ?? false}
        />
      );
    },
    [toggle, onOpenSetter, follow, formatCount],
  );

  return (
    <View style={[styles.container, { backgroundColor: systemColors.background }]}>
      <View style={[styles.searchBarWrapper, { backgroundColor: systemColors.secondaryBackground }]}>
        <Icon name="search" size={16} color={systemColors.secondaryLabel} />
        <TextInput
          value={searchInput}
          onChangeText={handleSearchChange}
          placeholder={searchPlaceholder}
          placeholderTextColor={systemColors.secondaryLabel}
          accessibilityLabel={searchPlaceholder}
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="search"
          style={[styles.searchInput, { color: systemColors.label }]}
        />
      </View>

      {headerAccessory ? <View style={styles.headerAccessory}>{headerAccessory}</View> : null}
      {hints?.map((hint) => (
        <Text key={hint} variant="footnote" style={styles.pickerHint}>
          {hint}
        </Text>
      ))}
      {notice ? <Text variant="footnote">{notice}</Text> : null}
      {error ? (
        <View>
          <Text>{error.message}</Text>
          <Button title={error.retryLabel} onPress={error.onRetry} />
        </View>
      ) : null}
      {selectedSet.size > 0 ? (
        <View style={styles.selectionBar}>
          <Text variant="footnote" style={styles.selectionCount}>
            {t('authors.selectedCount', { count: selectedSet.size })}
          </Text>
          <PressableSurface onPress={clearAll} hitSlop={8} accessibilityRole="button">
            <Text variant="subheadline" color={brandColors.primary}>
              {t('mobile.filter.clearAll')}
            </Text>
          </PressableSurface>
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
            extraData={selected}
            keyExtractor={setterKey}
            renderItem={renderRow}
            ItemSeparatorComponent={SetterSeparator}
            onEndReached={onEndReached}
            contentInsetAdjustmentBehavior="automatic"
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            // The list runs to the screen's bottom edge: clear the tab
            // bar, and let iOS lift the last rows above the keyboard.
            automaticallyAdjustKeyboardInsets
            contentContainerStyle={{ paddingBottom: bottomChrome.scrollBottomPadding + spacing[3] }}
            ListFooterComponent={
              isFetchingNextPage ? (
                <View style={styles.footer}>
                  <ActivityIndicator size="small" />
                </View>
              ) : null
            }
            ListEmptyComponent={
              <View style={styles.empty}>
                <Text variant="subheadline" style={styles.emptyText}>
                  {debouncedSearch.length > 0 ? t('mobile.emptyState.noMatches.title') : emptyLabel}
                </Text>
              </View>
            }
          />
        )}
      </View>
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
  selectionTarget: {
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkbox: {
    width: 24,
    height: 24,
    borderWidth: 2,
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerAccessory: {
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[2],
  },
  pickerHint: {
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[2],
    opacity: 0.6,
  },
  count: {
    opacity: 0.6,
    marginTop: spacing[1],
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    marginStart: spacing[4],
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
  footer: {
    paddingVertical: spacing[3],
    alignItems: 'center',
  },
  empty: {
    paddingTop: spacing[6],
    alignItems: 'center',
  },
  emptyText: {
    opacity: 0.6,
  },
});
