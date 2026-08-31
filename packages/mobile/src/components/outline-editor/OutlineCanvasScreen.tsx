import { useCallback, useMemo, useRef, useState } from 'react';
import { Alert, ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSharedValue } from 'react-native-reanimated';
import type { BoardName, HoldOutlineKind } from '@boardsesh/shared-schema';
import { Text } from '../Text';
import { ActivityIndicator } from '../ActivityIndicator';
import {
  InteractiveFilterBoard,
  type FilterBoardControls,
  type FilterBoardTransformContext,
} from '../search/InteractiveFilterBoard';
import { useTheme } from '../../providers/theme-provider';
import { useToast } from '../../providers/toast-provider';
import { spacing } from '../../theme/tokens';
import { useDeleteHoldOutlineOverride, useHoldOutlines, useUpsertHoldOutlineOverride } from '../../lib/graphql/hooks';
import { extractGraphqlMessage } from '../../lib/graphql/extract-error-message';
import { getCreateBoardHolds, parseSetIdsParam, type BoardHoldTarget } from '../../lib/create-board-holds';
import { OutlineSvgLayer, type OutlineLayerData } from './OutlineSvgLayer';
import { DrawStrokeOverlay } from './DrawStrokeOverlay';
import { EditToolbar } from './EditToolbar';
import { buildOutlineRing, radiusRingToBoardPx, renderToBoardScale, type StrokeRejection } from './stroke';
import { spatialPlacementOrder, stepPlacement, zoomTargetForHold } from './hold-navigation';
import type { RingPoint } from '@boardsesh/board-art-geometry/ring';

// Admin-only screen — hardcoded English literals throughout, matching the
// tester-only development screens.

/**
 * Vertical space (px) the chrome around the board needs: the native header plus
 * the edit toolbar (segmented control, status lines, button row, finger-draw
 * switch). A rough constant is enough — the available height is clamped below.
 */
const CHROME_BUDGET = 360;

const NO_POINTS: number[] = [];

type OutlineCanvasScreenProps = {
  boardName: BoardName;
  layoutId: number;
  sizeId: number;
  setIds: string;
};

/** Flat `[x0, y0, ...]` board px → the `[x, y]` pairs `buildOutlineRing` wants. */
function toRingPoints(flat: number[]): RingPoint[] {
  const points: RingPoint[] = [];
  for (let index = 0; index + 1 < flat.length; index += 2) {
    points.push([flat[index], flat[index + 1]]);
  }
  return points;
}

function formatUpdatedAt(iso: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleDateString();
}

/**
 * The hold-outline correction canvas: the board at any zoom, every placement's
 * outline drawn over it by role, and an Apple-Pencil surface for redrawing the
 * one that's wrong.
 *
 * v1 is freehand redraw plus revert. There is no vertex dragging — a whole
 * silhouette is quicker to re-trace with a pencil than to nudge point by point,
 * and the tracer's own decimation runs over the result either way.
 */
