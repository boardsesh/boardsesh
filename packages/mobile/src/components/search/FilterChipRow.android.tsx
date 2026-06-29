// FilterChipRow — Android implementation. Native Jetpack Compose Material 3
// FilterChips + DropdownMenus via @expo/ui, mirroring the SwiftUI iOS reference
// (FilterChipRow.ios.tsx) one-for-one: same chip set, order, labels, and
// behaviour. The persistent, glanceable chip row is the Android (Material) default
// filtering surface — the climbs screen suppresses the Material top-chrome filter
// affordances while it's shown (gated by the `android-filter-chips` kill-switch).
//
// Compose specifics that differ from the SwiftUI tree:
//   • DropdownMenu is CONTROLLED — each menu-bearing chip is its own small stateful
//     sub-component owning `expanded` (cf. MoreForm.android.tsx's SelectRow). The
//     chip's onClick opens it; an explicit close() in an item dismisses it.
//   • The "Show" menu stays open while toggling simply by NOT closing the controlled
//     menu on a toggle item's click — Compose has no menuActionDismissBehavior and
//     doesn't auto-dismiss on click, so this is the natural equivalent.
//   • Dimension chips reconstruct iOS's Menu+onPrimaryAction (tap toggles, long-press
//     opens lock/unlock) from `combinedClickable`. The chip carries no `onClick`, so
//     the modifier owns both gestures — avoiding the FilterChip-onClick-vs-
//     combinedClickable conflict. A locked chip keeps firing onToggle on tap, but the
//     shared `useDimensionRepin` in the climbs screen re-pins it, so the filter stays
//     active (the same "locked ignores tap" outcome as iOS).
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
import { combinedClickable, fillMaxWidth, horizontalScroll, padding } from '@expo/ui/jetpack-compose/modifiers';
import { getFilterKey } from '../../lib/recent-filter-store';
import { POPULARITY_BUCKETS, RATING_BUCKETS } from '../../lib/filter-chip-menus';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';
import { filterChipBrandColors } from '../../theme/expo-ui-modifiers';
import { popularityChipLabel, ratingChipLabel } from './FilterChipRow.logic';
import type { DimensionChip, FilterChipRowProps } from './FilterChipRow.types';

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
function MenuItem({
  label,
  checked,
  onClick,
  textColor,
}: {
  label: string;
  checked: boolean;
  onClick: () => void;
  textColor?: string;
}) {
  return (
    <DropdownMenuItem onClick={onClick} elementColors={textColor ? { textColor } : undefined}>
      {checked ? (
        <DropdownMenuItem.LeadingIcon>
          <Icon source={ICON.check} size={ICON_SIZE} />
        </DropdownMenuItem.LeadingIcon>
      ) : null}
      <DropdownMenuItem.Text>
        <Text>{label}</Text>
      </DropdownMenuItem.Text>
    </DropdownMenuItem>
  );
}

