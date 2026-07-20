// FilterChipRow — web implementation (react-native-web + react-native-paper). The
// persistent, horizontally-scrolling filter-chip row, built from Paper Material 3
// `Chip`s + `Menu`s — the Material counterpart to the Compose FilterChips +
// DropdownMenus in FilterChipRow.android.tsx, which it mirrors one-for-one (same
// chip set, order, gating, and labels).
//
// Chips render in the fixed catalog order (lib/pinnable-chips.ts), each gated on
// the user's pinned set; the fixed chrome (Angle, Filters, Recent) always renders.
// Chip wording is sourced from FilterChipRow.logic so a filter is never worded two
// ways across platforms; the bucket sets come from the shared filter-chip-menus.

import { memo, useState, type ReactNode } from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Chip, Divider, Menu } from 'react-native-paper';
import { PROGRESS_FILTER_VALUES, SORT_OPTIONS, GRADE_ACCURACY_VALUES } from '@boardsesh/climb-filters';
import { getFilterKey } from '../../lib/recent-filter-store';
import { POPULARITY_BUCKETS, RATING_BUCKETS } from '../../lib/filter-chip-menus';
import { COLLECTION_VALUES } from '../../lib/collection-filter';
import { spacing } from '../../theme/tokens';
import { useMaterialAngleControl } from '../chrome/use-material-angle-control';
import { AngleSelectorSheet } from '../play-drawer/AngleSelectorSheet';
import {
  popularityChipLabel,
  progressFilterLabel,
  ratingChipLabel,
  collectionChipLabel,
  accuracyChipLabel,
  climbTypeChipLabel,
} from './FilterChipRow.logic';
import { buildSortLabel } from '../../lib/filter-labels';
import type { FilterChipRowProps } from './FilterChipRow.types';

