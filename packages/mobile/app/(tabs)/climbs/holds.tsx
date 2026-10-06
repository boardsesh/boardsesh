import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Pressable, StyleSheet, useWindowDimensions, type LayoutChangeEvent } from 'react-native';
import { useLocalSearchParams, useNavigation, useFocusEffect } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { getLayout } from '@boardsesh/board-constants/product-sizes';
import { countFilteredHolds, parseHoldsFilter, toggleHoldFilterType } from '@boardsesh/climb-filters';
import type { BoardName, HoldFilterEntry, HoldFilterMode, HoldFilterType, HoldsFilter } from '@boardsesh/shared-schema';
import { Text } from '../../../src/components/Text';
import { ActivityIndicator } from '../../../src/components/ActivityIndicator';
import { InteractiveFilterBoard } from '../../../src/components/search/InteractiveFilterBoard';
import { HoldFilterPicker } from '../../../src/components/search/HoldFilterPicker';
import { HoldFilterHeatmapPanel } from '../../../src/components/search/heatmap/HoldFilterHeatmapPanel';
import { useHoldFilterHeatmap } from '../../../src/components/search/heatmap/use-hold-filter-heatmap';
import { parseHeatmapSearch } from '../../../src/components/search/heatmap/heatmap-search-input';
import { ActionButton } from '../../../src/components/drawer-action-bar/DrawerActionBar';
import { useTheme } from '../../../src/providers/theme-provider';
import { useAuth } from '../../../src/providers/auth-provider';
import { useActiveBoard } from '../../../src/lib/graphql/use-active-board';
import { useScreenshotBoardParams } from '../../../src/hooks/use-screenshot-board-params';
import { getCreateBoardHolds, parseSetIdsParam } from '../../../src/lib/create-board-holds';
import { useSprayWallToken } from '../../../src/lib/spray/use-spray-wall-token';
import { emitHoldsFilterSelection } from '../../../src/lib/hold-filter-handoff';
import { track } from '../../../src/lib/analytics';
import { hapticMedium } from '../../../src/lib/haptics';
import { spacing } from '../../../src/theme/tokens';

type Params = {
  boardName?: string;
  layoutId?: string;
  sizeId?: string;
  setIds?: string;
  angle?: string;
  holdsFilter?: string;
  /** The filter sheet's draft search, for the heatmap. */
  heatmapSearch?: string;
};

// Vertical space (px) reserved for the on-screen chrome around the board so the
// full board fits without scroll: the native header bar (the title + back
// chevron live there now, not an in-body row), and the below-board hold-type
// controls (include/exclude toggle + chip row + clear/hint). The status bar and
// bottom safe area are subtracted separately. A rough constant is fine: the
// board still fits as long as the budget is in the right ballpark, and
// `availHeight` is clamped below.
const CHROME_BUDGET = 300;

/**
 * Full-screen route variant for the hold-type search filter. The climb filter
 * sheet suspends (dismisses without unmounting) and pushes this route, which
 * serializes `holdsFilter`, lets the user tap holds to include/exclude hold
 * types, and hands the edited filter back via `emitHoldsFilterSelection` when the
 * screen pops (Done or swipe-back). A pushed route — not a stacked sheet —
 * because native sheets can't stack above the filter sheet, and the board's
 * pan/pinch shouldn't fight a modal's pan. See docs/mobile-sheets-vs-routes.md.
 */
