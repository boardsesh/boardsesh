import { useCallback, useMemo, useRef, useState } from 'react';
import { View, Pressable, StyleSheet, useWindowDimensions } from 'react-native';
import { useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import {
  buildDefaultZone,
  pruneHoldsToZone,
  type BoardDimensions,
  type HoldPositionLookup,
} from '@boardsesh/climb-filters';
import { getLayout } from '@boardsesh/board-constants';
import type { BoardName, HoldsFilter, ZoneBoxInput, ZoneMatchMode } from '@boardsesh/shared-schema';
import { Text } from '../../../src/components/Text';
import { ActivityIndicator } from '../../../src/components/ActivityIndicator';
import { Button } from '../../../src/components/Button';
import { SegmentedControl } from '../../../src/components/SegmentedControl';
import { GlassSurface } from '../../../src/components/GlassSurface';
import {
  InteractiveFilterBoard,
  type FilterBoardTransformContext,
} from '../../../src/components/search/InteractiveFilterBoard';
import { ZoneOverlay, type ZoneCornerLabels } from '../../../src/components/search/ZoneOverlay';
import { useTheme } from '../../../src/providers/theme-provider';
import { getCreateBoardHolds } from '../../../src/lib/create-board-holds';
import { emitZoneFilterSelection } from '../../../src/lib/zone-filter-handoff';
import { track } from '../../../src/lib/analytics';
import { hapticSelection } from '../../../src/lib/haptics';
import { overlays, spacing } from '../../../src/theme/tokens';

type Params = {
  boardName?: string;
  layoutId?: string;
  sizeId?: string;
  setIds?: string;
  angle?: string;
  zoneBox?: string;
  zoneMode?: string;
  holdsFilter?: string;
};

// Chrome above the board (header + mode island + footer) the board height budget
// must leave room for, so the full board fits without scroll.
const CHROME_BUDGET = 220;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function parseZoneBox(raw: string | undefined): ZoneBoxInput | null {
  // Absent or the literal "null" the sheet may have sent for "no zone".
  if (!raw || raw === 'null') return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === 'object' &&
      isFiniteNumber((parsed as Record<string, unknown>).edgeLeft) &&
      isFiniteNumber((parsed as Record<string, unknown>).edgeRight) &&
      isFiniteNumber((parsed as Record<string, unknown>).edgeBottom) &&
      isFiniteNumber((parsed as Record<string, unknown>).edgeTop)
    ) {
      const box = parsed as Record<string, number>;
      return {
        edgeLeft: box.edgeLeft,
        edgeRight: box.edgeRight,
        edgeBottom: box.edgeBottom,
        edgeTop: box.edgeTop,
      };
    }
  } catch {
    // Malformed param → start with no zone rather than crash.
  }
  return null;
}

function parseHoldsFilter(raw: string | undefined): HoldsFilter {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as HoldsFilter;
    }
  } catch {
    // Malformed param → start empty.
  }
  return {};
}

function parseZoneMode(raw: string | undefined): ZoneMatchMode {
  return raw === 'anyHold' ? 'anyHold' : 'allHolds';
}

/**
 * Full-screen board sub-screen for the board-region (zone) search filter.
 * Mirrors the hold filter handoff: the ClimbFilterSheet pushes here with the
 * current zone serialized, the user drags a rectangle over the board to restrict
 * results, and the edited zone (plus a possibly-pruned hold filter) is handed
 * back via `emitZoneFilterSelection` when the screen pops (Done or swipe-back).
 */
