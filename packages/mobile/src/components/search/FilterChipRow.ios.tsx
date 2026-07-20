// Persistent, glanceable filter chips under the climbs title (the GitHub-PR-view
// idiom), built from native @expo/ui SwiftUI controls so the menus are real iOS
// menus rather than RN re-creations. This is the iOS (Liquid Glass) tree; the
// Android counterpart is FilterChipRow.android.tsx (native Jetpack Compose, the
// Material default — see its header). Mounted by the caller; never on search focus.
//
// Chips render in the fixed catalog order (lib/pinnable-chips.ts), gated on the
// user's pinned set. Tier-1 chips (Grade, progress, Collection, shape, popularity,
// min-rating) are pinned by default; Tier-2 chips (grade accuracy, climb type,
// beta, sort) are opt-in and only appear once pinned in the sheet. An unpinned but
// non-default control still surfaces as a removable token instead.
//
// One <Host> wraps a horizontal SwiftUI ScrollView + HStack of chips:
//   Filters · N → opens the long-tail sheet (Button, no menu)
//   Recent ▾    → native Menu of saved filters + Clear (hidden when none)
//   Grade       → opens the GradeRangeRail overlay (Button, no menu)   [PRIMARY #1]
//   Your progress ▾ → native Menu + Picker (single-select, auth-gated) [PRIMARY #2]
//   Benchmarks  → toggle chip (Button, tap flips it)                   [PRIMARY #3]
//   Popularity ▾→ native Menu + Picker (min-ascents buckets)           [PRIMARY #4]
//   Min rating ▾→ native Menu + Picker (star buckets)                  [PRIMARY #5]
//
// All filter state flows straight through the search provider's patch actions;
// nothing is duplicated here. Labels reuse the filter sheet's i18n keys so a
// filter is never worded two ways.

import { memo, useCallback } from 'react';
import { StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Host, HStack, ScrollView, Menu, Picker, Button, Text, Divider } from '@expo/ui/swift-ui';
import { buttonStyle, controlSize, tint, tag, padding } from '@expo/ui/swift-ui/modifiers';
import { PROGRESS_FILTER_VALUES, SORT_OPTIONS, GRADE_ACCURACY_VALUES } from '@boardsesh/climb-filters';
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
import {
  popularityChipLabel,
  ratingChipLabel,
  progressFilterLabel,
  isProgressFilter,
  collectionChipLabel,
  isCollectionFilter,
  isSortOption,
  accuracyChipLabel,
  isAccuracyTag,
  climbTypeChipLabel,
  isClimbType,
} from './FilterChipRow.logic';
import { buildSortLabel } from '../../lib/filter-labels';
import { COLLECTION_VALUES } from '../../lib/collection-filter';
import type { FilterChipRowProps } from './FilterChipRow.types';

