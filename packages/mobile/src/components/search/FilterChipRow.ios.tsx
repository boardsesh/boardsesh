// Persistent, glanceable filter chips under the climbs title (the GitHub-PR-view
// idiom), built from native @expo/ui SwiftUI controls so the menus are real iOS
// menus rather than RN re-creations. iOS (Liquid Glass) only — the Material
// variant lives in ClimbTopChrome's Appbar path, and the Android counterpart is
// FilterChipRow.android.tsx. Gated behind the `persistent-filter-chips` flag by
// the caller; never mounted on focus.
//
// One <Host> wraps a horizontal SwiftUI ScrollView + HStack of chips:
//   Filters · N → opens the long-tail sheet (Button, no menu)
//   Recent ▾    → native Menu of saved filters + Clear (hidden when none)
//   Grade       → opens the GradeRangeRail overlay (Button, no menu)
//   Sort ▾      → native Menu + Picker (single-select, native checkmarks)
//   Popularity ▾→ native Menu + Picker (min-ascents buckets)
//   Show ▾      → native Menu of Toggles (hide-sent, benchmarks) — stays open
//
// All filter state flows straight through the search provider's patch actions;
// nothing is duplicated here. Labels reuse the filter sheet's i18n keys so a
// filter is never worded two ways.

import { memo, useCallback } from 'react';
import { StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Host, HStack, ScrollView, Menu, Picker, Toggle, Button, Text, Divider } from '@expo/ui/swift-ui';
import { buttonStyle, controlSize, tint, tag, padding, menuActionDismissBehavior } from '@expo/ui/swift-ui/modifiers';
import { type SortOption, formatMinAscentsFilterCount } from '@boardsesh/climb-filters';
import { getFilterKey } from '../../lib/recent-filter-store';
import { buildSortLabel } from '../../lib/filter-labels';
import { SORT_CHIP_OPTIONS, POPULARITY_BUCKETS, popularityTag, popularityFromTag } from '../../lib/filter-chip-menus';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';
import type { FilterChipRowProps } from './FilterChipRow.types';

function FilterChipRowComponent({
  activeFilterCount,
  onOpenFilters,
  recentFilters,
  currentFilters,
  currentSearchText,
  onApplyRecent,
  onClearRecent,
  gradeLabel,
  gradeActive,
  onOpenGrade,
  sortBy,
  onChangeSort,
  minAscents,
  onChangePopularity,
  hideCompleted,
  onToggleHideCompleted,
  onlyBenchmarks,
  onToggleBenchmarks,
  canHideCompleted,
}: FilterChipRowProps) {
  const { t } = useTranslation('climbs');
  const { brandColors } = useTheme();
  const sortLabel = buildSortLabel(t);

  const popularityLabel = useCallback(
    (bucket: number | undefined): string => {
      if (bucket == null) return t('mobile.filter.anyAscents');
      if (bucket === 2) return t('mobile.filter.established2plus');
      return `${formatMinAscentsFilterCount(bucket)}+`;
    },
    [t],
  );

  // `tint` is the only state signal the native chips need: an active facet reads
  // brand-tinted, an inactive one stays neutral. buttonStyle('bordered') renders
  // a native rounded chip on every iOS; the device prototype decides whether to
  // upgrade to buttonStyle('glass') on iOS 26.
  const chipModifiers = useCallback(
    (active: boolean) =>
      active
        ? [buttonStyle('bordered'), controlSize('small'), tint(brandColors.primary)]
        : [buttonStyle('bordered'), controlSize('small')],
    [brandColors.primary],
  );

  const currentRecentKey = getFilterKey(currentFilters, currentSearchText);
  const hasActivePopularity = minAscents != null;

  const filtersLabel =
    activeFilterCount > 0
      ? t('mobile.search.chips.filtersWithCount', { count: activeFilterCount })
      : t('mobile.filter.title');

  return (
    <Host matchContents={{ vertical: true }} style={styles.host}>
      <ScrollView axes="horizontal" showsIndicators={false}>
        <HStack spacing={spacing[2]} modifiers={[padding({ horizontal: spacing[4] })]}>
          {/* Filters · N → the long-tail sheet. A button, not a menu. */}
          <Button
            label={filtersLabel}
            systemImage="line.3.horizontal.decrease"
            onPress={onOpenFilters}
            modifiers={chipModifiers(activeFilterCount > 0)}
          />

          {/* Recent ▾ — always reachable, the fix for "recents are buried". */}
          {recentFilters.length > 0 ? (
            <Menu
              label={t('mobile.search.recentFilters')}
              systemImage="clock.arrow.circlepath"
              modifiers={chipModifiers(false)}
            >
              {recentFilters.map((recent) => (
                <Button
                  key={recent.id}
                  label={recent.label}
                  systemImage={
                    getFilterKey(recent.filters, recent.searchText) === currentRecentKey ? 'checkmark' : undefined
                  }
                  onPress={() => onApplyRecent(recent.filters, recent.searchText)}
                />
              ))}
              <Divider />
              <Button role="destructive" label={t('mobile.search.clearRecentSearches')} onPress={onClearRecent} />
            </Menu>
          ) : null}

          {/* Grade → the range rail overlay. A button, not a menu. */}
          <Button label={gradeLabel} onPress={onOpenGrade} modifiers={chipModifiers(gradeActive)} />

          {/* Sort ▾ — native single-select Picker (checkmarks). */}
          <Menu
            label={t('mobile.search.chips.sort', { value: sortLabel(sortBy) ?? '' })}
            modifiers={chipModifiers(false)}
          >
            <Picker selection={sortBy} onSelectionChange={(value) => onChangeSort(value as SortOption)}>
              {SORT_CHIP_OPTIONS.map((option) => (
                <Text key={option} modifiers={[tag(option)]}>
                  {sortLabel(option) ?? option}
                </Text>
              ))}
            </Picker>
          </Menu>

          {/* Popularity ▾ — min-ascents buckets; conflict-clear handled upstream. */}
          <Menu
            label={hasActivePopularity ? popularityLabel(minAscents) : t('mobile.filter.popularity')}
            modifiers={chipModifiers(hasActivePopularity)}
          >
            <Picker
              selection={popularityTag(minAscents)}
              onSelectionChange={(value) => onChangePopularity(popularityFromTag(value as string))}
            >
              {POPULARITY_BUCKETS.map((bucket) => (
                <Text key={popularityTag(bucket)} modifiers={[tag(popularityTag(bucket))]}>
                  {popularityLabel(bucket)}
                </Text>
              ))}
            </Picker>
          </Menu>

          {/* Show ▾ — multi-toggle; menuActionDismissBehavior keeps it open. */}
          <Menu
            label={t('mobile.search.chips.show')}
            modifiers={[...chipModifiers(hideCompleted || onlyBenchmarks), menuActionDismissBehavior('disabled')]}
          >
            {canHideCompleted ? (
              <Toggle label={t('mobile.filter.hideSent')} isOn={hideCompleted} onIsOnChange={onToggleHideCompleted} />
            ) : null}
            <Toggle label={t('mobile.filter.benchmark')} isOn={onlyBenchmarks} onIsOnChange={onToggleBenchmarks} />
          </Menu>
        </HStack>
      </ScrollView>
    </Host>
  );
}

const styles = StyleSheet.create({
  host: {
    width: '100%',
  },
});

export const FilterChipRow = memo(FilterChipRowComponent);