export default function ZoneFilterScreen() {
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
  // The `boardLayout` analytics property is the layout NAME (e.g. "Original"),
  // matching web's `boardDetails.layout_name`. The route's `layoutName` param
  // carried the board family (e.g. "kilter"), so resolve the real name from the
  // board config instead of trusting the param.
  const layoutName = getLayout(boardName, layoutId)?.name ?? '';

  const [zoneBox, setZoneBox] = useState<ZoneBoxInput | null>(() => parseZoneBox(params.zoneBox));
  const [zoneMode, setZoneMode] = useState<ZoneMatchMode>(() => parseZoneMode(params.zoneMode));
  const [holdsFilter, setHoldsFilter] = useState<HoldsFilter>(() => parseHoldsFilter(params.holdsFilter));

  // Mirror the latest selection so the focus-effect cleanup hands back the
  // current value without re-subscribing on every edit.
  const selectionRef = useRef({ zoneBox, zoneMode, holdsFilter });
  selectionRef.current = { zoneBox, zoneMode, holdsFilter };

  const boardHolds = useMemo(() => {
    if (!boardName) return null;
    return getCreateBoardHolds({
      boardName,
      layoutId,
      sizeId,
      setIds: setIds.split(',').map(Number).filter(Number.isFinite),
    });
  }, [boardName, layoutId, sizeId, setIds]);

  const dims = useMemo<BoardDimensions | null>(() => {
    if (!boardHolds) return null;
    return {
      boardWidth: boardHolds.boardWidth,
      boardHeight: boardHolds.boardHeight,
      edgeLeft: boardHolds.edgeLeft,
      edgeRight: boardHolds.edgeRight,
      edgeBottom: boardHolds.edgeBottom,
      edgeTop: boardHolds.edgeTop,
    };
  }, [boardHolds]);

  // Hold-position lookup so switching to allHolds can prune out-of-zone holds.
  const holdsById = useMemo<HoldPositionLookup>(() => {
    const map = new Map<number, { cx: number; cy: number }>();
    if (boardHolds) {
      for (const hold of boardHolds.holdTargets) map.set(hold.id, { cx: hold.cx, cy: hold.cy });
    }
    return map;
  }, [boardHolds]);

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

  // Hand the current selection back to the sheet whenever this screen loses
  // focus (Done button pops, or swipe-back). Matches the hold filter handoff.
  useFocusEffect(
    useCallback(() => {
      return () =>
        emitZoneFilterSelection({
          zoneBox: selectionRef.current.zoneBox,
          zoneMode: selectionRef.current.zoneMode,
          holdsFilter: selectionRef.current.holdsFilter,
        });
    }, []),
  );

  const done = useCallback(() => {
    router.back();
  }, [router]);

  const handleEnable = useCallback(() => {
    if (!dims) return;
    const next = buildDefaultZone(dims);
    setZoneBox(next);
    setZoneMode('allHolds');
    setHoldsFilter((previous) => pruneHoldsToZone(previous, next, holdsById, dims));
    hapticSelection();
    track(SHARED_EVENTS.SearchZoneEnabled, { boardLayout: layoutName, zoneMode: 'allHolds' });
  }, [dims, holdsById, layoutName]);

  const handleClear = useCallback(() => {
    setZoneBox(null);
    hapticSelection();
    track(SHARED_EVENTS.SearchZoneCleared, { boardLayout: layoutName });
  }, [layoutName]);

  // Commit a dragged box. In allHolds mode out-of-zone hold filters can't match,
  // so prune them; anyHold keeps them (only one climb hold must intersect).
  const handleCommitZone = useCallback(
    (next: ZoneBoxInput) => {
      if (!dims) return;
      setZoneBox(next);
      if (zoneMode === 'allHolds') {
        setHoldsFilter((previous) => pruneHoldsToZone(previous, next, holdsById, dims));
      }
      track(SHARED_EVENTS.SearchZoneUpdated, {
        boardLayout: layoutName,
        zoneMode,
        width: next.edgeRight - next.edgeLeft,
        height: next.edgeTop - next.edgeBottom,
      });
    },
    [dims, holdsById, layoutName, zoneMode],
  );

  const handleModeChange = useCallback(
    (nextMode: ZoneMatchMode) => {
      if (!dims || !zoneBox) return;
      setZoneMode(nextMode);
      if (nextMode === 'allHolds') {
        setHoldsFilter((previous) => pruneHoldsToZone(previous, zoneBox, holdsById, dims));
      }
      track(SHARED_EVENTS.SearchZoneModeChanged, { boardLayout: layoutName, zoneMode: nextMode });
    },
    [dims, holdsById, layoutName, zoneBox],
  );

  const modeOptions = useMemo(
    () => [
      { key: 'allHolds' as const, label: t('mobile.zoneFilter.allHolds') },
      { key: 'anyHold' as const, label: t('mobile.zoneFilter.anyHold') },
    ],
    [t],
  );

  const cornerLabels = useMemo<ZoneCornerLabels>(
    () => ({
      nw: t('mobile.zoneFilter.corner.topLeft'),
      ne: t('mobile.zoneFilter.corner.topRight'),
      sw: t('mobile.zoneFilter.corner.bottomLeft'),
      se: t('mobile.zoneFilter.corner.bottomRight'),
    }),
    [t],
  );

  const renderZoneOverlay = useCallback(
    ({ pinchGesture, scaleSV, renderWidth, renderHeight }: FilterBoardTransformContext) => {
      if (!zoneBox || !dims) return null;
      return (
        <ZoneOverlay
          zoneBox={zoneBox}
          dims={dims}
          renderWidth={renderWidth}
          renderHeight={renderHeight}
          zoomScale={scaleSV}
          onCommit={handleCommitZone}
          boardPinch={pinchGesture}
          brandColor={brandColors.primary}
          scrimColor={overlays.scrim}
          bodyLabel={t('mobile.zoneFilter.regionLabel')}
          bodyHint={t('mobile.zoneFilter.regionHint')}
          cornerLabels={cornerLabels}
          cornerHint={t('mobile.zoneFilter.corner.hint')}
        />
      );
    },
    [zoneBox, dims, handleCommitZone, brandColors.primary, t, cornerLabels],
  );

  if (!boardHolds || !boardName || !dims) {
    return (
      <View style={[styles.loading, { backgroundColor: systemColors.background }]}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  const zoneEnabled = zoneBox != null;

  return (
    <View style={[styles.container, { backgroundColor: systemColors.background }]}>
      <View style={[styles.header, { paddingTop: insets.top + spacing[2] }]}>
        <Text variant="title3">{t('mobile.zoneFilter.title')}</Text>
        <View style={styles.headerActions}>
          {zoneEnabled ? (
            <Pressable onPress={handleClear} hitSlop={8} accessibilityRole="button">
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
          renderWidth={boardRender.width}
          renderHeight={boardRender.height}
          renderInTransform={renderZoneOverlay}
        />
      </View>

      {zoneEnabled ? (
        <GlassSurface
          glassEffectStyle="regular"
          fallbackColor={systemColors.elevatedSurface}
          borderRadius={16}
          style={styles.modeIsland}
        >
          <SegmentedControl
            options={modeOptions}
            selectedKey={zoneMode}
            onSelect={handleModeChange}
            trackColor={systemColors.fill}
            accessibilityLabel={t('mobile.zoneFilter.modeLabel')}
          />
          <Button
            title={t('mobile.zoneFilter.clearZone')}
            onPress={handleClear}
            variant="outlined"
            size="small"
            style={styles.clearButton}
          />
        </GlassSurface>
      ) : (
        <View style={styles.enableRow}>
          <Button title={t('mobile.zoneFilter.enable')} onPress={handleEnable} variant="filled" size="medium" />
        </View>
      )}

      <View style={[styles.footer, { paddingBottom: insets.bottom + spacing[3] }]}>
        <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.footerText}>
          {zoneEnabled ? t('mobile.zoneFilter.activeHint') : t('mobile.zoneFilter.hint')}
        </Text>
      </View>
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
  modeIsland: {
    marginHorizontal: spacing[4],
    padding: spacing[3],
    gap: spacing[2],
  },
  clearButton: {
    alignSelf: 'center',
  },
  enableRow: {
    paddingHorizontal: spacing[4],
    alignItems: 'center',
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
