import { useCallback, useMemo, useRef, useState } from 'react';
import { View, Pressable, StyleSheet, useWindowDimensions } from 'react-native';
import { useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { countFilteredHolds, toggleHoldFilterType } from '@boardsesh/climb-filters';
import type { BoardName, HoldFilterEntry, HoldFilterMode, HoldFilterType, HoldsFilter } from '@boardsesh/shared-schema';
import { Text } from '../../../src/components/Text';
import { ActivityIndicator } from '../../../src/components/ActivityIndicator';
import { InteractiveFilterBoard } from '../../../src/components/search/InteractiveFilterBoard';
import { HoldFilterPicker } from '../../../src/components/search/HoldFilterPicker';
import { useTheme } from '../../../src/providers/theme-provider';
import { getCreateBoardHolds } from '../../../src/lib/create-board-holds';
import { emitHoldsFilterSelection } from '../../../src/lib/hold-filter-handoff';
import { track } from '../../../src/lib/analytics';
import { spacing } from '../../../src/theme/tokens';

type Params = {
  boardName?: string;
  layoutId?: string;
  sizeId?: string;
  setIds?: string;
  angle?: string;
  holdsFilter?: string;
};

// Chrome above the board (header + footer summary) the board height budget must
// leave room for, so the full board fits without scroll.
const CHROME_BUDGET = 132;

function parseHoldsFilter(raw: string | undefined): HoldsFilter {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as HoldsFilter;
    }
  } catch {
    // Malformed param → start empty rather than crash.
  }
  return {};
}

/**
 * Full-screen board sub-screen for the hold-type search filter. Mirrors the
 * setters handoff: the ClimbFilterSheet pushes here with the current
 * `holdsFilter` serialized, the user taps holds to include/exclude hold types,
 * and the edited filter is handed back via `emitHoldsFilterSelection` when the
 * screen pops (Done or swipe-back).
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
  // Matches the web `boardLayout` property: the layout identity, not the board
  // name. Mobile carries the numeric layoutId at this call site (PR #2618).
  const boardLayout = String(layoutId);

  const [holdsFilter, setHoldsFilter] = useState<HoldsFilter>(() => parseHoldsFilter(params.holdsFilter));
  // Mirror of the latest holdsFilter so the focus-effect cleanup hands back the
  // current value without re-subscribing on every edit.
  const holdsFilterRef = useRef(holdsFilter);
  holdsFilterRef.current = holdsFilter;

  const [activeHoldId, setActiveHoldId] = useState<number | null>(null);
  const [applyMode, setApplyMode] = useState<HoldFilterMode>('include');

  const boardHolds = useMemo(() => {
    if (!boardName) return null;
    return getCreateBoardHolds({
      boardName,
      layoutId,
      sizeId,
      setIds: setIds.split(',').map(Number).filter(Number.isFinite),
    });
  }, [boardName, layoutId, sizeId, setIds]);

  const boardRender = useMemo(() => {
    if (!boardHolds) return { width: 0, height: 0 };
    const boardAspect = boardHolds.boardWidth / boardHolds.boardHeight;
    const availWidth = windowWidth - spacing[4] * 2;
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

  const handleHoldTap = useCallback((holdId: number) => {
    setActiveHoldId(holdId);
  }, []);

  const handleToggleType = useCallback(
    (type: HoldFilterType) => {
      if (activeHoldId == null) return;
      const holdKey = String(activeHoldId);
      setHoldsFilter((previous) => {
        const existing: HoldFilterEntry = previous[holdKey] ?? {};
        const nextEntry = toggleHoldFilterType(existing, type, applyMode);
        const next: HoldsFilter = { ...previous };
        if (Object.keys(nextEntry).length === 0) {
          delete next[holdKey];
        } else {
          next[holdKey] = nextEntry;
        }
        return next;
      });
      track(SHARED_EVENTS.SearchHoldFilterChanged, {
        type,
        mode: applyMode,
        boardLayout,
      });
    },
    [activeHoldId, applyMode, boardLayout],
  );

  const handleClearHold = useCallback(() => {
    if (activeHoldId == null) return;
    const holdKey = String(activeHoldId);
    setHoldsFilter((previous) => {
      if (!(holdKey in previous)) return previous;
      const next: HoldsFilter = { ...previous };
      delete next[holdKey];
      return next;
    });
    track(SHARED_EVENTS.SearchHoldFilterCleared, { boardLayout });
  }, [activeHoldId, boardLayout]);

  const handleClearAll = useCallback(() => {
    setHoldsFilter({});
    track(SHARED_EVENTS.SearchHoldFilterCleared, { boardLayout });
  }, [boardLayout]);

  const closePicker = useCallback(() => setActiveHoldId(null), []);

  const activeEntry: HoldFilterEntry = activeHoldId != null ? (holdsFilter[String(activeHoldId)] ?? {}) : {};
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
        <InteractiveFilterBoard
          boardName={boardName}
          layoutId={layoutId}
          sizeId={sizeId}
          setIds={setIds}
          boardWidth={boardHolds.boardWidth}
          boardHeight={boardHolds.boardHeight}
          holdTargets={boardHolds.holdTargets}
          holdsFilter={holdsFilter}
          activeHoldId={activeHoldId}
          onHoldTap={handleHoldTap}
          renderWidth={boardRender.width}
          renderHeight={boardRender.height}
        />
      </View>

      <View style={[styles.footer, { paddingBottom: insets.bottom + spacing[3] }]}>
        <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.footerText}>
          {filteredCount > 0
            ? t('mobile.holdFilter.summaryCount', { count: filteredCount })
            : t('mobile.holdFilter.hint')}
        </Text>
      </View>

      <HoldFilterPicker
        holdId={activeHoldId}
        boardName={boardName}
        entry={activeEntry}
        applyMode={applyMode}
        onApplyModeChange={setApplyMode}
        onToggleType={handleToggleType}
        onClear={handleClearHold}
        onClose={closePicker}
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
  footer: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[2],
    alignItems: 'center',
  },
  footerText: {
    textAlign: 'center',
  },
});
