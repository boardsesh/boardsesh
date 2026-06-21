import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Pressable, StyleSheet, useWindowDimensions } from 'react-native';
import type { BottomSheetModal } from '@gorhom/bottom-sheet';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import {
  buildDefaultZone,
  pruneHoldsToZone,
  type BoardDimensions,
  type BoardSearchConfig,
  type HoldPositionLookup,
} from '@boardsesh/climb-filters';
import { getLayout } from '@boardsesh/board-constants';
import type { BoardName, HoldsFilter, ZoneBoxInput, ZoneMatchMode } from '@boardsesh/shared-schema';
import { ModalSheet } from '../ModalSheet';
import { Text } from '../Text';
import { ActivityIndicator } from '../ActivityIndicator';
import { Button } from '../Button';
import { SegmentedControl } from '../SegmentedControl';
import { GlassSurface } from '../GlassSurface';
import { InteractiveFilterBoard, type FilterBoardTransformContext } from './InteractiveFilterBoard';
import { ZoneOverlay, type ZoneCornerLabels } from './ZoneOverlay';
import { useTheme } from '../../providers/theme-provider';
import { getCreateBoardHolds, parseSetIdsParam } from '../../lib/create-board-holds';
import { track } from '../../lib/analytics';
import { hapticSelection } from '../../lib/haptics';
import { overlays, spacing } from '../../theme/tokens';

export type ZoneFilterEditorSelection = {
  zoneBox: ZoneBoxInput | null;
  zoneMode: ZoneMatchMode;
  holdsFilter?: HoldsFilter;
};

type ZoneFilterEditorSheetProps = {
  visible: boolean;
  boardConfig: BoardSearchConfig;
  zoneBox: ZoneBoxInput | null;
  zoneMode: ZoneMatchMode;
  holdsFilter: HoldsFilter;
  onZoneFilterChange: (selection: ZoneFilterEditorSelection) => void;
  onClose: () => void;
  onDismiss: () => void;
};

const SHEET_HEIGHT_RATIO = 0.95;
const CHROME_BUDGET = 220;
const DEFER_BOARD_RENDER_MS = 120;

