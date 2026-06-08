// Top chrome for the climbs list. On native-search devices, Expo's stack search
// bar owns text input and this chrome carries board/angle/create/light controls.
// On fallback devices, it also keeps a custom climb-name search row. The bottom
// right filter FAB owns the full filter sheet and long-press grade rail.
//
// The board pill, the glass action islands and the angle / lightbulb controls are
// shared with the Discover chrome — they live in `../chrome` so both tabs read as
// one system. This file keeps the climbs-only pieces: the search row, the
// Material filter button, and the active-filter summary capsule.

import { type RefObject, useCallback, useState } from 'react';
import { Keyboard, type LayoutChangeEvent, StyleSheet, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { Appbar, Chip } from 'react-native-paper';
import type { Grade } from '@boardsesh/shared-schema';
import type { GradeBound } from '@boardsesh/climb-filters';
import { useTheme } from '../../providers/theme-provider';
import { useActiveBoard, useSetActiveBoard } from '../../lib/graphql/use-active-board';
import { useOptionalBluetoothContext } from '../../providers/bluetooth-provider';
import { spacing, shadows } from '../../theme/tokens';
import { glassSize } from '../../theme/layout';
import { hapticLight } from '../../lib/haptics';
import { formatActiveBoardLabel } from '../../lib/boards/active-board-label';
import { useNativeGlass } from '../../hooks/use-native-glass';
import { GlassSurface } from '../GlassSurface';
import { PressableSurface } from '../PressableSurface';
import { SearchHeader, type SearchHeaderHandle } from '../SearchHeader';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { iconMap } from '../icon-map';
import { BoardPill } from '../chrome/BoardPill';
import { GlassActionToolbar, GlassToolbarAction, TOP_ACTION_SIZE } from '../chrome/GlassActionToolbar';
import { AngleToolbarAction } from '../chrome/AngleToolbarAction';
import { LightbulbToolbarAction } from '../chrome/LightbulbToolbarAction';
import { GradeRangeRail } from '../grade';
import { AngleSelectorSheet } from '../play-drawer/AngleSelectorSheet';
import { FilterButton } from './FilterButton';

const TOP_TOOLBAR_WIDTH = TOP_ACTION_SIZE * 2;
const SUMMARY_CAPSULE_HEIGHT = glassSize.mini;
const SUMMARY_CAPSULE_RADIUS = SUMMARY_CAPSULE_HEIGHT / 2;
const MATERIAL_SEARCH_HEIGHT = 56;

type GradeChip = { label: string; active: false } | { label: string; active: true; onClear: () => void };

type ClimbTopChromeProps = {
  searchMode?: 'custom' | 'native';
  canCreate: boolean;
  onCreate: () => void;
  onOpenBoardDetail: () => void;
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
  /** Active-filter summary shown as a single capsule below the board name.
   *  Tapping it clears all filters (no per-chip remove). Absent = no filters. */
  filterSummary?: { text: string; onClear: () => void };
  gradeBound?: GradeBound;
  grades?: readonly Grade[];
  gradeRailVisible?: boolean;
  gradeChip?: GradeChip;
  onOpenGrade?: () => void;
  onGradeChange?: (grade: GradeBound) => void;
};

export function ClimbTopChrome({
  searchMode = 'custom',
  canCreate,
  onCreate,
  onOpenBoardDetail,
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
  gradeRailVisible = false,
  gradeChip,
  onOpenGrade,
  onGradeChange,
}: ClimbTopChromeProps) {
  const { t } = useTranslation('climbs');
  const { t: tCommon } = useTranslation('common');
  const { systemColors, variant } = useTheme();
  const nativeGlass = useNativeGlass();
  const insets = useSafeAreaInsets();
  const { data: activeBoard } = useActiveBoard();
  const bluetooth = useOptionalBluetoothContext();
  const usesCustomSearch = searchMode === 'custom';

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
    const boardLabel = formatActiveBoardLabel(activeBoard);
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
          <Appbar.Content
            title={tCommon('mobile.nav.climbs')}
            subtitle={boardLabel ?? undefined}
            onPress={
              boardLabel
                ? () => {
                    hapticLight();
                    onOpenBoardDetail();
                  }
                : undefined
            }
            titleStyle={styles.materialTitle}
            subtitleStyle={styles.materialSubtitle}
          />
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
              {onOpenFilters ? <FilterButton activeFilterCount={nonGradeFilterCount} onPress={onOpenFilters} /> : null}
            </View>

            <View pointerEvents="box-none" style={styles.materialQuickRow}>
              <Chip
                compact
                mode={hasGradeFilter ? 'flat' : 'outlined'}
                selected={hasGradeFilter}
                showSelectedCheck={false}
                selectedColor={systemColors.label as string}
                icon={iconMap.angle.android}
                onPress={() => {
                  if (gradeRailVisible) {
                    onCloseGrade();
                    return;
                  }
                  onOpenGrade?.();
                }}
                onClose={hasGradeFilter ? gradeChip.onClear : undefined}
                closeIcon={iconMap.close.android}
                accessibilityLabel={t('mobile.search.gradeAction')}
                style={[styles.materialChip, hasGradeFilter ? { backgroundColor: systemColors.fill } : undefined]}
                textStyle={styles.materialChipText}
              >
                {visibleGradeLabel}
              </Chip>
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

  const canOpenAngleSelector = activeBoard?.isAngleAdjustable !== false && activeBoard?.angle != null;
  const leftActionCount = (canCreate ? 1 : 0) + (canOpenAngleSelector ? 1 : 0);

  return (
    <View pointerEvents="box-none" style={[styles.container, { paddingTop: insets.top }]} onLayout={handleLayout}>
      {/* Scrim: opaque screen background behind the controls, fading to clear at
          the bottom edge — hides the climb list scrolling up behind the floating
          islands (the gaps between them otherwise bleed list content = clutter). */}
      <LinearGradient
        pointerEvents="none"
        colors={[systemColors.background, systemColors.background, 'transparent'] as const}
        locations={[0, 0.7, 1]}
        style={StyleSheet.absoluteFill}
      />
      <View pointerEvents="box-none" style={styles.row}>
        <View pointerEvents="box-none" style={styles.leftSlot}>
          {leftActionCount > 0 ? (
            <GlassActionToolbar actionCount={leftActionCount}>
              {canCreate ? (
                <GlassToolbarAction onPress={onCreate} accessibilityLabel={t('mobile.create.fab.ariaLabel')}>
                  <Icon name="plus" size={24} color={systemColors.label} />
                </GlassToolbarAction>
              ) : null}
              <AngleToolbarAction />
            </GlassActionToolbar>
          ) : null}
        </View>

        <View pointerEvents="box-none" style={styles.centerSlot}>
          <BoardPill onPress={onOpenBoardDetail} />
        </View>

        <View pointerEvents="box-none" style={styles.rightSlot}>
          {/* Right toolbar: light/bluetooth only. The filter affordance lives to
              the left of the search field (Material) or as the bottom FAB. */}
          {bluetooth ? (
            <GlassActionToolbar actionCount={1}>
              <LightbulbToolbarAction />
            </GlassActionToolbar>
          ) : null}
        </View>
      </View>

      {filterSummary ? (
        <View pointerEvents="box-none" style={styles.summaryRow}>
          <PressableSurface
            onPress={() => {
              hapticLight();
              filterSummary.onClear();
            }}
            feedback="scale"
            scaleTo={0.96}
            accessibilityRole="button"
            accessibilityLabel={filterSummary.text}
            accessibilityHint={t('mobile.search.clearAll')}
            style={styles.summaryPress}
          >
            <View
              style={[
                styles.summaryCapsule,
                !nativeGlass && shadows.sm,
                !nativeGlass && { borderWidth: StyleSheet.hairlineWidth, borderColor: systemColors.separator },
              ]}
            >
              <GlassSurface
                glassEffectStyle="regular"
                fallbackColor={systemColors.elevatedSurface}
                borderRadius={SUMMARY_CAPSULE_RADIUS}
                style={StyleSheet.absoluteFill}
                pointerEvents="none"
              />
              <Text
                variant="caption1"
                numberOfLines={1}
                ellipsizeMode="tail"
                color={systemColors.label}
                style={styles.summaryText}
              >
                {filterSummary.text}
              </Text>
            </View>
          </PressableSurface>
        </View>
      ) : null}

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
    </View>
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
  const bluetooth = useOptionalBluetoothContext();
  const connected = bluetooth?.isConnected ?? false;

  const handlePress = useCallback(() => {
    if (!bluetooth) return;
    hapticLight();
    if (bluetooth.isConnected) void bluetooth.disconnect();
    else void bluetooth.connect();
  }, [bluetooth]);

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
  container: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 20,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[2],
    minHeight: TOP_ACTION_SIZE,
  },
  leftSlot: {
    width: TOP_TOOLBAR_WIDTH,
    alignItems: 'flex-start',
    justifyContent: 'center',
  },
  centerSlot: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 0,
  },
  rightSlot: {
    width: TOP_TOOLBAR_WIDTH,
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
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
  summaryRow: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[1],
    alignItems: 'center',
  },
  summaryPress: {
    height: SUMMARY_CAPSULE_HEIGHT,
    maxWidth: 280,
    alignItems: 'center',
    justifyContent: 'center',
  },
  summaryCapsule: {
    flexDirection: 'row',
    alignItems: 'center',
    height: SUMMARY_CAPSULE_HEIGHT,
    borderRadius: SUMMARY_CAPSULE_RADIUS,
    // Clip the absolutely-filled GlassSurface to the rounded corners (Android
    // border-radius alone doesn't clip children), matching the action toolbars.
    overflow: 'hidden',
    paddingHorizontal: 12,
    gap: 5,
  },
  summaryText: {
    fontWeight: '600',
    flexShrink: 1,
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
  materialTitle: {
    fontWeight: '700',
  },
  materialSubtitle: {
    fontWeight: '500',
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
