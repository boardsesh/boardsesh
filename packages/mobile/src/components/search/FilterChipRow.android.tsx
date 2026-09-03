// FilterChipRow — Android implementation. Native Jetpack Compose Material 3
// FilterChips + DropdownMenus via @expo/ui, mirroring the SwiftUI iOS reference
// (FilterChipRow.ios.tsx) one-for-one: same chip set, order, labels, and
// behaviour. The persistent, glanceable chip row is the Android (Material) filtering
// surface — the climbs screen suppresses the Material top-chrome filter affordances
// (grade control + filter button + summary) in its favour.
//
// Compose specifics that differ from the SwiftUI tree:
//   • DropdownMenu is CONTROLLED — each menu-bearing chip is its own small stateful
//     sub-component owning `expanded` (cf. MoreForm.android.tsx's SelectRow). The
//     chip's onClick opens it; an explicit close() in an item dismisses it.
//   • Single-select menus (Your progress, Popularity, Rating) close on pick by
//     calling the renderItems `close()`; a keep-open menu would simply not call it
//     (Compose has no menuActionDismissBehavior and doesn't auto-dismiss on click).
//   • Shape is a single MENU chip grouping the independent Tall + Wide toggles (a
//     climb can be both), like Popularity/Rating: tap opens a DropdownMenu with a
//     checkable item per dimension. It renders only when the board size has a
//     shorter/narrower sibling in its family (dimensionChips non-empty).
//   • Single-choice (Popularity/Rating) skips the iOS string-tag Picker round-trip:
//     each item's onClick closure carries the real `number | undefined` bucket.
// Labels reuse FilterChipRow.logic so a filter is never worded two ways across
// platforms; bucket sets come from the shared filter-chip-menus.

import { memo, useState, type ReactNode } from 'react';
import { StyleSheet, type ImageSourcePropType } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Host } from '@expo/ui';
import {
  Row,
  Text,
  Icon,
  FilterChip,
  DropdownMenu,
  DropdownMenuItem,
  HorizontalDivider,
} from '@expo/ui/jetpack-compose';
import { fillMaxWidth, horizontalScroll, padding } from '@expo/ui/jetpack-compose/modifiers';
import { PROGRESS_FILTER_VALUES, SORT_OPTIONS, GRADE_ACCURACY_VALUES } from '@boardsesh/climb-filters';
import { getFilterKey } from '../../lib/recent-filter-store';
import { POPULARITY_BUCKETS, RATING_BUCKETS } from '../../lib/filter-chip-menus';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';
import { filterChipBrandColors } from '../../theme/expo-ui-modifiers';
import { useMaterialAngleControl } from '../chrome/use-material-angle-control';
import { AngleSelectorSheet } from '../play-drawer/AngleSelectorSheet';
import {
  popularityChipLabel,
  ratingChipLabel,
  progressFilterLabel,
  collectionChipLabel,
  accuracyChipLabel,
  climbTypeChipLabel,
} from './FilterChipRow.logic';
import { buildSortLabel } from '../../lib/filter-labels';
import { COLLECTION_VALUES } from '../../lib/collection-filter';
import type { FilterChipRowProps } from './FilterChipRow.types';

// Semantic icon → Material XML vector drawable. White-filled (#FFFFFFFF) so the
// Compose `Icon` recolours them: inside a chip/menu slot the Icon inherits the
// content colour (brand on-fill when the chip is selected, the menu text colour in
// items), so no explicit tint is needed. Mirrors MORE_ICON_SOURCE in MoreForm.android.tsx.
const ICON = {
  tune: require('../../../assets/material-icons/tune.xml') as ImageSourcePropType,
  history: require('../../../assets/material-icons/history.xml') as ImageSourcePropType,
  check: require('../../../assets/material-icons/check.xml') as ImageSourcePropType,
  lock: require('../../../assets/material-icons/lock.xml') as ImageSourcePropType,
  lockOpen: require('../../../assets/material-icons/lock_open.xml') as ImageSourcePropType,
};

// M3 chip/menu leading-icon size.
const ICON_SIZE = 18;

type ChipColors = ReturnType<typeof filterChipBrandColors>;

