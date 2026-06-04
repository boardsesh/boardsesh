// The climb-list search row: a row of floating Liquid Glass controls pinned just
// below the status bar, with the list scrolling under them. Replaces the old
// nav-header search pill + the (header-occluded, unreachable) StickyFilterStrip.
//
// Layout: [🔍 glass search capsule] [grade] [filter] [＋ create]
//   - sticky-strip value: grade + filter live inline here; a second chips row
//     appears under the row only when filters are active.
//   - bottom-bar value: this row isn't rendered; that layout uses ClimbTopChrome
//     (board + create) up top and the thumb-zone SearchFab for search/grade/filter.
//
// The container is `box-none` so taps in the gaps fall through to the list; each
// control captures its own touches. It reports its measured height so the screen
// can pad the list to rest below it (handles the chips row appearing/vanishing).

import { type Ref, useCallback } from 'react';
import { type LayoutChangeEvent, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import type { Grade } from '@boardsesh/shared-schema';
import type { GradeBound, ClimbBoardFilterState } from '@boardsesh/climb-filters';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';
import { hapticLight } from '../../lib/haptics';
import type { ClimbFilters } from '../../lib/climb-filter-types';
import type { SearchLayout } from '../../lib/search-layout-preference';
import { SearchHeader, type SearchHeaderHandle } from '../SearchHeader';
import { GlassIconButton } from '../GlassIconButton';
import { Text } from '../Text';
import { GradePill } from './GradePill';
import { FilterButton } from './FilterButton';
import { ActiveFilterChips } from './ActiveFilterChips';

type ClimbSearchBarProps = {
  layout: SearchLayout;
  // Search field
  searchFieldRef: Ref<SearchHeaderHandle>;
  searchInitialValue: string;
  searchPlaceholder: string;
  onSearchChange: (text: string) => void;
  onSearchFocus: () => void;
  onSearchBlur: () => void;
  // Grade + filter (rendered inline only in the sticky-strip layout)
  bound: GradeBound;
  grades: readonly Grade[];
  filters: ClimbFilters;
  boardFilters: ClimbBoardFilterState;
  count: number | undefined;
  activeFilterCount: number;
  onOpenGrade: () => void;
  onOpenFilters: () => void;
  onPatchFilters: (patch: Partial<ClimbFilters>) => void;
  onPatchBoardFilters: (patch: Partial<ClimbBoardFilterState>) => void;
  // Create
  canCreate: boolean;
  onCreate: () => void;
  // Reports the bar's full height (incl. the top safe-area inset) so the list pads below it.
  onHeightChange: (height: number) => void;
};

export function ClimbSearchBar({
  layout,
  searchFieldRef,
  searchInitialValue,
  searchPlaceholder,
  onSearchChange,
  onSearchFocus,
  onSearchBlur,
  bound,
  grades,
  filters,
  boardFilters,
  count,
  activeFilterCount,
  onOpenGrade,
  onOpenFilters,
  onPatchFilters,
  onPatchBoardFilters,
  canCreate,
  onCreate,
  onHeightChange,
}: ClimbSearchBarProps) {
  const { t } = useTranslation('climbs');
  const { systemColors } = useTheme();
  const insets = useSafeAreaInsets();
  const showControls = layout === 'sticky-strip';
  const filtersActive = activeFilterCount > 0;

  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => onHeightChange(event.nativeEvent.layout.height),
    [onHeightChange],
  );

  const handleCreate = useCallback(() => {
    hapticLight();
    onCreate();
  }, [onCreate]);

  return (
    <View pointerEvents="box-none" style={[styles.container, { paddingTop: insets.top }]} onLayout={handleLayout}>
      <View pointerEvents="box-none" style={styles.row}>
        {canCreate ? (
          <GlassIconButton
            iconName="plus"
            iconColor={systemColors.label as string}
            onPress={handleCreate}
            accessibilityLabel={t('mobile.create.fab.ariaLabel')}
            fallbackColor={systemColors.fill}
          />
        ) : null}

        <SearchHeader
          ref={searchFieldRef}
          initialValue={searchInitialValue}
          placeholder={searchPlaceholder}
          onChangeText={onSearchChange}
          onFocus={onSearchFocus}
          onBlur={onSearchBlur}
        />

        {showControls ? <GradePill bound={bound} grades={grades} onPress={onOpenGrade} maxWidth={132} /> : null}

        {showControls && count != null ? (
          <Text variant="caption1" color={systemColors.secondaryLabel} numberOfLines={1} style={styles.countText}>
            {t('mobile.search.climbsCount', { count })}
          </Text>
        ) : null}

        {showControls ? <FilterButton activeFilterCount={activeFilterCount} onPress={onOpenFilters} /> : null}
      </View>

      {showControls && filtersActive ? (
        <ActiveFilterChips
          filters={filters}
          boardFilters={boardFilters}
          onPatchFilters={onPatchFilters}
          onPatchBoardFilters={onPatchBoardFilters}
          style={styles.chipsRow}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 10,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[2],
  },
  chipsRow: {
    paddingHorizontal: spacing[4],
    paddingBottom: spacing[2],
  },
  countText: {
    flexShrink: 0,
  },
});
