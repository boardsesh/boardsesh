// FilterChipRow — web implementation (react-native-web + react-native-paper). The
// persistent, horizontally-scrolling filter-chip row, built from Paper Material 3
// `Chip`s + `Menu`s — the Material counterpart to the Compose FilterChips +
// DropdownMenus in FilterChipRow.android.tsx.
//
// It renders and drives the complete Material chip set, including the active
// board's angle selector for adjustable walls.
// Chip wording is sourced from FilterChipRow.logic so a filter is never worded two
// ways across platforms; the bucket sets come from the shared filter-chip-menus.

import { memo, useState, type ReactNode } from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Chip, Divider, Menu } from 'react-native-paper';
import { PROGRESS_FILTER_VALUES } from '@boardsesh/climb-filters';
import { getFilterKey } from '../../lib/recent-filter-store';
import { POPULARITY_BUCKETS, RATING_BUCKETS } from '../../lib/filter-chip-menus';
import { spacing } from '../../theme/tokens';
import { useMaterialAngleControl } from '../chrome/use-material-angle-control';
import { AngleSelectorSheet } from '../play-drawer/AngleSelectorSheet';
import { popularityChipLabel, progressFilterLabel, ratingChipLabel } from './FilterChipRow.logic';
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
  onlyBenchmarks,
  onToggleBenchmarks,
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
        <Chip
          mode="outlined"
          selected={gradeActive}
          onPress={gradeRailOpen ? onCloseGrade : onOpenGrade}
          style={styles.chip}
        >
          {gradeLabel}
        </Chip>

        {/* Your progress ▾ — single-select over the four tick flags (auth-gated,
            the chip hides when signed out). Each item commits its value and closes,
            mirroring FilterChipRow.android.tsx. */}
        {canFilterProgress ? (
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

        {/* Benchmarks — its own toggle chip (a tap flips it), no longer folded in
            with progress. */}
        <Chip
          mode="outlined"
          selected={onlyBenchmarks}
          onPress={() => onToggleBenchmarks(!onlyBenchmarks)}
          style={styles.chip}
        >
          {t('mobile.filter.benchmark')}
        </Chip>

        {/* Tall / Wide — board-shape chips for the current Kilter homewall size. */}
        {dimensionChips.map((dimension) => (
          <MenuChip
            key={dimension.key}
            label={dimension.key === 'tall' ? t('mobile.search.chips.tall') : t('mobile.search.chips.wide')}
            selected={dimension.active}
            icon={dimension.locked ? 'lock' : undefined}
          >
            {(close) => (
              <>
                <Menu.Item
                  title={dimension.key === 'tall' ? t('mobile.filter.tall') : t('mobile.filter.wide')}
                  leadingIcon={dimension.active ? 'check' : undefined}
                  disabled={dimension.locked}
                  onPress={() => {
                    dimension.onToggle();
                    close();
                  }}
                />
                <Divider />
                <Menu.Item
                  title={dimension.locked ? t('mobile.search.chips.unlock') : t('mobile.search.chips.lock')}
                  leadingIcon={dimension.locked ? 'lock-open-variant' : 'lock'}
                  onPress={() => {
                    dimension.onToggleLock();
                    close();
                  }}
                />
              </>
            )}
          </MenuChip>
        ))}

        {/* Popularity — single-choice min-ascents buckets. */}
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

        {/* Min rating — single-choice star buckets. */}
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
