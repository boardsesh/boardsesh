// Top chrome for the climbs list. The board pill, glass action islands and the
// angle / lightbulb controls are shared with the Discover chrome via
// CollapsingTopChrome (`../chrome`) so both tabs read as one system: on the
// liquid-glass variant this file delegates to CollapsingTopChrome (centred board
// pill that collapses into a filter title on scroll) and adds the climbs-only
// search row. The Material variant keeps a dedicated Appbar.Header with the board
// as its subtitle plus grade / filter quick chips.

import { type RefObject, useCallback, useState } from 'react';
import { Keyboard, type LayoutChangeEvent, StyleSheet, View } from 'react-native';
import { type SharedValue } from 'react-native-reanimated';
import { useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { Appbar, Chip } from 'react-native-paper';
import type { Grade } from '@boardsesh/shared-schema';
import type { GradeBound } from '@boardsesh/climb-filters';
import { useTheme } from '../../providers/theme-provider';
import { useQueueSessionId } from '../../providers/queue-provider';
import { useActiveBoard, useSetActiveBoard } from '../../lib/graphql/use-active-board';
import { useRepTimerPreference } from '../../lib/rep-timer-preference';
import { spacing } from '../../theme/tokens';
import { hapticLight } from '../../lib/haptics';
import { useLightbulbToggle } from '../ble/use-lightbulb-toggle';
import { SearchHeader, type SearchHeaderHandle } from '../SearchHeader';
import { Text } from '../Text';
import { iconMap } from '../icon-map';
import { BoardSwitcherButton, CollapsingTopChrome, TOP_ACTION_SIZE } from '../chrome';
import { GradeRangeRail } from '../grade';
import { AngleSelectorSheet } from '../play-drawer/AngleSelectorSheet';
import { RepTimerHeaderPill } from '../queue-control/RepTimerCapsule';
import { UserAvatarToolbarAction } from '../user-drawer/UserAvatarToolbarAction';
import { FilterButton } from './FilterButton';
import { GradeFilterControl } from './GradeFilterControl';

// One 48dp baseline shared by the search field, the grade control, and the filter
// button so the row reads as a matched set (M3 docked/inline height).
const MATERIAL_SEARCH_HEIGHT = 48;

type ClimbTopChromeProps = {
  searchMode?: 'custom' | 'native';
  /** Title for the collapsed glass header capsule — the active filter summary, or
   *  "All climbs" when no filter is active. The caller renders the matching large
   *  in-body title at the top of the list. (Unused by the Material variant.) */
  title: string;
  canCreate: boolean;
  onCreate: () => void;
  onOpenBoardDetail: () => void;
  onHeightChange: (height: number) => void;
  /** List scroll offset, driving the glass title collapse. */
  scrollY: SharedValue<number>;
  /** Tapping the collapsed glass title scrolls the list back to the top. */
  onPressTitle: () => void;
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
  gradeRailVisible?: boolean;
  gradeChip?: { label: string; active: boolean; onClear?: () => void };
  onOpenGrade?: () => void;
  onGradeChange?: (grade: GradeBound) => void;
};

export function ClimbTopChrome({
  searchMode = 'custom',
  title,
  canCreate,
  onCreate,
  onOpenBoardDetail,
  onHeightChange,
  scrollY,
  onPressTitle,
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
  gradeRailVisible = false,
  gradeChip,
  onOpenGrade,
  onGradeChange,
}: ClimbTopChromeProps) {
  const { t } = useTranslation('climbs');
  const { systemColors, variant } = useTheme();
  const insets = useSafeAreaInsets();
  const usesCustomSearch = searchMode === 'custom';
  const { sessionId } = useQueueSessionId();
  const { targetSeconds, loaded: repTimerPreferenceLoaded } = useRepTimerPreference();
  const showHeaderRepTimer = sessionId !== null && repTimerPreferenceLoaded && targetSeconds !== null;

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

  if (variant === 'material') {
    const hasGradeFilter = gradeChip?.active === true;
    const nonGradeFilterCount = Math.max(0, activeFilterCount - (hasGradeFilter ? 1 : 0));
    const hasNonGradeFilters = nonGradeFilterCount > 0;
    const shouldShowFilterSummary = filterSummary != null && hasNonGradeFilters;
    const visibleFilterSummary = shouldShowFilterSummary ? filterSummary : null;
    const visibleGradeLabel = gradeChip?.label ?? t('mobile.filter.gradeRange');

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
          {showHeaderRepTimer ? (
            <>
              <View style={styles.materialTitleSpacer} />
              <View pointerEvents="box-none" style={styles.materialTimerOverlay}>
                <RepTimerHeaderPill />
              </View>
            </>
          ) : (
            <BoardSwitcherButton onPress={onOpenBoardDetail} accessibilityHint={t('mobile.search.boardSwitcherHint')} />
          )}
          {canCreate ? (
            <Appbar.Action
              icon={iconMap.plus.android}
              color={systemColors.label as string}
              onPress={onCreate}
              accessibilityLabel={t('mobile.create.fab.ariaLabel')}
            />
          ) : null}
          <MaterialAngleAction />
          <MaterialLightbulbAction />
        </Appbar.Header>

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

            {visibleFilterSummary ? (
              <View pointerEvents="box-none" style={styles.materialQuickRow}>
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
              </View>
            ) : null}

            {gradeRailVisible && gradeBound && onGradeChange ? (
              <GradeRangeRail
                grades={grades}
                bound={gradeBound}
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

  // Liquid-glass variant: the shared collapsing chrome (centred board pill that
  // collapses into the filter title, board glyph docking into the toolbar) with
  // the climbs-only search row as its below-row content.
  return (
    <CollapsingTopChrome
      title={title}
      canCreate={canCreate}
      onCreate={onCreate}
      createAccessibilityLabel={t('mobile.create.fab.ariaLabel')}
      onOpenBoardSwitcher={onOpenBoardDetail}
      onHeightChange={onHeightChange}
      scrollY={scrollY}
      onPressTitle={onPressTitle}
      persistentCenterContent={showHeaderRepTimer ? <RepTimerHeaderPill /> : undefined}
      hideLight={showHeaderRepTimer}
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
    </CollapsingTopChrome>
  );
}

function MaterialAngleAction() {
  const { systemColors } = useTheme();
  const { t: tSession } = useTranslation('session');
  const { data: activeBoard } = useActiveBoard();
  const setActiveBoard = useSetActiveBoard();
  const [visible, setVisible] = useState(false);

  const canAdjust = activeBoard?.isAngleAdjustable !== false && activeBoard?.angle != null;
  const angleIcon = useCallback(
    () => (
      <Text variant="caption1" style={[styles.materialAngleText, { color: systemColors.label }]}>
        {activeBoard?.angle}°
      </Text>
    ),
    [activeBoard?.angle, systemColors.label],
  );
  const handleOpen = useCallback(() => {
    if (!activeBoard || activeBoard.isAngleAdjustable === false || activeBoard.angle == null) return;
    hapticLight();
    setVisible(true);
  }, [activeBoard]);
  const handleClose = useCallback(() => setVisible(false), []);
  const handleAngleChange = useCallback(
    (newAngle: number) => {
      if (!activeBoard || activeBoard.isAngleAdjustable === false || newAngle === activeBoard.angle) return;
      void setActiveBoard({ ...activeBoard, angle: newAngle });
    },
    [activeBoard, setActiveBoard],
  );

  if (!activeBoard || !canAdjust) return null;

  return (
    <>
      <Appbar.Action
        icon={angleIcon}
        onPress={handleOpen}
        accessibilityLabel={tSession('mobile.angleSelector.title')}
      />
      <AngleSelectorSheet
        visible={visible}
        onClose={handleClose}
        boardName={activeBoard.boardType}
        layoutId={activeBoard.layoutId}
        currentAngle={activeBoard.angle}
        onAngleChange={handleAngleChange}
      />
    </>
  );
}

function MaterialLightbulbAction() {
  const { systemColors, brandColors } = useTheme();
  const { t: tCommon } = useTranslation('common');
  const { t: tSettings } = useTranslation('settings');
  const { bluetooth, connected, handlePress } = useLightbulbToggle();

  if (!bluetooth) return null;

  const iconName = connected ? iconMap['lightbulb.fill'].android : iconMap.lightbulb.android;
  const iconColor = connected ? brandColors.warning : systemColors.label;

  return (
    <Appbar.Action
      icon={iconName}
      color={iconColor as string}
      onPress={handlePress}
      accessibilityLabel={connected ? tCommon('lightControl.disconnect') : tSettings('ble.connectBoard')}
    />
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
    position: 'relative',
    shadowOpacity: 0,
  },
  materialTitleSpacer: {
    flex: 1,
  },
  materialTimerOverlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
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
  materialAngleText: {
    fontWeight: '700',
    textAlign: 'center',
  },
});