export function ZoneFilterEditorSheet({
  visible,
  boardConfig,
  zoneBox,
  zoneMode,
  holdsFilter,
  onZoneFilterChange,
  onClose,
  onDismiss,
}: ZoneFilterEditorSheetProps) {
  const sheetRef = useRef<BottomSheetModal>(null);
  const { t } = useTranslation('climbs');
  const { systemColors, brandColors } = useTheme();
  const insets = useSafeAreaInsets();
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const boardName = boardConfig.boardName as BoardName;
  const layoutName = getLayout(boardName, boardConfig.layoutId)?.name ?? '';
  const [contentReady, setContentReady] = useState(false);

  const selectionRef = useRef({ zoneBox, zoneMode, holdsFilter });
  selectionRef.current = { zoneBox, zoneMode, holdsFilter };

  useEffect(() => {
    if (visible) {
      sheetRef.current?.present();
      const timeout = setTimeout(() => setContentReady(true), DEFER_BOARD_RENDER_MS);
      return () => clearTimeout(timeout);
    } else {
      setContentReady(false);
      sheetRef.current?.dismiss();
    }
    return undefined;
  }, [visible]);

  const boardHolds = useMemo(() => {
    if (!contentReady) return null;
    return getCreateBoardHolds({
      boardName,
      layoutId: boardConfig.layoutId,
      sizeId: boardConfig.sizeId,
      setIds: parseSetIdsParam(boardConfig.setIds),
    });
  }, [contentReady, boardName, boardConfig.layoutId, boardConfig.sizeId, boardConfig.setIds]);

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
    const sheetHeight = windowHeight * SHEET_HEIGHT_RATIO;
    const availHeight = Math.max(200, sheetHeight - insets.bottom - CHROME_BUDGET);
    if (availWidth / availHeight > boardAspect) {
      return { width: availHeight * boardAspect, height: availHeight };
    }
    return { width: availWidth, height: availWidth / boardAspect };
  }, [boardHolds, windowWidth, windowHeight, insets.bottom]);

  const handleEnable = useCallback(() => {
    if (!dims) return;
    const nextZone = buildDefaultZone(dims);
    onZoneFilterChange({
      zoneBox: nextZone,
      zoneMode: 'allHolds',
      holdsFilter: pruneHoldsToZone(holdsFilter, nextZone, holdsById, dims),
    });
    hapticSelection();
    track(SHARED_EVENTS.SearchZoneEnabled, { boardLayout: layoutName, zoneMode: 'allHolds' });
  }, [dims, holdsById, holdsFilter, layoutName, onZoneFilterChange]);

  const handleClear = useCallback(() => {
    onZoneFilterChange({ zoneBox: null, zoneMode });
    hapticSelection();
    track(SHARED_EVENTS.SearchZoneCleared, { boardLayout: layoutName });
  }, [layoutName, onZoneFilterChange, zoneMode]);

  const handleCommitZone = useCallback(
    (nextZone: ZoneBoxInput) => {
      if (!dims) return;
      const nextSelection: ZoneFilterEditorSelection = {
        zoneBox: nextZone,
        zoneMode,
      };
      if (zoneMode === 'allHolds') {
        nextSelection.holdsFilter = pruneHoldsToZone(holdsFilter, nextZone, holdsById, dims);
      }
      onZoneFilterChange(nextSelection);
      track(SHARED_EVENTS.SearchZoneUpdated, {
        boardLayout: layoutName,
        zoneMode,
        width: nextZone.edgeRight - nextZone.edgeLeft,
        height: nextZone.edgeTop - nextZone.edgeBottom,
      });
    },
    [dims, holdsById, holdsFilter, layoutName, onZoneFilterChange, zoneMode],
  );

  const handleModeChange = useCallback(
    (nextMode: ZoneMatchMode) => {
      if (!dims || !zoneBox) return;
      const nextSelection: ZoneFilterEditorSelection = {
        zoneBox,
        zoneMode: nextMode,
      };
      if (nextMode === 'allHolds') {
        nextSelection.holdsFilter = pruneHoldsToZone(holdsFilter, zoneBox, holdsById, dims);
      }
      onZoneFilterChange(nextSelection);
      track(SHARED_EVENTS.SearchZoneModeChanged, { boardLayout: layoutName, zoneMode: nextMode });
    },
    [dims, holdsById, holdsFilter, layoutName, onZoneFilterChange, zoneBox],
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

  const zoneEnabled = zoneBox != null;
  const renderZoneOverlay = useCallback(
    ({ pinchGesture, scaleSV, renderWidth, renderHeight }: FilterBoardTransformContext) => {
      const currentZoneBox = selectionRef.current.zoneBox;
      if (!currentZoneBox || !dims) return null;
      return (
        <ZoneOverlay
          zoneBox={currentZoneBox}
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
    [dims, handleCommitZone, brandColors.primary, t, cornerLabels],
  );

  return (
    <ModalSheet ref={sheetRef} snapPoints={['95%']} onDismiss={onDismiss} stackBehavior="push">
      <View style={styles.container}>
        {!boardHolds || !dims ? (
          <View style={styles.loading}>
            <ActivityIndicator size="large" />
          </View>
        ) : (
          <>
            <View style={styles.header}>
              <Text variant="title3">{t('mobile.zoneFilter.title')}</Text>
              <View style={styles.headerActions}>
                {zoneEnabled ? (
                  <Pressable onPress={handleClear} hitSlop={8} accessibilityRole="button">
                    <Text variant="subheadline" color={brandColors.primary}>
                      {t('mobile.filter.clearAll')}
                    </Text>
                  </Pressable>
                ) : null}
                <Pressable onPress={onClose} hitSlop={8} accessibilityRole="button">
                  <Text variant="subheadline" color={brandColors.primary} style={styles.doneLabel}>
                    {t('mobile.filter.done')}
                  </Text>
                </Pressable>
              </View>
            </View>

            <View style={styles.boardSection}>
              <InteractiveFilterBoard
                boardName={boardName}
                layoutId={boardConfig.layoutId}
                sizeId={boardConfig.sizeId}
                setIds={boardConfig.setIds}
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
          </>
        )}
      </View>
    </ModalSheet>
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
    paddingTop: spacing[2],
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