export default function HoldFilterScreen() {
  const params = useLocalSearchParams<Params>();
  const navigation = useNavigation();
  const { t } = useTranslation('climbs');
  const { systemColors, brandColors } = useTheme();
  const insets = useSafeAreaInsets();
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();

  // A screenshot deep link (`://climbs/holds`) opens this route with none of the
  // params the filter sheet pushes, which would render an empty board. In
  // screenshot mode only, fall back to the wall the capture activated on boot;
  // `null` in every normal build and whenever the route carried a board.
  const screenshotBoard = useScreenshotBoardParams(params.boardName);
  const boardName = (screenshotBoard?.boardName ?? params.boardName ?? '') as BoardName;
  const layoutId = Number(screenshotBoard?.layoutId ?? params.layoutId ?? 0);
  const sizeId = Number(screenshotBoard?.sizeId ?? params.sizeId ?? 0);
  const setIds = screenshotBoard?.setIds ?? params.setIds ?? '';
  const angle = Number(screenshotBoard?.angle ?? params.angle ?? 0);
  // Matches the web `boardLayout` property: the layout NAME (web sends
  // `boardDetails.layout_name`), not the numeric id, so the hold-filter events
  // join cleanly with web across platforms. Falls back to '' for unknown ids.
  const boardLayout = getLayout(boardName, layoutId)?.name ?? '';

  const [holdsFilter, setHoldsFilter] = useState<HoldsFilter>(() => parseHoldsFilter(params.holdsFilter));
  // Mirror of the latest holdsFilter so the focus-effect cleanup hands back the
  // current value without re-subscribing on every edit.
  const holdsFilterRef = useRef(holdsFilter);
  holdsFilterRef.current = holdsFilter;

  const [selectedType, setSelectedType] = useState<HoldFilterType>('HAND');
  const [applyMode, setApplyMode] = useState<HoldFilterMode>('include');

  // The picker early-returns on null holds, before anything that would subscribe
  // to the registry is mounted, so opening the hold filter on a wall before its
  // query settled left a permanently empty picker.
  const sprayToken = useSprayWallToken(boardName, layoutId);
  const boardHolds = useMemo(() => {
    if (!boardName) return null;
    return getCreateBoardHolds({
      boardName,
      layoutId,
      sizeId,
      setIds: parseSetIdsParam(setIds),
    });
    // `sprayToken` moves when the wall arrives or is reset.
  }, [boardName, layoutId, sizeId, setIds, sprayToken]);

  // The hold heatmap, counting the climbs the sheet's other filters match. A
  // read that answers from a downloaded board (or offers the download), which a
  // signed-out climber has no way to use, so they get no toggle.
  const { isAuthenticated } = useAuth();
  const [heatmapDraft] = useState(() => parseHeatmapSearch(params.heatmapSearch));
  const heatmap = useHoldFilterHeatmap({ boardName, layoutId, sizeId, setIds, angle, holds: boardHolds }, heatmapDraft);
  const { data: activeBoard } = useActiveBoard();
  const heatmapNudgeBoard =
    activeBoard &&
    activeBoard.boardType === boardName &&
    activeBoard.layoutId === layoutId &&
    activeBoard.sizeId === sizeId
      ? activeBoard
      : null;
  const heatmapModeLabel =
    heatmap.mode === 'grade'
      ? t('mobile.heatmap.modes.grade')
      : heatmap.mode === 'startsFinishes'
        ? t('mobile.heatmap.modes.startsFinishes')
        : t('mobile.heatmap.modes.climbs');
  const { toggle: toggleHeatmap } = heatmap;
  const handleToggleHeatmap = useCallback(() => {
    hapticMedium();
    toggleHeatmap();
  }, [toggleHeatmap]);
  const heatmapToggle = isAuthenticated ? (
    <ActionButton
      size="sm"
      iconName={heatmap.enabled ? 'flame.fill' : 'flame'}
      onPress={handleToggleHeatmap}
      active={heatmap.enabled}
      activeColor={brandColors.primary}
      busy={heatmap.enabled && heatmap.isBusy}
      checked={heatmap.enabled}
      accessibilityLabel={t('mobile.heatmap.toggle')}
      accessibilityValueText={heatmap.enabled ? heatmapModeLabel : undefined}
    />
  ) : null;

  // The heatmap panel's measured height (0 while it renders nothing), so the
  // board gives up exactly the room the legend, caption or download line takes.
  const [heatmapPanelHeight, setHeatmapPanelHeight] = useState(0);
  const handleHeatmapPanelLayout = useCallback((event: LayoutChangeEvent) => {
    setHeatmapPanelHeight(Math.round(event.nativeEvent.layout.height));
  }, []);
  const chromeBudget = CHROME_BUDGET + heatmapPanelHeight;
  const boardRender = useMemo(() => {
    if (!boardHolds) return { width: 0, height: 0 };
    const boardAspect = boardHolds.boardWidth / boardHolds.boardHeight;
    const availWidth = windowWidth - spacing[4] * 2;
    // Clamp to a 200px floor so a short window (small device in landscape, or an
    // over-large CHROME_BUDGET estimate) never collapses the board to nothing.
    const availHeight = Math.max(200, windowHeight - insets.top - insets.bottom - chromeBudget);
    if (availWidth / availHeight > boardAspect) {
      return { width: availHeight * boardAspect, height: availHeight };
    }
    return { width: availWidth, height: availWidth / boardAspect };
  }, [boardHolds, windowWidth, windowHeight, insets.top, insets.bottom, chromeBudget]);

  // Hand the current filter back to the sheet whenever this screen loses focus
  // (Done button pops, or swipe-back). Matches the setters handoff timing.
  useFocusEffect(
    useCallback(() => {
      return () => emitHoldsFilterSelection(holdsFilterRef.current);
    }, []),
  );

  // Paint the selected brush (type + include/exclude) onto the tapped hold:
  // toggle that type at the current mode, dropping the hold if it ends up empty.
  const handleHoldTap = useCallback(
    (holdId: number) => {
      const holdKey = String(holdId);
      setHoldsFilter((previous) => {
        const existing: HoldFilterEntry = previous[holdKey] ?? {};
        const nextEntry = toggleHoldFilterType(existing, selectedType, applyMode);
        const next: HoldsFilter = { ...previous };
        if (Object.keys(nextEntry).length === 0) {
          delete next[holdKey];
        } else {
          next[holdKey] = nextEntry;
        }
        return next;
      });
      track(SHARED_EVENTS.SearchHoldFilterChanged, {
        type: selectedType,
        mode: applyMode,
        boardLayout,
      });
    },
    [selectedType, applyMode, boardLayout],
  );

  const handleClearAll = useCallback(() => {
    setHoldsFilter({});
    track(SHARED_EVENTS.SearchHoldFilterCleared, { boardLayout });
  }, [boardLayout]);

  const filteredCount = countFilteredHolds(holdsFilter);

  // "Clear all" moves to the native header's headerRight, shown only when there's
  // something to clear. The back chevron / swipe-back replaces the old in-body
  // "Done" (the selection is handed back on blur via the focus-cleanup above).
  useEffect(() => {
    navigation.setOptions({
      headerRight:
        filteredCount > 0
          ? () => (
              <Pressable onPress={handleClearAll} hitSlop={8} accessibilityRole="button">
                <Text variant="subheadline" color={brandColors.primary}>
                  {t('mobile.filter.clearAll')}
                </Text>
              </Pressable>
            )
          : undefined,
    });
  }, [navigation, filteredCount, handleClearAll, brandColors.primary, t]);

  if (!boardHolds || !boardName) {
    return (
      <View style={[styles.loading, { backgroundColor: systemColors.background }]}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: systemColors.background }]}>
      <View style={styles.boardSection}>
        {/* Known follow-up (not in this PR): `BoardSearchConfig` doesn't carry a
            `mirrored` flag today, so the board always renders un-mirrored here
            and a mirrored search shows its hold rings on the opposite side. Wire
            `mirrored` through `BoardSearchConfig` to fix it. */}
        <InteractiveFilterBoard
          boardName={boardName}
          layoutId={layoutId}
          sizeId={sizeId}
          setIds={setIds}
          boardWidth={boardHolds.boardWidth}
          boardHeight={boardHolds.boardHeight}
          holdTargets={boardHolds.holdTargets}
          holdsFilter={holdsFilter}
          onHoldTap={handleHoldTap}
          renderWidth={boardRender.width}
          renderHeight={boardRender.height}
          underOverlay={heatmap.overlay}
        />
      </View>

      <View onLayout={handleHeatmapPanelLayout}>
        <HoldFilterHeatmapPanel heatmap={heatmap} boardName={boardName} nudgeBoard={heatmapNudgeBoard} />
      </View>

      <HoldFilterPicker
        boardName={boardName}
        selectedType={selectedType}
        onSelectType={setSelectedType}
        applyMode={applyMode}
        onApplyModeChange={setApplyMode}
        modeRowAccessory={heatmapToggle}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  boardSection: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