// Tall / Wide board-shape chip: tap toggles the filter, long-press opens a
// lock/unlock menu. `combinedClickable` owns both gestures (no FilterChip.onClick),
// avoiding the documented onClick-vs-combinedClickable conflict.
function DimensionChipView({
  dimension,
  label,
  colors,
  lockLabel,
  unlockLabel,
}: {
  dimension: DimensionChip;
  label: string;
  colors: ChipColors;
  lockLabel: string;
  unlockLabel: string;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <DropdownMenu expanded={expanded} onDismissRequest={() => setExpanded(false)}>
      <DropdownMenu.Trigger>
        <FilterChip
          selected={dimension.active}
          colors={colors}
          modifiers={[combinedClickable({ onClick: dimension.onToggle, onLongClick: () => setExpanded(true) })]}
        >
          {dimension.locked ? (
            <FilterChip.LeadingIcon>
              <Icon source={ICON.lock} size={ICON_SIZE} />
            </FilterChip.LeadingIcon>
          ) : null}
          <FilterChip.Label>
            <Text>{label}</Text>
          </FilterChip.Label>
        </FilterChip>
      </DropdownMenu.Trigger>
      <DropdownMenu.Items>
        <DropdownMenuItem
          onClick={() => {
            dimension.onToggleLock();
            setExpanded(false);
          }}
        >
          <DropdownMenuItem.LeadingIcon>
            <Icon source={dimension.locked ? ICON.lockOpen : ICON.lock} size={ICON_SIZE} />
          </DropdownMenuItem.LeadingIcon>
          <DropdownMenuItem.Text>
            <Text>{dimension.locked ? unlockLabel : lockLabel}</Text>
          </DropdownMenuItem.Text>
        </DropdownMenuItem>
      </DropdownMenu.Items>
    </DropdownMenu>
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
  dimensionChips,
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
  const { brandColors, colorScheme } = useTheme();
  const chipColors = filterChipBrandColors(brandColors);

  const currentRecentKey = getFilterKey(currentFilters, currentSearchText);
  const hasActivePopularity = minAscents != null;
  const hasActiveRating = minRating != null;

  const filtersLabel =
    activeFilterCount > 0
      ? t('mobile.search.chips.filtersWithCount', { count: activeFilterCount })
      : t('mobile.filter.title');

  return (
    // `colorScheme` keeps the Compose MaterialTheme on our in-app Light/Dark toggle.
    // `matchContents={{ vertical: true }}` (NOT the boolean form) fills the parent
    // width so the Row's `fillMaxWidth()` has a bounded width to scroll within, while
    // height tracks the chip content — mirrors SwitchRow/SegmentedControl.
    <Host matchContents={{ vertical: true }} colorScheme={colorScheme} style={styles.host}>
      <Row
        modifiers={[fillMaxWidth(), horizontalScroll(), padding(spacing[4], spacing[2], spacing[4], spacing[2])]}
        verticalAlignment="center"
        horizontalArrangement={{ spacedBy: spacing[2] }}
      >
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

        {/* Grade → the range rail overlay. Action chip, no menu. */}
        <ActionChip label={gradeLabel} selected={gradeActive} colors={chipColors} onPress={onOpenGrade} />

        {/* Show ▾ — hide-sent (auth-gated) + benchmarks. The controlled menu stays
            OPEN while toggling (these items don't call close()). */}
        <MenuChip
          label={t('mobile.search.chips.show')}
          selected={hideCompleted || onlyBenchmarks}
          colors={chipColors}
          renderItems={() => (
            <>
              {canHideCompleted ? (
                <MenuItem
                  label={t('mobile.filter.hideSent')}
                  checked={hideCompleted}
                  onClick={() => onToggleHideCompleted(!hideCompleted)}
                />
              ) : null}
              <MenuItem
                label={t('mobile.filter.benchmark')}
                checked={onlyBenchmarks}
                onClick={() => onToggleBenchmarks(!onlyBenchmarks)}
              />
            </>
          )}
        />

        {/* Tall / Wide — board-shape chips for the current Kilter homewall size
            (empty otherwise). Tap toggles; long-press opens lock/unlock. */}
        {dimensionChips.map((dimension) => (
          <DimensionChipView
            key={dimension.key}
            dimension={dimension}
            label={dimension.key === 'tall' ? t('mobile.search.chips.tall') : t('mobile.search.chips.wide')}
            colors={chipColors}
            lockLabel={t('mobile.search.chips.lock')}
            unlockLabel={t('mobile.search.chips.unlock')}
          />
        ))}

        {/* Popularity ▾ — single-choice min-ascents buckets. */}
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

        {/* Min rating ▾ — single-choice star buckets. */}
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
      </Row>
    </Host>
  );
}

const styles = StyleSheet.create({
  host: {
    width: '100%',
  },
});

export const FilterChipRow = memo(FilterChipRowComponent);
