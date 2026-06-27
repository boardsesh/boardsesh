import { useCallback, useMemo, useRef, useState } from 'react';
import { View, Pressable, StyleSheet, useWindowDimensions } from 'react-native';
import { useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router';
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
import { useTheme } from '../../../src/providers/theme-provider';
import { getCreateBoardHolds, parseSetIdsParam } from '../../../src/lib/create-board-holds';
import { emitHoldsFilterSelection } from '../../../src/lib/hold-filter-handoff';
import { track } from '../../../src/lib/analytics';
import { spacing } from '../../../src/theme/tokens';

type Params = {
  boardName?: string;
  layoutId?: string;
  sizeId?: string;
  setIds?: string;
  holdsFilter?: string;
};

// Vertical space (px) reserved for the on-screen chrome around the board so the
// full board fits without scroll: the header row plus its top padding, and the
// below-board hold-type controls (include/exclude toggle + chip row +
// clear/hint) plus the bottom safe area. A rough constant is fine: the board
// still fits as long as the budget is in the right ballpark, and `availHeight`
// is clamped below.
const CHROME_BUDGET = 320;

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
  const router = useRouter();
  const { t } = useTranslation('climbs');
  const { systemColors, brandColors } = useTheme();
  const insets = useSafeAreaInsets();
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();

  const boardName = (params.boardName ?? '') as BoardName;
  const layoutId = Number(params.layoutId ?? 0);
  const sizeId = Number(params.sizeId ?? 0);
  const setIds = params.setIds ?? '';
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

  const boardHolds = useMemo(() => {
    if (!boardName) return null;
    return getCreateBoardHolds({
      boardName,
      layoutId,
      sizeId,
      setIds: parseSetIdsParam(setIds),
    });
  }, [boardName, layoutId, sizeId, setIds]);

  const boardRender = useMemo(() => {
    if (!boardHolds) return { width: 0, height: 0 };
    const boardAspect = boardHolds.boardWidth / boardHolds.boardHeight;
    const availWidth = windowWidth - spacing[4] * 2;
    // Clamp to a 200px floor so a short window (small device in landscape, or an
    // over-large CHROME_BUDGET estimate) never collapses the board to nothing.
    const availHeight = Math.max(200, windowHeight - insets.top - insets.bottom - CHROME_BUDGET);
    if (availWidth / availHeight > boardAspect) {
      return { width: availHeight * boardAspect, height: availHeight };
    }
    return { width: availWidth, height: availWidth / boardAspect };
  }, [boardHolds, windowWidth, windowHeight, insets.top, insets.bottom]);

  // Hand the current filter back to the sheet whenever this screen loses focus
  // (Done button pops, or swipe-back). Matches the setters handoff timing.
  useFocusEffect(
    useCallback(() => {
      return () => emitHoldsFilterSelection(holdsFilterRef.current);
    }, []),
  );

  const done = useCallback(() => {
    router.back();
  }, [router]);

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

  if (!boardHolds || !boardName) {
    return (
      <View style={[styles.loading, { backgroundColor: systemColors.background }]}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: systemColors.background }]}>
      <View style={[styles.header, { paddingTop: insets.top + spacing[2] }]}>
        <Text variant="title3">{t('mobile.holdFilter.title')}</Text>
        <View style={styles.headerActions}>
          {filteredCount > 0 ? (
            <Pressable onPress={handleClearAll} hitSlop={8} accessibilityRole="button">
              <Text variant="subheadline" color={brandColors.primary}>
                {t('mobile.filter.clearAll')}
              </Text>
            </Pressable>
          ) : null}
          <Pressable onPress={done} hitSlop={8} accessibilityRole="button">
            <Text variant="subheadline" color={brandColors.primary} style={styles.doneLabel}>
              {t('mobile.filter.done')}
            </Text>
          </Pressable>
        </View>
      </View>

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
        />
      </View>

      <HoldFilterPicker
        boardName={boardName}
        selectedType={selectedType}
        onSelectType={setSelectedType}
        applyMode={applyMode}
        onApplyModeChange={setApplyMode}
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
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing[4],
    paddingBottom: spacing[2],
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[4],
  },
  doneLabel: {
    fontWeight: '600',
  },
  boardSection: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