// An action chip with no menu (Filters · N, Grade): tap fires onPress.
function ActionChip({
  label,
  selected,
  colors,
  iconSource,
  onPress,
}: {
  label: string;
  selected: boolean;
  colors: ChipColors;
  iconSource?: ImageSourcePropType;
  onPress: () => void;
}) {
  return (
    <FilterChip selected={selected} colors={colors} onClick={onPress}>
      {iconSource ? (
        <FilterChip.LeadingIcon>
          <Icon source={iconSource} size={ICON_SIZE} />
        </FilterChip.LeadingIcon>
      ) : null}
      <FilterChip.Label>
        <Text>{label}</Text>
      </FilterChip.Label>
    </FilterChip>
  );
}

// A chip that anchors a controlled DropdownMenu (Recent, Show, Popularity, Rating).
// `renderItems` is given a `close` so single-choice/destructive items can dismiss
// while keep-open toggle items simply don't call it.
function MenuChip({
  label,
  selected,
  colors,
  iconSource,
  renderItems,
}: {
  label: string;
  selected: boolean;
  colors: ChipColors;
  iconSource?: ImageSourcePropType;
  renderItems: (close: () => void) => ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <DropdownMenu expanded={expanded} onDismissRequest={() => setExpanded(false)}>
      <DropdownMenu.Trigger>
        <FilterChip selected={selected} colors={colors} onClick={() => setExpanded(true)}>
          {iconSource ? (
            <FilterChip.LeadingIcon>
              <Icon source={iconSource} size={ICON_SIZE} />
            </FilterChip.LeadingIcon>
          ) : null}
          <FilterChip.Label>
            <Text>{label}</Text>
          </FilterChip.Label>
        </FilterChip>
      </DropdownMenu.Trigger>
      <DropdownMenu.Items>{renderItems(() => setExpanded(false))}</DropdownMenu.Items>
    </DropdownMenu>
  );
}

