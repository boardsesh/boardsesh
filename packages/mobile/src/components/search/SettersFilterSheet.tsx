import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Pressable, StyleSheet, TextInput } from 'react-native';
import { BottomSheetFlatList } from '@gorhom/bottom-sheet';
import type { BottomSheetModal } from '@gorhom/bottom-sheet';
import { useTranslation } from 'react-i18next';
import type { BoardSearchConfig } from '@boardsesh/climb-filters';
import { ModalSheet } from '../ModalSheet';
import { ActivityIndicator } from '../ActivityIndicator';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { useTheme } from '../../providers/theme-provider';
import { useSetterStats } from '../../lib/graphql/hooks';
import { hapticSelection } from '../../lib/haptics';
import { iosSystemColors } from '../../theme/ios-colors';
import { textStyles } from '../../theme/typography';
import { spacing, borderRadius } from '../../theme/tokens';

const SEARCH_DEBOUNCE_MS = 250;

type SetterStat = { setterUsername: string; climbCount: number };

type SettersFilterSheetProps = {
  visible: boolean;
  boardConfig: BoardSearchConfig;
  selectedSetters: string[];
  onSelectedSettersChange: (selectedSetters: string[]) => void;
  onClose: () => void;
  onDismiss: () => void;
};

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

export function SettersFilterSheet({
  visible,
  boardConfig,
  selectedSetters,
  onSelectedSettersChange,
  onClose,
  onDismiss,
}: SettersFilterSheetProps) {
  const sheetRef = useRef<BottomSheetModal>(null);
  const { t } = useTranslation('climbs');
  const { systemColors, brandColors } = useTheme();
  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (visible) {
      sheetRef.current?.present();
    } else {
      sheetRef.current?.dismiss();
    }
  }, [visible]);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const selectedSet = useMemo(() => new Set(selectedSetters), [selectedSetters]);
  const selectedSetRef = useRef(selectedSet);
  selectedSetRef.current = selectedSet;

  const handleSearchChange = useCallback((text: string) => {
    setSearchInput(text);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setDebouncedSearch(text), SEARCH_DEBOUNCE_MS);
  }, []);

  const queryInput = useMemo(
    () => ({
      boardName: boardConfig.boardName,
      layoutId: boardConfig.layoutId,
      sizeId: boardConfig.sizeId,
      setIds: boardConfig.setIds,
      angle: boardConfig.angle,
      ...(debouncedSearch.length > 0 ? { search: debouncedSearch } : {}),
    }),
    [boardConfig, debouncedSearch],
  );

  const { data: setters, isLoading } = useSetterStats(queryInput, boardConfig.boardName.length > 0);

  const toggle = useCallback(
    (username: string) => {
      hapticSelection();
      const next = new Set(selectedSetRef.current);
      if (next.has(username)) {
        next.delete(username);
      } else {
        next.add(username);
      }
      onSelectedSettersChange(Array.from(next));
    },
    [onSelectedSettersChange],
  );

  const clear = useCallback(() => {
    hapticSelection();
    onSelectedSettersChange([]);
  }, [onSelectedSettersChange]);

  const renderRow = useCallback(
    ({ item }: { item: SetterStat }) => (
      <SetterRow setter={item} isSelected={selectedSetRef.current.has(item.setterUsername)} onToggle={toggle} />
    ),
    [toggle],
  );

  return (
    <ModalSheet ref={sheetRef} snapPoints={['80%', '95%']} onDismiss={onDismiss} stackBehavior="push">
      <View style={styles.container}>
        <View style={styles.header}>
          <Text variant="title3">{t('mobile.filter.setters')}</Text>
          <Pressable onPress={onClose} hitSlop={8} accessibilityRole="button">
            <Text variant="subheadline" color={brandColors.primary} style={styles.doneLabel}>
              {t('mobile.filter.done')}
            </Text>
          </Pressable>
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
            <Pressable onPress={clear} hitSlop={8} accessibilityRole="button">
              <Text variant="footnote" color={brandColors.primary}>
                {t('mobile.filter.clearAll')}
              </Text>
            </Pressable>
          </View>
        ) : null}

        {isLoading ? (
          <View style={styles.loading}>
            <ActivityIndicator size="small" />
          </View>
        ) : (
          <BottomSheetFlatList
            data={setters ?? []}
            extraData={selectedSetters}
            keyExtractor={(item: SetterStat) => item.setterUsername}
            renderItem={renderRow}
            ItemSeparatorComponent={SetterSeparator}
            contentInsetAdjustmentBehavior="automatic"
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
    </ModalSheet>
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
    paddingTop: spacing[2],
    paddingBottom: spacing[2],
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
  empty: {
    paddingTop: spacing[6],
    alignItems: 'center',
  },
  emptyText: {
    opacity: 0.6,
  },
});
