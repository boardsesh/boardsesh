import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Pressable, StyleSheet, TextInput } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { BoardName } from '@boardsesh/shared-schema';
import { Text } from '../../../src/components/Text';
import { ActivityIndicator } from '../../../src/components/ActivityIndicator';
import { Icon } from '../../../src/components/Icon';
import { useTheme } from '../../../src/providers/theme-provider';
import { useSetterStats } from '../../../src/lib/graphql/hooks';
import { emitSetterFilterSelection } from '../../../src/lib/setter-filter-handoff';
import { hapticSelection } from '../../../src/lib/haptics';
import { iosSystemColors } from '../../../src/theme/ios-colors';
import { textStyles } from '../../../src/theme/typography';
import { spacing, borderRadius } from '../../../src/theme/tokens';

const SEARCH_DEBOUNCE_MS = 250;

type Params = {
  boardName?: string;
  layoutId?: string;
  sizeId?: string;
  setIds?: string;
  angle?: string;
  setters?: string;
};

type SetterStat = { setterUsername: string; climbCount: number };

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

const SetterSeparator = memo(function SetterSeparator() {
  return <View style={[styles.separator, { backgroundColor: iosSystemColors.separator }]} />;
});

type SetterRowProps = {
  setter: SetterStat;
  isSelected: boolean;
  onToggle: (username: string) => void;
};

const SetterRow = memo(function SetterRow({ setter, isSelected, onToggle }: SetterRowProps) {
  const { t } = useTranslation('climbs');
  const { brandColors } = useTheme();
  return (
    <Pressable
      onPress={() => onToggle(setter.setterUsername)}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: isSelected }}
      accessibilityLabel={setter.setterUsername}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      <View style={styles.rowText}>
        <Text variant="body">{setter.setterUsername}</Text>
        <Text variant="footnote" style={styles.count}>
          {t('mobile.search.climbsCount', { count: setter.climbCount })}
        </Text>
      </View>
      {isSelected ? <Icon name="check.small" size={20} color={brandColors.primary} /> : null}
    </Pressable>
  );
});

/**
 * Full-screen route variant for the setter search filter. The climb filter sheet
 * suspends and pushes this route, then merges the selection back via
 * `emitSetterFilterSelection` when the screen pops (Done or swipe-back). A pushed
 * route is used (not a stacked sheet) because native sheets can't stack above the
 * filter sheet — see docs/mobile-sheets-vs-routes.md.
 */
export default function SettersFilterScreen() {
  const params = useLocalSearchParams<Params>();
  const router = useRouter();
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

  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  // Hand the current selection back to the sheet whenever this screen loses focus
  // (Done button pops, or swipe-back). Matches the hold/zone handoff timing.
  useFocusEffect(
    useCallback(() => {
      return () => emitSetterFilterSelection(selectedSettersRef.current);
    }, []),
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
      ...(debouncedSearch.length > 0 ? { search: debouncedSearch } : {}),
    }),
    [boardName, layoutId, sizeId, setIds, angle, debouncedSearch],
  );

  const { data: setters, isLoading } = useSetterStats(queryInput, boardName.length > 0);

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

  const done = useCallback(() => {
    router.back();
  }, [router]);

  const renderRow = useCallback(
    ({ item }: { item: SetterStat }) => (
      <SetterRow setter={item} isSelected={selectedSetRef.current.has(item.setterUsername)} onToggle={toggle} />
    ),
    [toggle],
  );

  return (
    <View style={[styles.container, { backgroundColor: systemColors.background }]}>
      <View style={[styles.header, { paddingTop: insets.top + spacing[2] }]}>
        <Text variant="title3">{t('mobile.filter.setters')}</Text>
        <View style={styles.headerActions}>
          {selectedSet.size > 0 ? (
            <Pressable onPress={clear} hitSlop={8} accessibilityRole="button">
              <Text variant="subheadline" color={brandColors.primary}>
                {t('mobile.filter.clearAll')}
              </Text>
            </Pressable>
          ) : null}
          <Pressable onPress={done} hitSlop={8} accessibilityRole="button">
            <Text variant="subheadline" color={brandColors.primary} style={styles.doneLabel}>
              {t('mobile.filter.done')}
            </Text>
          </Pressable>
        </View>
      </View>

      <View style={[styles.searchBarWrapper, { backgroundColor: systemColors.secondaryBackground }]}>
        <Icon name="search" size={16} color={iosSystemColors.systemGray} />
        <TextInput
          value={searchInput}
          onChangeText={handleSearchChange}
          placeholder={t('mobile.filter.searchSetters')}
          placeholderTextColor={iosSystemColors.systemGray}
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="search"
          style={[styles.searchInput, { color: systemColors.label }]}
        />
      </View>

      {selectedSet.size > 0 ? (
        <View style={styles.selectionBar}>
          <Text variant="footnote" style={styles.selectionCount}>
            {t('mobile.search.settersCount', { count: selectedSet.size })}
          </Text>
        </View>
      ) : null}

      {isLoading ? (
        <View style={styles.loading}>
          <ActivityIndicator size="small" />
        </View>
      ) : (
        <FlashList
          data={setters ?? []}
          extraData={selectedSetters}
          keyExtractor={(item: SetterStat) => item.setterUsername}
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
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing[4],
    paddingBottom: spacing[2],
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[4],
  },
  doneLabel: {
    fontWeight: '600',
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
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
    minHeight: 48,
  },
  rowPressed: {
    opacity: 0.6,
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
  listContent: {
    paddingBottom: spacing[6],
  },
  empty: {
    paddingTop: spacing[6],
    alignItems: 'center',
  },
  emptyText: {
    opacity: 0.6,
  },
});