// A single menu row: optional leading check, a text label, optional text colour
// (for the destructive Clear).
//
// The DropdownMenu popup is a separate Compose composition — the Host's
// `colorScheme` does not reach it, and a custom `Text` in an item slot does NOT
// inherit `DropdownMenuItem`'s content colour. Without an explicit scheme-aware
// colour the labels render dark-on-dark when the app runs dark on a light-mode
// device (same fix as AppMenu.android).
function MenuItem({
  label,
  checked,
  onClick,
  textColor,
  enabled,
}: {
  label: string;
  checked: boolean;
  onClick: () => void;
  textColor?: string;
  enabled?: boolean;
}) {
  const { systemColors } = useTheme();
  const itemColor = textColor ?? (systemColors.label as string);
  return (
    <DropdownMenuItem onClick={onClick} enabled={enabled} elementColors={{ textColor: itemColor }}>
      {checked ? (
        <DropdownMenuItem.LeadingIcon>
          <Icon source={ICON.check} size={ICON_SIZE} />
        </DropdownMenuItem.LeadingIcon>
      ) : null}
      <DropdownMenuItem.Text>
        <Text color={itemColor}>{label}</Text>
      </DropdownMenuItem.Text>
    </DropdownMenuItem>
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
  const { brandColors, colorScheme } = useTheme();
  const chipColors = filterChipBrandColors(brandColors);
  // Built once per render (and only when Sort is actually pinned), reused for the
  // resting label + all 7 menu items.
  const sortLabelFor = pinnedChips.includes('sort') ? buildSortLabel(t) : null;

  // Angle rides as the first chip: it re-grades the whole list, so it belongs with
  // the other list-refinement chips rather than in the app bar. Self-contained (reads
  // the active board, owns its own selector sheet); renders nothing for fixed-angle
  // boards. Android only — iOS keeps its toolbar angle island (see FilterChipRow.ios).
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
      {/* `colorScheme` keeps the Compose MaterialTheme on our in-app Light/Dark toggle.
          `matchContents={{ vertical: true }}` (NOT the boolean form) fills the parent
          width so the Row's `fillMaxWidth()` has a bounded width to scroll within, while
          height tracks the chip content — mirrors SwitchRow/SegmentedControl. */}
      <Host matchContents={{ vertical: true }} colorScheme={colorScheme} style={styles.host}>
        <Row
          modifiers={[fillMaxWidth(), horizontalScroll(), padding(spacing[4], spacing[2], spacing[4], spacing[2])]}
          verticalAlignment="center"
          horizontalArrangement={{ spacedBy: spacing[2] }}
        >
          {/* Angle → the angle picker. First chip; re-grades the list on change. Action
              chip, no menu; outlined like the resting filters. Hidden for fixed-angle boards. */}
          {canAdjustAngle && activeBoard ? (
            <ActionChip label={`${activeBoard.angle}°`} selected={false} colors={chipColors} onPress={openAngle} />
          ) : null}

          {/* Filters · N → the long-tail sheet. Action chip, no menu. */}
          <ActionChip
            label={filtersLabel}
            selected={activeFilterCount > 0}
            colors={chipColors}
            iconSource={ICON.tune}
            onPress={onOpenFilters}
          />

          {/* Recent ▾ — hidden when there are none. */}
          {recentFilters.length > 0 ? (
            <MenuChip
              label={t('mobile.search.recentFilters')}
              selected={false}
              colors={chipColors}
              iconSource={ICON.history}
              renderItems={(close) => (
                <>
                  {recentFilters.map((recent) => (
                    <MenuItem
                      key={recent.id}
                      label={recent.label}
                      checked={getFilterKey(recent.filters, recent.searchText) === currentRecentKey}
                      onClick={() => {
                        onApplyRecent(recent.filters, recent.searchText);
                        close();
                      }}
                    />
                  ))}
                  <HorizontalDivider />
                  <MenuItem
                    label={t('mobile.search.clearRecentSearches')}
                    checked={false}
                    textColor={brandColors.error}
                    onClick={() => {
                      onClearRecent();
                      close();
                    }}
                  />
                </>
              )}
            />
          ) : null}

          {/* Grade → the range rail overlay. Action chip, no menu; tap toggles the rail. */}
          {pinnedChips.includes('grade') ? (
            <ActionChip
              label={gradeLabel}
              selected={gradeActive}
              colors={chipColors}
              onPress={gradeRailOpen ? onCloseGrade : onOpenGrade}
            />
          ) : null}

          {/* Grade accuracy ▾ — Off/Loose/Moderate/Tight single-choice. Opt-in. */}
          {pinnedChips.includes('accuracy') ? (
            <MenuChip
              label={accuracyValue === 'off' ? t('mobile.filter.accuracy.label') : accuracyChipLabel(accuracyValue, t)}
              selected={accuracyValue !== 'off'}
              colors={chipColors}
              renderItems={(close) => (
                <>
                  {GRADE_ACCURACY_VALUES.map((value) => {
                    const tagValue = value === '0' ? 'off' : value;
                    return (
                      <MenuItem
                        key={tagValue}
                        label={accuracyChipLabel(value, t)}
                        checked={tagValue === accuracyValue}
                        onClick={() => {
                          onChangeAccuracy(tagValue);
                          close();
                        }}
                      />
                    );
                  })}
                </>
              )}
            />
          ) : null}

          {/* Your progress ▾ — single-select over the four tick flags (auth-gated,
            the chip hides when signed out). Each item commits its value and closes. */}
          {canFilterProgress && pinnedChips.includes('progress') ? (
            <MenuChip
              label={progress === 'all' ? t('mobile.filter.progress.label') : progressFilterLabel(progress, t)}
              selected={progress !== 'all'}
              colors={chipColors}
              renderItems={(close) => (
                <>
                  {PROGRESS_FILTER_VALUES.map((value) => (
                    <MenuItem
                      key={value}
                      label={progressFilterLabel(value, t)}
                      checked={value === progress}
                      onClick={() => {
                        onChangeProgress(value);
                        close();
                      }}
                    />
                  ))}
                </>
              )}
            />
          ) : null}

          {/* Collection — Any / Benchmarks / My drafts single-select (My drafts is
            auth-gated, dropped from the menu when signed out). */}
          {pinnedChips.includes('collection') ? (
            <MenuChip
              label={collection === 'any' ? t('mobile.filter.collection.label') : collectionChipLabel(collection, t)}
              selected={collection !== 'any'}
              colors={chipColors}
              renderItems={(close) => (
                <>
                  {COLLECTION_VALUES.filter((value) => value !== 'drafts' || canFilterDrafts).map((value) => (
                    <MenuItem
                      key={value}
                      label={collectionChipLabel(value, t)}
                      checked={value === collection}
                      onClick={() => {
                        onChangeCollection(value);
                        close();
                      }}
                    />
                  ))}
                </>
              )}
            />
          ) : null}

          {/* Climb type ▾ — Boulders / Routes / Both single-choice. Default is
              boulders-only, so the resting chip reads "Climb type". Opt-in. */}
          {pinnedChips.includes('climbType') ? (
            <MenuChip
              label={climbType === 'boulders' ? t('mobile.filter.climbType.label') : climbTypeChipLabel(climbType, t)}
              selected={climbType !== 'boulders'}
              colors={chipColors}
              renderItems={(close) => (
                <>
                  {(['boulders', 'routes', 'both'] as const).map((value) => (
                    <MenuItem
                      key={value}
                      label={climbTypeChipLabel(value, t)}
                      checked={value === climbType}
                      onClick={() => {
                        onChangeClimbType(value);
                        close();
                      }}
                    />
                  ))}
                </>
              )}
            />
          ) : null}

          {/* Shape — one chip grouping the independent Tall + Wide toggles (a climb
            can be both). The menu stays open so both can be toggled. Shown only when
            the board size has the expansion. */}
          {pinnedChips.includes('shape') && dimensionChips.length > 0 ? (
            <MenuChip
              label={t('mobile.filter.shape')}
              selected={dimensionChips.some((dimension) => dimension.active)}
              colors={chipColors}
              renderItems={() => (
                <>
                  {dimensionChips.map((dimension) => (
                    <MenuItem
                      key={dimension.key}
                      label={dimension.key === 'tall' ? t('mobile.search.chips.tall') : t('mobile.search.chips.wide')}
                      checked={dimension.active}
                      onClick={dimension.onToggle}
                    />
                  ))}
                </>
              )}
            />
          ) : null}

          {/* Beta videos — a plain on/off toggle (an action chip, no menu). Opt-in. */}
          {pinnedChips.includes('beta') ? (
            <ActionChip
              label={t('mobile.filter.betaVideos')}
              selected={betaActive}
              colors={chipColors}
              onPress={onToggleBeta}
            />
          ) : null}

          {/* Popularity ▾ — single-choice min-ascents buckets. */}
          {pinnedChips.includes('popularity') ? (
            <MenuChip
              label={hasActivePopularity ? popularityChipLabel(minAscents, t) : t('mobile.filter.popularity')}
              selected={hasActivePopularity}
              colors={chipColors}
              renderItems={(close) => (
                <>
                  {POPULARITY_BUCKETS.map((bucket) => (
                    <MenuItem
                      key={bucket ?? 'any'}
                      label={popularityChipLabel(bucket, t)}
                      checked={bucket === minAscents}
                      onClick={() => {
                        onChangePopularity(bucket);
                        close();
                      }}
                    />
                  ))}
                </>
              )}
            />
          ) : null}

          {/* Min rating ▾ — single-choice star buckets. */}
          {pinnedChips.includes('rating') ? (
            <MenuChip
              label={hasActiveRating ? ratingChipLabel(minRating, t) : t('mobile.filter.minRating')}
              selected={hasActiveRating}
              colors={chipColors}
              renderItems={(close) => (
                <>
                  {RATING_BUCKETS.map((bucket) => (
                    <MenuItem
                      key={bucket ?? 'any'}
                      label={ratingChipLabel(bucket, t)}
                      checked={bucket === minRating}
                      onClick={() => {
                        onChangeRating(bucket);
                        close();
                      }}
                    />
                  ))}
                </>
              )}
            />
          ) : null}

          {/* Sort ▾ — single-choice sort keys (direction stays sheet-only). Picking
              Random reseeds a fresh shuffle. Opt-in, sits last. */}
          {pinnedChips.includes('sort') ? (
            <MenuChip
              label={sortActive ? (sortLabelFor?.(sortBy) ?? sortBy) : t('mobile.filter.sortBy')}
              selected={sortActive}
              colors={chipColors}
              renderItems={(close) => (
                <>
                  {SORT_OPTIONS.map((value) => (
                    <MenuItem
                      key={value}
                      label={sortLabelFor?.(value) ?? value}
                      checked={value === sortBy}
                      onClick={() => {
                        onChangeSort(value);
                        close();
                      }}
                    />
                  ))}
                </>
              )}
            />
          ) : null}
        </Row>
      </Host>
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
  host: {
    width: '100%',
    // RN Android installs a background drawable even for a transparent colour, which
    // makes the Host itself an RNGH hit-test target (shouldHandlerlessViewBecomeTouchTarget)
    // if a future refactor reintroduces a box-none ancestor. Zero visual effect.
    backgroundColor: 'transparent',
  },
});

export const FilterChipRow = memo(FilterChipRowComponent);