// A chip that anchors a controlled Paper Menu. The `children` render-prop receives
// a `close` so single-choice items can dismiss (keep-open toggle items simply
// don't call it).
function MenuChip({
  label,
  selected,
  icon,
  children,
}: {
  label: string;
  selected: boolean;
  icon?: string;
  children: (close: () => void) => ReactNode;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <Menu
      visible={visible}
      onDismiss={() => setVisible(false)}
      anchor={
        <Chip mode="outlined" selected={selected} icon={icon} onPress={() => setVisible(true)} style={styles.chip}>
          {label}
        </Chip>
      }
    >
      {children(() => setVisible(false))}
    </Menu>
  );
}

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
  const {
    activeBoard,
    canAdjust: canAdjustAngle,
    visible: angleSheetVisible,
    open: openAngle,
    close: closeAngle,
    change: changeAngle,
  } = useMaterialAngleControl();

  const currentRecentKey = getFilterKey(currentFilters, currentSearchText);
  const hasActivePopularity = minAscents != null;
  const hasActiveRating = minRating != null;
  const filtersLabel =
    activeFilterCount > 0
      ? t('mobile.search.chips.filtersWithCount', { count: activeFilterCount })
      : t('mobile.filter.title');
  // Built once per render (and only when Sort is actually pinned), reused for the
  // resting label + all 7 menu items.
  const sortLabelFor = pinnedChips.includes('sort') ? buildSortLabel(t) : null;

  return (
    <>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.row}
        keyboardShouldPersistTaps="handled"
      >
        {canAdjustAngle && activeBoard ? (
          <Chip
            mode="outlined"
            onPress={openAngle}
            accessibilityLabel={t('angleSelector.selectAngle')}
            style={styles.chip}
          >
            {`${activeBoard.angle}°`}
          </Chip>
        ) : null}
        {/* Filters · N → the long-tail sheet. */}
        <Chip mode="outlined" icon="tune" selected={activeFilterCount > 0} onPress={onOpenFilters} style={styles.chip}>
          {filtersLabel}
        </Chip>

        {/* Recent — hidden when there are none. */}
        {recentFilters.length > 0 ? (
          <MenuChip label={t('mobile.search.recentFilters')} selected={false} icon="history">
            {(close) => (
              <>
                {recentFilters.map((recent) => (
                  <Menu.Item
                    key={recent.id}
                    title={recent.label}
                    leadingIcon={
                      getFilterKey(recent.filters, recent.searchText) === currentRecentKey ? 'check' : undefined
                    }
                    onPress={() => {
                      onApplyRecent(recent.filters, recent.searchText);
                      close();
                    }}
                  />
                ))}
                <Divider />
                <Menu.Item
                  title={t('mobile.search.clearRecentSearches')}
                  onPress={() => {
                    onClearRecent();
                    close();
                  }}
                />
              </>
            )}
          </MenuChip>
        ) : null}

        {/* Grade → toggles the range rail overlay. */}
        {pinnedChips.includes('grade') ? (
          <Chip
            mode="outlined"
            selected={gradeActive}
            onPress={gradeRailOpen ? onCloseGrade : onOpenGrade}
            style={styles.chip}
          >
            {gradeLabel}
          </Chip>
        ) : null}

        {/* Grade accuracy ▾ — Off/Loose/Moderate/Tight single-choice. Opt-in. */}
        {pinnedChips.includes('accuracy') ? (
          <MenuChip
            label={accuracyValue === 'off' ? t('mobile.filter.accuracy.label') : accuracyChipLabel(accuracyValue, t)}
            selected={accuracyValue !== 'off'}
          >
            {(close) =>
              GRADE_ACCURACY_VALUES.map((value) => {
                const tagValue = value === '0' ? 'off' : value;
                return (
                  <Menu.Item
                    key={tagValue}
                    title={accuracyChipLabel(value, t)}
                    leadingIcon={tagValue === accuracyValue ? 'check' : undefined}
                    onPress={() => {
                      onChangeAccuracy(tagValue);
                      close();
                    }}
                  />
                );
              })
            }
          </MenuChip>
        ) : null}

        {/* Your progress ▾ — single-select over the four tick flags (auth-gated,
            the chip hides when signed out). Each item commits its value and closes. */}
        {canFilterProgress && pinnedChips.includes('progress') ? (
          <MenuChip
            label={progress === 'all' ? t('mobile.filter.progress.label') : progressFilterLabel(progress, t)}
            selected={progress !== 'all'}
          >
            {(close) => (
              <>
                {PROGRESS_FILTER_VALUES.map((value) => (
                  <Menu.Item
                    key={value}
                    title={progressFilterLabel(value, t)}
                    leadingIcon={value === progress ? 'check' : undefined}
                    onPress={() => {
                      onChangeProgress(value);
                      close();
                    }}
                  />
                ))}
              </>
            )}
          </MenuChip>
        ) : null}

        {/* Collection — Any / Benchmarks / My drafts single-select (My drafts is
            auth-gated, dropped from the menu when signed out). */}
        {pinnedChips.includes('collection') ? (
          <MenuChip
            label={collection === 'any' ? t('mobile.filter.collection.label') : collectionChipLabel(collection, t)}
            selected={collection !== 'any'}
          >
            {(close) =>
              COLLECTION_VALUES.filter((value) => value !== 'drafts' || canFilterDrafts).map((value) => (
                <Menu.Item
                  key={value}
                  title={collectionChipLabel(value, t)}
                  leadingIcon={value === collection ? 'check' : undefined}
                  onPress={() => {
                    onChangeCollection(value);
                    close();
                  }}
                />
              ))
            }
          </MenuChip>
        ) : null}

        {/* Climb type ▾ — Boulders / Routes / Both single-choice. Default is
            boulders-only, so the resting chip reads "Climb type". Opt-in. */}
        {pinnedChips.includes('climbType') ? (
          <MenuChip
            label={climbType === 'boulders' ? t('mobile.filter.climbType') : climbTypeChipLabel(climbType, t)}
            selected={climbType !== 'boulders'}
          >
            {(close) =>
              (['boulders', 'routes', 'both'] as const).map((value) => (
                <Menu.Item
                  key={value}
                  title={climbTypeChipLabel(value, t)}
                  leadingIcon={value === climbType ? 'check' : undefined}
                  onPress={() => {
                    onChangeClimbType(value);
                    close();
                  }}
                />
              ))
            }
          </MenuChip>
        ) : null}

        {/* Shape — one chip grouping the independent Tall + Wide toggles (a climb
            can be both). The menu stays open so both can be toggled. Shown only
            when the board size has the expansion. */}
        {pinnedChips.includes('shape') && dimensionChips.length > 0 ? (
          <MenuChip label={t('mobile.filter.shape')} selected={dimensionChips.some((dimension) => dimension.active)}>
            {() =>
              dimensionChips.map((dimension) => (
                <Menu.Item
                  key={dimension.key}
                  title={dimension.key === 'tall' ? t('mobile.search.chips.tall') : t('mobile.search.chips.wide')}
                  leadingIcon={dimension.active ? 'check' : undefined}
                  onPress={dimension.onToggle}
                />
              ))
            }
          </MenuChip>
        ) : null}

        {/* Beta videos — a plain on/off toggle chip. Opt-in. */}
        {pinnedChips.includes('beta') ? (
          <Chip mode="outlined" selected={betaActive} onPress={onToggleBeta} style={styles.chip}>
            {t('mobile.filter.betaVideos')}
          </Chip>
        ) : null}

        {/* Popularity — single-choice min-ascents buckets. */}
        {pinnedChips.includes('popularity') ? (
          <MenuChip
            label={hasActivePopularity ? popularityChipLabel(minAscents, t) : t('mobile.filter.popularity')}
            selected={hasActivePopularity}
          >
            {(close) =>
              POPULARITY_BUCKETS.map((bucket) => (
                <Menu.Item
                  key={bucket ?? 'any'}
                  title={popularityChipLabel(bucket, t)}
                  leadingIcon={bucket === minAscents ? 'check' : undefined}
                  onPress={() => {
                    onChangePopularity(bucket);
                    close();
                  }}
                />
              ))
            }
          </MenuChip>
        ) : null}

        {/* Min rating — single-choice star buckets. */}
        {pinnedChips.includes('rating') ? (
          <MenuChip
            label={hasActiveRating ? ratingChipLabel(minRating, t) : t('mobile.filter.minRating')}
            selected={hasActiveRating}
          >
            {(close) =>
              RATING_BUCKETS.map((bucket) => (
                <Menu.Item
                  key={bucket ?? 'any'}
                  title={ratingChipLabel(bucket, t)}
                  leadingIcon={bucket === minRating ? 'check' : undefined}
                  onPress={() => {
                    onChangeRating(bucket);
                    close();
                  }}
                />
              ))
            }
          </MenuChip>
        ) : null}

        {/* Sort ▾ — single-choice sort keys (direction stays sheet-only). Picking
            Random reseeds a fresh shuffle. Opt-in, sits last. */}
        {pinnedChips.includes('sort') ? (
          <MenuChip
            label={sortActive ? (sortLabelFor?.(sortBy) ?? sortBy) : t('mobile.filter.sortBy')}
            selected={sortActive}
          >
            {(close) =>
              SORT_OPTIONS.map((value) => (
                <Menu.Item
                  key={value}
                  title={sortLabelFor?.(value) ?? value}
                  leadingIcon={value === sortBy ? 'check' : undefined}
                  onPress={() => {
                    onChangeSort(value);
                    close();
                  }}
                />
              ))
            }
          </MenuChip>
        ) : null}
      </ScrollView>
      {canAdjustAngle && activeBoard ? (
        <AngleSelectorSheet
          visible={angleSheetVisible}
          onClose={closeAngle}
          boardName={activeBoard.boardType}
          layoutId={activeBoard.layoutId}
          currentAngle={activeBoard.angle}
          onAngleChange={changeAngle}
        />
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[2],
  },
  chip: {
    marginRight: 0,
  },
});

export const FilterChipRow = memo(FilterChipRowComponent);