function FilterChipRowComponent({
  pinnedChips,
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
  gradeRailOpen,
  onCloseGrade,
  dimensionChips,
  minAscents,
  onChangePopularity,
  minRating,
  onChangeRating,
  progress,
  onChangeProgress,
  canFilterProgress,
  collection,
  onChangeCollection,
  canFilterDrafts,
  sortBy,
  sortActive,
  onChangeSort,
  accuracyValue,
  onChangeAccuracy,
  climbType,
  onChangeClimbType,
  betaActive,
  onToggleBeta,
}: FilterChipRowProps) {
  const { t } = useTranslation('climbs');
  const { brandColors } = useTheme();
  // Built once per render (and only when Sort is actually pinned), reused for the
  // resting label + all 7 menu items.
  const sortLabelFor = pinnedChips.includes('sort') ? buildSortLabel(t) : null;

  // Popularity / rating chip wording lives in FilterChipRow.logic (shared with the
  // Android tree) so a filter is never worded two ways across platforms.

  // Real iOS 26 Liquid Glass: an inactive chip is a neutral glass capsule
  // (`buttonStyle('glass')`); an active facet is a brand-tinted prominent glass
  // capsule (`buttonStyle('glassProminent')` + tint). @expo/ui guards both with
  // `if #available(iOS 26)`, so they degrade gracefully on older iOS. (The earlier
  // `bordered` style fell back to a flat thin material on iOS 26 — too see-through.)
  const chipModifiers = useCallback(
    (active: boolean) =>
      active
        ? [buttonStyle('glassProminent'), controlSize('small'), tint(brandColors.primary)]
        : [buttonStyle('glass'), controlSize('small')],
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
        {/* Vertical slack lets a pressed chip's Liquid Glass lens expand without the host's fixed height clipping it. */}
        <HStack spacing={spacing[2]} modifiers={[padding({ horizontal: spacing[4], vertical: spacing[2] })]}>
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

          {/* Grade → the range rail overlay. A button, not a menu; tap toggles the
              rail (close path beyond the tap-outside dismiss layer). [PRIMARY #1] */}
          {pinnedChips.includes('grade') ? (
            <Button
              label={gradeLabel}
              onPress={gradeRailOpen ? onCloseGrade : onOpenGrade}
              modifiers={chipModifiers(gradeActive)}
            />
          ) : null}

          {/* Grade accuracy ▾ — single-select over Off/Loose/Moderate/Tight; refines
              how close a climb's difficulty must sit to the picked grade. Opt-in. */}
          {pinnedChips.includes('accuracy') ? (
            <Menu
              label={accuracyValue === 'off' ? t('mobile.filter.accuracy.label') : accuracyChipLabel(accuracyValue, t)}
              modifiers={chipModifiers(accuracyValue !== 'off')}
            >
              <Picker
                selection={accuracyValue}
                onSelectionChange={(value) => {
                  if (typeof value !== 'string' || !isAccuracyTag(value)) return;
                  onChangeAccuracy(value);
                }}
              >
                {GRADE_ACCURACY_VALUES.map((value) => (
                  <Text key={value} modifiers={[tag(value === '0' ? 'off' : value)]}>
                    {accuracyChipLabel(value, t)}
                  </Text>
                ))}
              </Picker>
            </Menu>
          ) : null}

          {/* Your progress ▾ — single-select over the four tick flags (auth-gated,
              the chip hides when signed out). [PRIMARY #2] — kept directly after
              Grade. Resting label is the dimension name; active shows the pick. */}
          {canFilterProgress && pinnedChips.includes('progress') ? (
            <Menu
              label={progress === 'all' ? t('mobile.filter.progress.label') : progressFilterLabel(progress, t)}
              modifiers={chipModifiers(progress !== 'all')}
            >
              <Picker
                selection={progress}
                onSelectionChange={(value) => {
                  // The Picker hands back its selection as an untyped tag string;
                  // guard it to a real ProgressFilter before committing.
                  if (typeof value !== 'string' || !isProgressFilter(value)) return;
                  onChangeProgress(value);
                }}
              >
                {PROGRESS_FILTER_VALUES.map((value) => (
                  <Text key={value} modifiers={[tag(value)]}>
                    {progressFilterLabel(value, t)}
                  </Text>
                ))}
              </Picker>
            </Menu>
          ) : null}

          {/* Collection — Any / Benchmarks / My drafts single-select (My drafts is
              auth-gated, dropped from the menu when signed out). [PRIMARY #3] */}
          {pinnedChips.includes('collection') ? (
            <Menu
              label={collection === 'any' ? t('mobile.filter.collection.label') : collectionChipLabel(collection, t)}
              modifiers={chipModifiers(collection !== 'any')}
            >
              <Picker
                selection={collection}
                onSelectionChange={(value) => {
                  if (typeof value !== 'string' || !isCollectionFilter(value)) return;
                  onChangeCollection(value);
                }}
              >
                {COLLECTION_VALUES.filter((value) => value !== 'drafts' || canFilterDrafts).map((value) => (
                  <Text key={value} modifiers={[tag(value)]}>
                    {collectionChipLabel(value, t)}
                  </Text>
                ))}
              </Picker>
            </Menu>
          ) : null}

          {/* Climb type ▾ — Boulders / Routes / Both single-select. Default is
              boulders-only, so the resting chip reads "Climb type" and is inactive. */}
          {pinnedChips.includes('climbType') ? (
            <Menu
              label={climbType === 'boulders' ? t('mobile.filter.climbType') : climbTypeChipLabel(climbType, t)}
              modifiers={chipModifiers(climbType !== 'boulders')}
            >
              <Picker
                selection={climbType}
                onSelectionChange={(value) => {
                  if (typeof value !== 'string' || !isClimbType(value)) return;
                  onChangeClimbType(value);
                }}
              >
                {(['boulders', 'routes', 'both'] as const).map((value) => (
                  <Text key={value} modifiers={[tag(value)]}>
                    {climbTypeChipLabel(value, t)}
                  </Text>
                ))}
              </Picker>
            </Menu>
          ) : null}

          {/* Shape — one chip grouping the Tall + Wide toggles. They're independent
              (a climb can be both), so the menu carries two checkable toggles rather
              than a single-select. Shown only when the board size has the expansion. */}
          {pinnedChips.includes('shape') && dimensionChips.length > 0 ? (
            <Menu
              label={t('mobile.filter.shape')}
              modifiers={chipModifiers(dimensionChips.some((dimension) => dimension.active))}
            >
              {dimensionChips.map((dimension) => (
                <Button
                  key={dimension.key}
                  label={dimension.key === 'tall' ? t('mobile.search.chips.tall') : t('mobile.search.chips.wide')}
                  systemImage={dimension.active ? 'checkmark' : undefined}
                  onPress={dimension.onToggle}
                />
              ))}
            </Menu>
          ) : null}

          {/* Beta videos — a plain on/off toggle (a content property, not a level).
              A Button that flips on tap, like the old Benchmarks chip. Opt-in. */}
          {pinnedChips.includes('beta') ? (
            <Button
              label={t('mobile.filter.betaVideos')}
              onPress={onToggleBeta}
              modifiers={chipModifiers(betaActive)}
            />
          ) : null}

          {/* Popularity ▾ — min-ascents buckets; conflict-clear handled upstream.
              [PRIMARY #4] */}
          {pinnedChips.includes('popularity') ? (
            <Menu
              label={hasActivePopularity ? popularityChipLabel(minAscents, t) : t('mobile.filter.popularity')}
              modifiers={chipModifiers(hasActivePopularity)}
            >
              <Picker
                selection={popularityTag(minAscents)}
                onSelectionChange={(value) => {
                  // @expo/ui types the selection as the untyped Picker tag; our tags
                  // are always strings, so guard rather than blind-cast (a non-string
                  // would otherwise become NaN silently).
                  if (typeof value !== 'string') return;
                  onChangePopularity(popularityFromTag(value));
                }}
              >
                {POPULARITY_BUCKETS.map((bucket) => (
                  <Text key={popularityTag(bucket)} modifiers={[tag(popularityTag(bucket))]}>
                    {popularityChipLabel(bucket, t)}
                  </Text>
                ))}
              </Picker>
            </Menu>
          ) : null}

          {/* Min rating ▾ — star buckets (single-select). [PRIMARY #5] */}
          {pinnedChips.includes('rating') ? (
            <Menu
              label={hasActiveRating ? t('mobile.search.rating', { count: minRating }) : t('mobile.filter.minRating')}
              modifiers={chipModifiers(hasActiveRating)}
            >
              <Picker
                selection={ratingTag(minRating)}
                onSelectionChange={(value) => {
                  // See the popularity Picker: guard the untyped tag before mapping it.
                  if (typeof value !== 'string') return;
                  onChangeRating(ratingFromTag(value));
                }}
              >
                {RATING_BUCKETS.map((bucket) => (
                  <Text key={ratingTag(bucket)} modifiers={[tag(ratingTag(bucket))]}>
                    {ratingChipLabel(bucket, t)}
                  </Text>
                ))}
              </Picker>
            </Menu>
          ) : null}

          {/* Sort ▾ — single-select over the sort keys (direction stays a sheet-only
              refinement). Picking Random reseeds a fresh shuffle. Opt-in, sits last. */}
          {pinnedChips.includes('sort') ? (
            <Menu
              label={sortActive ? (sortLabelFor?.(sortBy) ?? sortBy) : t('mobile.filter.sortBy')}
              modifiers={chipModifiers(sortActive)}
            >
              <Picker
                selection={sortBy}
                onSelectionChange={(value) => {
                  if (typeof value !== 'string' || !isSortOption(value)) return;
                  onChangeSort(value);
                }}
              >
                {SORT_OPTIONS.map((value) => (
                  <Text key={value} modifiers={[tag(value)]}>
                    {sortLabelFor?.(value) ?? value}
                  </Text>
                ))}
              </Picker>
            </Menu>
          ) : null}
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
