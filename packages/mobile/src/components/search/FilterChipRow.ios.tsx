// Persistent, glanceable filter chips under the climbs title (the GitHub-PR-view
// idiom), built from native @expo/ui SwiftUI controls so the menus are real iOS
// menus rather than RN re-creations. iOS (Liquid Glass) only — the Material
// variant lives in ClimbTopChrome's Appbar path, and the Android counterpart is
// FilterChipRow.android.tsx. Gated behind the `persistent-filter-chips` flag by
// the caller; never mounted on focus.
//
// The always-visible facet chips follow the filter sheet's data-driven PRIMARY
// importance order (the sheet's own comment: "the levers the analytics say carry
// the product"): Grade → hide-sent/benchmarks → popularity → min-rating. Sort
// lives in the sheet's ADVANCED ("sub-2% long tail") and is intentionally NOT a
// chip — it surfaces as a removable token when non-default.
//
// One <Host> wraps a horizontal SwiftUI ScrollView + HStack of chips:
//   Filters · N → opens the long-tail sheet (Button, no menu)
//   Recent ▾    → native Menu of saved filters + Clear (hidden when none)
//   Grade       → opens the GradeRangeRail overlay (Button, no menu)   [PRIMARY #1]
//   Show ▾      → native Menu of Toggles (hide-sent, benchmarks) — stays open [#2/#3]
//   Popularity ▾→ native Menu + Picker (min-ascents buckets)           [PRIMARY #4]
//   Min rating ▾→ native Menu + Picker (star buckets)                  [PRIMARY #5]
//
// All filter state flows straight through the search provider's patch actions;
// nothing is duplicated here. Labels reuse the filter sheet's i18n keys so a
// filter is never worded two ways.

import { memo, useCallback } from 'react';
import { StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Host, HStack, ScrollView, Menu, Picker, Toggle, Button, Text, Divider } from '@expo/ui/swift-ui';
import { buttonStyle, controlSize, tint, tag, padding, menuActionDismissBehavior } from '@expo/ui/swift-ui/modifiers';
import { formatMinAscentsFilterCount } from '@boardsesh/climb-filters';
import { getFilterKey } from '../../lib/recent-filter-store';
import {
  POPULARITY_BUCKETS,
  popularityTag,
  popularityFromTag,
  RATING_BUCKETS,
  ratingTag,
  ratingFromTag,
} from '../../lib/filter-chip-menus';
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
  minAscents,
  onChangePopularity,
  minRating,
  onChangeRating,
  hideCompleted,
  onToggleHideCompleted,
  onlyBenchmarks,
  onToggleBenchmarks,
  canHideCompleted,
}: FilterChipRowProps) {
  const { t } = useTranslation('climbs');
  const { brandColors } = useTheme();

  const popularityLabel = useCallback(
    (bucket: number | undefined): string => {
      if (bucket == null) return t('mobile.filter.anyAscents');
      if (bucket === 2) return t('mobile.filter.established2plus');
      return `${formatMinAscentsFilterCount(bucket)}+`;
    },
    [t],
  );

  // Picker option labels for the rating chip: "Any" / "N+ ⭐" (the exact wording
  // the rating token uses, so chip, token, and sheet never diverge).
  const ratingOptionLabel = useCallback(
    (bucket: number | undefined): string =>
      bucket == null ? t('mobile.filter.anyRating') : t('mobile.search.rating', { count: bucket }),
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
  const hasActiveRating = minRating != null;

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

          {/* Grade → the range rail overlay. A button, not a menu. [PRIMARY #1] */}
          <Button label={gradeLabel} onPress={onOpenGrade} modifiers={chipModifiers(gradeActive)} />

          {/* Show ▾ — hide-sent + benchmarks; menuActionDismissBehavior keeps it
              open. [PRIMARY #2 + #3] */}
          <Menu
            label={t('mobile.search.chips.show')}
            modifiers={[...chipModifiers(hideCompleted || onlyBenchmarks), menuActionDismissBehavior('disabled')]}
          >
            {canHideCompleted ? (
              <Toggle label={t('mobile.filter.hideSent')} isOn={hideCompleted} onIsOnChange={onToggleHideCompleted} />
            ) : null}
            <Toggle label={t('mobile.filter.benchmark')} isOn={onlyBenchmarks} onIsOnChange={onToggleBenchmarks} />
          </Menu>

          {/* Popularity ▾ — min-ascents buckets; conflict-clear handled upstream.
              [PRIMARY #4] */}
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

          {/* Min rating ▾ — star buckets (single-select). [PRIMARY #5] */}
          <Menu
            label={hasActiveRating ? t('mobile.search.rating', { count: minRating }) : t('mobile.filter.minRating')}
            modifiers={chipModifiers(hasActiveRating)}
          >
            <Picker
              selection={ratingTag(minRating)}
              onSelectionChange={(value) => onChangeRating(ratingFromTag(value as string))}
            >
              {RATING_BUCKETS.map((bucket) => (
                <Text key={ratingTag(bucket)} modifiers={[tag(ratingTag(bucket))]}>
                  {ratingOptionLabel(bucket)}
                </Text>
              ))}
            </Picker>
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
