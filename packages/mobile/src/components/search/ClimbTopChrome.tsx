// Top chrome for the climbs list. The board glyph, glass action islands and the
// angle / lightbulb controls are shared with the Discover chrome via
// CollapsingTopChrome (`../chrome`) so both tabs read as one system: on the
// liquid-glass variant this file delegates to CollapsingTopChrome (left/right
// glass islands over the progressive blur) and adds the climbs-only search row.
// Climbs is the one tab that keeps a header title — the filter summary sits
// persistently in the centre. The Material variant keeps a dedicated
// Appbar.Header with the board as its subtitle plus grade / filter quick chips.

import { type ReactNode, type RefObject, useCallback } from 'react';
import { Keyboard, type LayoutChangeEvent, StyleSheet, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { Appbar, Chip } from 'react-native-paper';
import type { Grade } from '@boardsesh/shared-schema';
import type { GradeBound, GradeTapMeta } from '@boardsesh/climb-filters';
import { useTheme } from '../../providers/theme-provider';
import { useActiveBoard } from '../../lib/graphql/use-active-board';
import { selectByVariant } from '../../theme/variants';
import { spacing } from '../../theme/tokens';
import { SearchHeader, type SearchHeaderHandle } from '../SearchHeader';
import { iconMap } from '../icon-map';
import { BoardSwitcherButton, CollapsingTopChrome, MaterialAngleChip, TOP_ACTION_SIZE } from '../chrome';
import { GradeRangeRail } from '../grade';
import { UserAvatarToolbarAction } from '../user-drawer/UserAvatarToolbarAction';
import { WallStatusCapsule } from '../queue-control/WallStatusCapsule';
import { useWallClimbIfDistinct } from '../queue-control/use-wall-or-queue-climb';
import { useActiveClimbUuid } from '../../providers/queue-provider';
import { FilterButton } from './FilterButton';
import { GradeFilterControl } from './GradeFilterControl';

// One 48dp baseline shared by the search field, the grade control, and the filter
// button so the row reads as a matched set (M3 docked/inline height).
const MATERIAL_SEARCH_HEIGHT = 48;

type ClimbTopChromeProps = {
  searchMode?: 'custom' | 'native';
  /** Optional persistent plain centre title (the legacy filter summary, e.g.
   *  "V4–V6 · Quality"). Omitted when the persistent filter chips carry the filter
   *  state — the centre then reads empty (the redundant "All climbs" label is
   *  dropped). Unused by the Material variant. */
  title?: string;
  canCreate: boolean;
  onCreate: () => void;
  onOpenBoardDetail: () => void;
  /** Show a brand-coloured dot on the board button — the one-time onboarding cue
   *  pointing a new user at the "now on the wall" sheet. */
  showBoardBadge?: boolean;
  onHeightChange: (height: number) => void;
  searchFieldRef: RefObject<SearchHeaderHandle | null>;
  searchInitialValue: string;
  searchPlaceholder: string;
  onSearchChange: (text: string) => void;
  onSearchFocus: () => void;
  onSearchBlur: () => void;
  onCloseGrade: () => void;
  /** Active-filter count for the Material variant's filter button (rendered to
   *  the left of the search field — the affordance the native search bar can't
   *  host). Liquid Glass keeps the bottom filter FAB instead. */
  activeFilterCount?: number;
  onOpenFilters?: () => void;
  /** Active-filter summary shown as a chip in the Material quick row. Tapping it
   *  clears the (non-grade) filters. Absent = no filters. */
  filterSummary?: { text: string; onClear: () => void };
  gradeBound?: GradeBound;
  grades?: readonly Grade[];
  /** Last-used grade id; centres an unselected rail on a familiar grade. */
  lastUsedGradeId?: number;
  gradeRailVisible?: boolean;
  gradeChip?: { label: string; active: boolean; onClear?: () => void };
  onOpenGrade?: () => void;
  onGradeChange?: (grade: GradeBound, meta?: GradeTapMeta) => void;
  /** Persistent native filter-chip row + token row, rendered under the title on
   *  Liquid Glass, independent of search focus; null on the Material path. The
   *  caller composes it so every filter handler and the search-provider state
   *  stay in the screen, not drilled through here. */
  filterChrome?: ReactNode;
};

export function ClimbTopChrome({
  searchMode = 'custom',
  title,
  canCreate,
  onCreate,
  onOpenBoardDetail,
  showBoardBadge = false,
  onHeightChange,
  searchFieldRef,
  searchInitialValue,
  searchPlaceholder,
  onSearchChange,
  onSearchFocus,
  onSearchBlur,
  onCloseGrade,
  activeFilterCount = 0,
  onOpenFilters,
  filterSummary,
  gradeBound,
  grades = [],
  lastUsedGradeId,
  gradeRailVisible = false,
  gradeChip,
  onOpenGrade,
  onGradeChange,
  filterChrome,
}: ClimbTopChromeProps) {
  const { t } = useTranslation('climbs');
  const { systemColors, variant } = useTheme();
  const { data: activeBoard } = useActiveBoard();
  const insets = useSafeAreaInsets();
  const usesCustomSearch = searchMode === 'custom';
  // The Material angle control moved out of the (over-budget) app bar into the
  // quick row beside the grade/filter chips. Gate the quick row on it OR a filter
  // summary so the row never renders an empty gap.
  const angleAdjustable = activeBoard?.isAngleAdjustable !== false && activeBoard?.angle != null;

  // "On the wall" capsule: own the gate here so a falsy centre slot falls back to
  // the title, and the capsule gets a clean mount/unmount (entering/exiting fade).
  // Only present when a board feed lights a climb that differs from the user's own
  // current climb (hidden in the solo case).
  const currentClimbUuid = useActiveClimbUuid();
  const wallClimb = useWallClimbIfDistinct(currentClimbUuid);
  const wallCapsule = wallClimb ? <WallStatusCapsule climb={wallClimb} /> : undefined;

  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => onHeightChange(event.nativeEvent.layout.height),
    [onHeightChange],
  );

  const handleCloseOverlays = useCallback(() => {
    searchFieldRef.current?.blur();
    Keyboard.dismiss();
    onCloseGrade();
  }, [onCloseGrade, searchFieldRef]);

  useFocusEffect(useCallback(() => () => handleCloseOverlays(), [handleCloseOverlays]));

  const handleFocus = useCallback(() => {
    onCloseGrade();
    onSearchFocus();
  }, [onCloseGrade, onSearchFocus]);

  const handleBlur = useCallback(() => {
    onSearchBlur();
  }, [onSearchBlur]);

  const isMaterial = selectByVariant(variant, { material: true, liquidGlass: false });
  if (isMaterial) {
    const hasGradeFilter = gradeChip?.active === true;
    const nonGradeFilterCount = Math.max(0, activeFilterCount - (hasGradeFilter ? 1 : 0));
    const hasNonGradeFilters = nonGradeFilterCount > 0;
    const shouldShowFilterSummary = filterSummary != null && hasNonGradeFilters;
    const visibleFilterSummary = shouldShowFilterSummary ? filterSummary : null;
    const visibleGradeLabel = gradeChip?.label ?? t('mobile.filter.grade');

    return (
      <View
        pointerEvents="box-none"
        style={[
          styles.materialContainer,
          {
            paddingTop: insets.top,
            backgroundColor: systemColors.secondaryBackground,
            borderBottomColor: systemColors.separator,
          },
        ]}
        onLayout={handleLayout}
      >
        <Appbar.Header
          statusBarHeight={0}
          mode="small"
          elevated
          style={[styles.materialAppbar, { backgroundColor: systemColors.secondaryBackground }]}
        >
          <UserAvatarToolbarAction variant="material" />
          <BoardSwitcherButton
            onPress={onOpenBoardDetail}
            accessibilityHint={t('mobile.search.boardSwitcherHint')}
            badge={showBoardBadge}
          />
          {canCreate ? (
            <Appbar.Action
              icon={iconMap.plus.android}
              color={systemColors.label as string}
              onPress={onCreate}
              accessibilityLabel={t('mobile.create.fab.ariaLabel')}
            />
          ) : null}
          {/* Angle is a quick-row chip below (it re-grades the whole list — a list
              param, not an app-bar action). No toolbar lightbulb on the climbs tab
              either — board-LED control lives on the queue bar / current-climb pill
              (BoardControlIndicator), in step with the glass `hideLight`. */}
        </Appbar.Header>

        {/* "On the wall" status — a compact capsule in a slim centred row under the
            app bar (M3 has no centre-slot in the bar), only when a board feed lights
            a climb that differs from the user's own queue head. */}
        {wallCapsule ? (
          <View pointerEvents="box-none" style={styles.materialWallStatusRow}>
            {wallCapsule}
          </View>
        ) : null}

        {usesCustomSearch ? (
          <View pointerEvents="box-none" style={styles.materialSearchStack}>
            <View pointerEvents="box-none" style={styles.materialSearchRow}>
              <View pointerEvents="box-none" style={styles.materialSearchSlot}>
                <SearchHeader
                  ref={searchFieldRef}
                  initialValue={searchInitialValue}
                  placeholder={searchPlaceholder}
                  onChangeText={onSearchChange}
                  onFocus={handleFocus}
                  onBlur={handleBlur}
                  height={MATERIAL_SEARCH_HEIGHT}
                />
              </View>
              <GradeFilterControl
                label={visibleGradeLabel}
                active={hasGradeFilter}
                expanded={gradeRailVisible}
                height={MATERIAL_SEARCH_HEIGHT}
                onPress={() => {
                  if (gradeRailVisible) {
                    onCloseGrade();
                    return;
                  }
                  onOpenGrade?.();
                }}
                onClear={hasGradeFilter ? gradeChip?.onClear : undefined}
                toggleAccessibilityLabel={t('mobile.search.gradeAction')}
                clearAccessibilityLabel={t('mobile.gradeRail.clearFilterAria')}
                openHint={t('mobile.search.gradeOpenHint')}
                closeHint={t('mobile.search.gradeCloseHint')}
              />
              {onOpenFilters ? <FilterButton activeFilterCount={nonGradeFilterCount} onPress={onOpenFilters} /> : null}
            </View>

            {angleAdjustable || visibleFilterSummary ? (
              <View pointerEvents="box-none" style={styles.materialQuickRow}>
                <MaterialAngleChip />
                {visibleFilterSummary ? (
                  <Chip
                    compact
                    mode="flat"
                    icon={iconMap.filter.android}
                    onPress={visibleFilterSummary.onClear}
                    onClose={visibleFilterSummary.onClear}
                    closeIcon={iconMap.close.android}
                    accessibilityLabel={visibleFilterSummary.text}
                    style={styles.materialChip}
                    textStyle={styles.materialChipText}
                  >
                    {visibleFilterSummary.text}
                  </Chip>
                ) : null}
              </View>
            ) : null}

            {gradeRailVisible && gradeBound && onGradeChange ? (
              <GradeRangeRail
                grades={grades}
                bound={gradeBound}
                lastUsedGradeId={lastUsedGradeId}
                onChange={onGradeChange}
                onRequestClose={onCloseGrade}
                dismissible={false}
                style={styles.materialGradeRail}
              />
            ) : null}
          </View>
        ) : null}
      </View>
    );
  }

  // Liquid-glass variant: the shared chrome (left/right glass islands over the
  // progressive blur) with the climbs-only search row as its below-row content.
  // Climbs is the one tab that keeps a header title — the filter summary sits
  // persistently in the centre via `centerTitle`.
  //
  // `hideLight`: the climbs tab suppresses the toolbar BLE lightbulb. Board-LED
  // control already lives on the queue bar / current-climb pill
  // (BoardControlIndicator); a second bulb in the top-right island reads like a
  // list/filter affordance next to the filter chips and confused users. Discover
  // and the other chromes keep their bulb.
  return (
    <CollapsingTopChrome
      centerTitle={title}
      // "On the wall" status — a compact capsule in the centre islands slot (where
      // the title used to sit) when a board feed lights a climb that differs from
      // the user's own current climb; otherwise undefined, so the centre falls back
      // to the title.
      centerContent={wallCapsule}
      canCreate={canCreate}
      onCreate={onCreate}
      createAccessibilityLabel={t('mobile.create.fab.ariaLabel')}
      onOpenBoardSwitcher={onOpenBoardDetail}
      boardBadge={showBoardBadge}
      onHeightChange={onHeightChange}
      hideLight
    >
      {usesCustomSearch ? (
        <View pointerEvents="box-none" style={styles.searchStack}>
          <View pointerEvents="box-none" style={styles.searchRow}>
            <View pointerEvents="box-none" style={styles.searchSlot}>
              <SearchHeader
                ref={searchFieldRef}
                initialValue={searchInitialValue}
                placeholder={searchPlaceholder}
                onChangeText={onSearchChange}
                onFocus={handleFocus}
                onBlur={handleBlur}
                height={TOP_ACTION_SIZE}
              />
            </View>
          </View>
        </View>
      ) : null}
      {/* Persistent filter chips sit under the title on every glass path —
          including the iOS 26 native-search path (no custom search row) — so
          filtering is always glanceable, never gated behind keyboard focus. */}
      {filterChrome}
    </CollapsingTopChrome>
  );
}

const styles = StyleSheet.create({
  searchStack: {
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[2],
    gap: spacing[2],
  },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing[2],
  },
  searchSlot: {
    flex: 1,
    flexDirection: 'row',
    minWidth: 0,
  },
  materialContainer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 20,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  materialAppbar: {
    elevation: 0,
    shadowOpacity: 0,
  },
  materialWallStatusRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: spacing[4],
    paddingBottom: spacing[2],
  },
  materialSearchStack: {
    paddingHorizontal: spacing[4],
    paddingBottom: spacing[3],
    gap: spacing[2],
  },
  materialSearchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
  materialSearchSlot: {
    // The search field flex-grows; the grade control and filter button are
    // intrinsic-width trailing affordances (M3 input + trailing controls row).
    flex: 1,
    minWidth: 0,
  },
  materialQuickRow: {
    minHeight: 36,
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: spacing[2],
  },
  materialChip: {
    minHeight: 32,
  },
  materialChipText: {
    fontWeight: '600',
  },
  materialGradeRail: {
    marginTop: spacing[1],
  },
});