export function OutlineCanvasScreen({ boardName, layoutId, sizeId, setIds }: OutlineCanvasScreenProps) {
  const { systemColors } = useTheme();
  const { showToast } = useToast();
  const insets = useSafeAreaInsets();
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();

  const [selectedPlacementId, setSelectedPlacementId] = useState<number | null>(null);
  const [editKind, setEditKind] = useState<HoldOutlineKind>('SILHOUETTE');
  const [fingerDraw, setFingerDraw] = useState(false);
  const [draftOutline, setDraftOutline] = useState<number[] | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);

  // The live stroke in board px. A shared value, not state: it is written on the
  // UI thread once per kept sample and read by the preview path's
  // useAnimatedProps, so no React render is involved until the stroke ends.
  const draftPointsSV = useSharedValue<number[]>(NO_POINTS);
  const fingerDrawSV = useSharedValue(false);

  // A stroke in progress must not also select a hold. Set from the one
  // stroke-start runOnJS hop rather than per frame.
  const drawingRef = useRef(false);

  // Imperative handle on the board's zoom. Next/Prev live in the toolbar, below
  // the board, so they can't reach the transform through the render-prop context
  // the in-board overlays use.
  const boardControlsRef = useRef<FilterBoardControls | null>(null);

  const boardHolds = useMemo(() => {
    if (!boardName) return null;
    return getCreateBoardHolds({ boardName, layoutId, sizeId, setIds: parseSetIdsParam(setIds) });
  }, [boardName, layoutId, sizeId, setIds]);

  const outlinesQuery = useHoldOutlines(boardName ? { boardName, layoutId, sizeId } : null);
  const upsertOverride = useUpsertHoldOutlineOverride();
  const deleteOverride = useDeleteHoldOutlineOverride();

  const layerData = useMemo<OutlineLayerData>(() => {
    const shardByPlacement = new Map<number, number[]>();
    const silhouetteByPlacement = new Map<number, number[]>();
    const ledInnerByPlacement = new Map<number, number[]>();
    const outlines = outlinesQuery.data;
    if (outlines) {
      for (const shard of outlines.shardOutlines) shardByPlacement.set(shard.placementId, shard.outline);
      for (const override of outlines.overrides) {
        const target = override.kind === 'LED_INNER' ? ledInnerByPlacement : silhouetteByPlacement;
        target.set(override.placementId, override.outline);
      }
    }
    return { shardByPlacement, silhouetteByPlacement, ledInnerByPlacement };
  }, [outlinesQuery.data]);

  // Per-placement override metadata, indexed once so the status line is an O(1)
  // lookup rather than a scan of the override list on every render.
  const overrideMetaByKey = useMemo(() => {
    const index = new Map<string, { authorDisplayName: string | null; updatedAt: string }>();
    for (const override of outlinesQuery.data?.overrides ?? []) {
      index.set(`${override.placementId}:${override.kind}`, {
        authorDisplayName: override.authorDisplayName,
        updatedAt: override.updatedAt,
      });
    }
    return index;
  }, [outlinesQuery.data]);

  const holdById = useMemo(() => {
    const index = new Map<number, BoardHoldTarget>();
    for (const hold of boardHolds?.holdTargets ?? []) index.set(hold.id, hold);
    return index;
  }, [boardHolds]);

  const boardRender = useMemo(() => {
    if (!boardHolds) return { width: 0, height: 0 };
    const boardAspect = boardHolds.boardWidth / boardHolds.boardHeight;
    const availableWidth = windowWidth - spacing[4] * 2;
    const availableHeight = Math.max(200, windowHeight - insets.top - insets.bottom - CHROME_BUDGET);
    if (availableWidth / availableHeight > boardAspect) {
      return { width: availableHeight * boardAspect, height: availableHeight };
    }
    return { width: availableWidth, height: availableWidth / boardAspect };
  }, [boardHolds, windowWidth, windowHeight, insets.top, insets.bottom]);

  const clearDraft = useCallback(() => {
    setDraftOutline(null);
    draftPointsSV.value = NO_POINTS;
  }, [draftPointsSV]);

  // Reading order for the whole config, computed once. Next/Prev are then an
  // index step, not a scan, however many hundred placements the board carries.
  const placementOrder = useMemo(() => spatialPlacementOrder(boardHolds?.holdTargets ?? []), [boardHolds]);
  const orderPositionById = useMemo(() => {
    const index = new Map<number, number>();
    placementOrder.forEach((placementId, position) => index.set(placementId, position));
    return index;
  }, [placementOrder]);

  const zoomToPlacement = useCallback(
    (placementId: number) => {
      const hold = holdById.get(placementId);
      if (!hold || !boardHolds || boardRender.width <= 0) return;
      boardControlsRef.current?.zoomTo(
        zoomTargetForHold({
          hold,
          boardWidth: boardHolds.boardWidth,
          renderWidth: boardRender.width,
          renderHeight: boardRender.height,
        }),
      );
    },
    [holdById, boardHolds, boardRender.width, boardRender.height],
  );

  /**
   * Run `action`, but never throw away a finished outline without asking.
   *
   * Selecting another hold, switching kind, stepping to the next placement and
   * deselecting all used to call `clearDraft()` outright, so a stroke that had
   * already passed validation vanished on a stray tap with nothing said. During
   * a mass-correction pass — which is what Next/Prev exist for — that is a lot
   * of silent lost work.
   */
  const withDraftGuard = useCallback(
    (action: () => void) => {
      if (draftOutline == null) {
        action();
        return;
      }
      Alert.alert(
        // i18n-ignore-next-line — admin-only screen
        'Discard the outline you drew?',
        // i18n-ignore-next-line — admin-only screen
        "It hasn't been saved yet.",
        [
          // i18n-ignore-next-line — admin-only screen
          { text: 'Keep drawing', style: 'cancel' },
          // i18n-ignore-next-line — admin-only screen
          { text: 'Discard', style: 'destructive', onPress: action },
        ],
      );
    },
    [draftOutline],
  );

  /**
   * Move the selection, unconditionally dropping whatever draft is in flight.
   *
   * CONTRACT: never call this directly. It is the "yes, discard it" half of the
   * pair and has no guard of its own — put the call behind {@link goToPlacement}
   * (or {@link withDraftGuard}) so an unsaved stroke gets its confirmation. It
   * is separate precisely so the guard can wrap it as the confirm action.
   */
  const selectPlacement = useCallback(
    (placementId: number) => {
      setSelectedPlacementId(placementId);
      setErrorText(null);
      clearDraft();
      zoomToPlacement(placementId);
    },
    [clearDraft, zoomToPlacement],
  );

  /**
   * Move the editor to `placementId`, guarding an unsaved draft on the way.
   *
   * Landing on the hold already selected is a re-frame, not a move: it keeps the
   * draft and just animates the board back onto the hold. That makes tapping the
   * hold you are working on a way to recentre after panning away, instead of a
   * dialog asking whether to throw your own stroke out.
   */
  const goToPlacement = useCallback(
    (placementId: number) => {
      if (placementId === selectedPlacementId) {
        zoomToPlacement(placementId);
        return;
      }
      withDraftGuard(() => selectPlacement(placementId));
    },
    [selectedPlacementId, zoomToPlacement, withDraftGuard, selectPlacement],
  );

  const handleHoldTap = useCallback(
    (holdId: number) => {
      // Reachable: while zoomed the overlay nests inside the pan detector, so a
      // declined touch reaches the board's hold taps. A tap resolved on the UI
      // thread can still land on JS just after a stroke started, so drop it.
      if (drawingRef.current) return;
      goToPlacement(holdId);
    },
    [goToPlacement],
  );

  const handleStepPlacement = useCallback(
    (delta: 1 | -1) => {
      // Index from the Map the counter already maintains, so a press is O(1)
      // rather than a scan of several hundred placements.
      const currentIndex = selectedPlacementId == null ? null : (orderPositionById.get(selectedPlacementId) ?? null);
      const next = stepPlacement(placementOrder, currentIndex, delta);
      if (next == null) return;
      goToPlacement(next);
    },
    [placementOrder, orderPositionById, selectedPlacementId, goToPlacement],
  );

  const handleNextPlacement = useCallback(() => handleStepPlacement(1), [handleStepPlacement]);
  const handlePreviousPlacement = useCallback(() => handleStepPlacement(-1), [handleStepPlacement]);

  const handleDeselect = useCallback(() => {
    withDraftGuard(() => {
      setSelectedPlacementId(null);
      setErrorText(null);
      clearDraft();
      boardControlsRef.current?.resetZoom();
    });
  }, [withDraftGuard, clearDraft]);

  const handleStrokeStart = useCallback(() => {
    drawingRef.current = true;
    setErrorText(null);
  }, []);

  const handleStrokeCancel = useCallback(() => {
    // Only a stroke that actually STARTED may clear the preview. The overlay
    // finalizes on every touch it declines too (a finger while only the stylus
    // draws), and without this guard one of those would wipe the preview of an
    // already-validated draft while Save stayed armed — you'd store a ring you
    // could no longer see.
    if (!drawingRef.current) return;
    drawingRef.current = false;
    draftPointsSV.value = NO_POINTS;
  }, [draftPointsSV]);

  const handleStrokeEnd = useCallback(
    (strokeBoardPoints: number[]) => {
      drawingRef.current = false;
      const hold = selectedPlacementId == null ? null : holdById.get(selectedPlacementId);
      if (!hold) {
        draftPointsSV.value = NO_POINTS;
        setErrorText('Tap a hold first, then draw its outline.');
        return;
      }
      const result = buildOutlineRing(toRingPoints(strokeBoardPoints), hold);
      if (!result.ok) {
        // Keep the board and the selection as they are — the fix is to draw
        // again, not to start over.
        draftPointsSV.value = NO_POINTS;
        setErrorText(rejectionMessage(result.reason));
        showToast(rejectionMessage(result.reason), 'error');
        return;
      }
      // Show back exactly what would be stored — the decimated, closed ring —
      // rather than the raw stylus trail, so the preview and the write agree.
      const previewBoardRing = radiusRingToBoardPx(result.outline, hold);
      draftPointsSV.value = [...previewBoardRing, previewBoardRing[0], previewBoardRing[1]];
      setDraftOutline(result.outline);
    },
    [selectedPlacementId, holdById, draftPointsSV, showToast],
  );

  const handleSave = useCallback(() => {
    if (!draftOutline || selectedPlacementId == null) return;
    setErrorText(null);
    upsertOverride.mutate(
      { boardName, layoutId, sizeId, placementId: selectedPlacementId, kind: editKind, outline: draftOutline },
      {
        onSuccess: () => {
          clearDraft();
          showToast('Outline saved', 'success');
        },
        onError: (error: unknown) => {
          const message = extractGraphqlMessage(error) ?? 'Saving the outline failed.';
          setErrorText(message);
          showToast(message, 'error');
        },
      },
    );
  }, [draftOutline, selectedPlacementId, upsertOverride, boardName, layoutId, sizeId, editKind, clearDraft, showToast]);

  const handleRevert = useCallback(() => {
    if (selectedPlacementId == null) return;
    setErrorText(null);
    deleteOverride.mutate(
      { boardName, layoutId, sizeId, placementId: selectedPlacementId, kind: editKind },
      {
        onSuccess: () => {
          clearDraft();
          showToast(editKind === 'LED_INNER' ? 'Annotation removed' : 'Reverted to the traced outline', 'success');
        },
        onError: (error: unknown) => {
          const message = extractGraphqlMessage(error) ?? 'Removing the override failed.';
          setErrorText(message);
          showToast(message, 'error');
        },
      },
    );
  }, [selectedPlacementId, deleteOverride, boardName, layoutId, sizeId, editKind, clearDraft, showToast]);

  const handleFingerDrawChange = useCallback(
    (next: boolean) => {
      setFingerDraw(next);
      fingerDrawSV.value = next;
    },
    [fingerDrawSV],
  );

  const handleEditKindChange = useCallback(
    (kind: HoldOutlineKind) => {
      withDraftGuard(() => {
        setEditKind(kind);
        setErrorText(null);
        clearDraft();
      });
    },
    [withDraftGuard, clearDraft],
  );

  const hasOverride = selectedPlacementId != null && overrideMetaByKey.has(`${selectedPlacementId}:${editKind}`);

  // "14 / 499" — mass correction is the job this screen exists for, so how far
  // through the board you are belongs on screen.
  const positionLabel = useMemo(() => {
    if (selectedPlacementId == null) return null;
    const position = orderPositionById.get(selectedPlacementId);
    return position == null ? null : `${position + 1} / ${placementOrder.length}`;
  }, [selectedPlacementId, orderPositionById, placementOrder.length]);

  const statusLine = useMemo(() => {
    if (selectedPlacementId == null) {
      return placementOrder.length > 0
        ? `Tap a hold to select it, or press Next. ${placementOrder.length} placements.`
        : 'Tap a hold to select it, then draw its outline.';
    }
    const meta = overrideMetaByKey.get(`${selectedPlacementId}:${editKind}`);
    if (meta) {
      const author = meta.authorDisplayName ?? 'someone';
      return `#${selectedPlacementId} · overridden by ${author} on ${formatUpdatedAt(meta.updatedAt)}`;
    }
    if (editKind === 'LED_INNER') return `#${selectedPlacementId} · no LED ring annotation yet`;
    return layerData.shardByPlacement.has(selectedPlacementId)
      ? `#${selectedPlacementId} · traced`
      : `#${selectedPlacementId} · missing — the renderer falls back to a plain ring`;
  }, [selectedPlacementId, editKind, overrideMetaByKey, layerData.shardByPlacement, placementOrder.length]);

  const boardScale = renderToBoardScale(boardHolds?.boardWidth ?? 0, boardRender.width);

  const renderInTransform = useCallback(
    () =>
      boardHolds ? (
        <OutlineSvgLayer
          holdTargets={boardHolds.holdTargets}
          holdById={holdById}
          data={layerData}
          selectedPlacementId={selectedPlacementId}
          editKind={editKind}
          draftPointsSV={draftPointsSV}
          boardWidth={boardHolds.boardWidth}
          boardHeight={boardHolds.boardHeight}
          renderWidth={boardRender.width}
          renderHeight={boardRender.height}
        />
      ) : null,
    [
      boardHolds,
      holdById,
      layerData,
      selectedPlacementId,
      editKind,
      draftPointsSV,
      boardRender.width,
      boardRender.height,
    ],
  );

  // Mounted only while a placement is selected. Before that the pencil has to be
  // able to TAP a hold, and this overlay would swallow the tap and answer "pick a
  // hold first" — so the board keeps its own gestures until there is something to
  // draw on. "Pick another hold" in the toolbar unmounts it again.
  const renderAboveBoard = useCallback(
    (context: FilterBoardTransformContext) =>
      selectedPlacementId == null ? null : (
        <DrawStrokeOverlay
          pointsSV={draftPointsSV}
          fingerDrawSV={fingerDrawSV}
          scaleSV={context.scaleSV}
          translateXSV={context.translateXSV}
          translateYSV={context.translateYSV}
          containerWidthSV={context.containerWidthSV}
          containerHeightSV={context.containerHeightSV}
          boardScale={boardScale}
          pinchRef={context.pinchRef}
          onStrokeStart={handleStrokeStart}
          onStrokeEnd={handleStrokeEnd}
          onStrokeCancel={handleStrokeCancel}
        />
      ),
    [
      selectedPlacementId,
      draftPointsSV,
      fingerDrawSV,
      boardScale,
      handleStrokeStart,
      handleStrokeEnd,
      handleStrokeCancel,
    ],
  );

  if (!boardHolds || !boardName) {
    return (
      <View style={[styles.centered, { backgroundColor: systemColors.background }]}>
        <Text variant="headline">This board configuration has no hold geometry.</Text>
      </View>
    );
  }

  if (outlinesQuery.isLoading) {
    return (
      <View style={[styles.centered, { backgroundColor: systemColors.background }]}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: systemColors.background }]}>
      <View style={styles.boardSection}>
        <InteractiveFilterBoard
          boardName={boardName}
          layoutId={layoutId}
          sizeId={sizeId}
          setIds={setIds}
          boardWidth={boardHolds.boardWidth}
          boardHeight={boardHolds.boardHeight}
          holdTargets={boardHolds.holdTargets}
          activeHoldId={selectedPlacementId}
          onHoldTap={handleHoldTap}
          showHoldMarkers={false}
          renderWidth={boardRender.width}
          renderHeight={boardRender.height}
          renderInTransform={renderInTransform}
          renderAboveBoard={renderAboveBoard}
          controlRef={boardControlsRef}
        />
      </View>

      <ScrollView keyboardShouldPersistTaps="handled" style={styles.toolbarScroll}>
        <EditToolbar
          editKind={editKind}
          onEditKindChange={handleEditKindChange}
          statusLine={statusLine}
          positionLabel={positionLabel}
          onNextPlacement={handleNextPlacement}
          onPreviousPlacement={handlePreviousPlacement}
          canStepPlacement={placementOrder.length > 0}
          errorText={errorText ?? (outlinesQuery.isError ? 'Loading the stored outlines failed.' : null)}
          hasDraft={draftOutline != null}
          onSave={handleSave}
          onDiscardDraft={clearDraft}
          hasOverride={hasOverride}
          onRevert={handleRevert}
          hasSelection={selectedPlacementId != null}
          onDeselect={handleDeselect}
          saving={upsertOverride.isPending || deleteOverride.isPending}
          fingerDraw={fingerDraw}
          onFingerDrawChange={handleFingerDrawChange}
        />
      </ScrollView>
    </View>
  );
}

function rejectionMessage(reason: StrokeRejection): string {
  if (reason === 'centre-outside') return "That ring doesn't cover the hold's centre. Draw around the hold you picked.";
  if (reason === 'out-of-bounds') return 'That ring is far bigger than a hold. Zoom in and trace the hold itself.';
  if (reason === 'too-complex') return "That stroke has too much detail to store. Trace the hold's edge in one pass.";
  return 'That stroke is too short to be an outline. Draw a full loop around the hold.';
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing[4],
  },
  boardSection: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  toolbarScroll: {
    flexGrow: 0,
  },
});
