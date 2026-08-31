import { useCallback, useMemo, useRef, useState } from 'react';
import { Alert, ScrollView, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { useSharedValue } from 'react-native-reanimated';
import type { BoardName, HoldOutlineKind } from '@boardsesh/shared-schema';
import { STATE_TO_PRIMARY_CODE } from '@boardsesh/board-constants/hold-states';
import { hasLedBasePlate } from '@boardsesh/board-config';
import {
  DEFAULT_BRUSH_RADIUS_BOARD_PX,
  MIN_BRUSH_RADIUS_BOARD_PX,
  type BrushRejection,
} from '@boardsesh/board-art-geometry/brush';
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
import { useEffectiveBoardRenderSettings, type HoldGeometryOverride } from '../../hooks/use-native-climb-render';
import { extractGraphqlMessage } from '../../lib/graphql/extract-error-message';
import { getCreateBoardHolds, parseSetIdsParam, type BoardHoldTarget } from '../../lib/create-board-holds';
import { OutlineSvgLayer, type OutlineLayerData } from './OutlineSvgLayer';
import { DrawStrokeOverlay } from './DrawStrokeOverlay';
import { EditToolbar, type DrawMode } from './EditToolbar';
import {
  buildOutlineRing,
  finishOutlineRing,
  radiusRingToBoardPx,
  renderToBoardScale,
  type StrokeRejection,
} from './stroke';
import { spatialPlacementOrder, stepPlacement, zoomTargetForHold } from './hold-navigation';
import { withUnsavedDraftGuard } from './draft-guard';
import { useBrushSession } from './use-brush-session';
import type { RingPoint } from '@boardsesh/board-art-geometry/ring';

// Admin-only screen — hardcoded English literals throughout, matching the
// tester-only development screens.

/**
 * Width of the control rail beside the board on a wide screen, in points.
 *
 * Wide enough for the two step buttons plus the position counter on one row,
 * which is the widest thing the toolbar has to lay out.
 */
const RAIL_WIDTH = 320;

/**
 * Aspect ratio at which the toolbar moves from under the board into a rail
 * beside it.
 *
 * Measured on the editor's own box rather than read off `useDeviceLayout`, so it
 * answers the question that actually matters — is this space wider than it is
 * tall — and gets an iPad in a Split View, an iPad in portrait and a landscape
 * phone each right without any of them being a special case.
 */
const RAIL_MIN_ASPECT = 1.2;

/**
 * Pinch ceiling on this screen, against the board browser's 4x.
 *
 * A hold is a few dozen board pixels across on a board a few thousand wide, and
 * the brush works in board pixels: at 4x the smallest edit that registers is a
 * large fraction of what you can see, which makes precise correction guesswork.
 */
const EDITOR_MAX_SCALE = 12;

/** Brush sizes offered, in board px. Floored at the radius below which a dab is
 *  inside the decimation tolerance and does nothing at all. */
const BRUSH_RADIUS_RANGE = { min: MIN_BRUSH_RADIUS_BOARD_PX, max: 24 };

const NO_POINTS: number[] = [];

/**
 * One undoable step: the outline that was on screen before a stroke, and the
 * brush bitmap that produced it.
 *
 * `outline: null` is a real value, not "nothing" — it is the state before the
 * first stroke on a hold, where the board shows the stored outline and Save is
 * disabled. Undoing back to it has to restore exactly that.
 */
type EditStep = { outline: number[] | null; maskCells: Uint8Array | null };

/**
 * How many strokes back Undo reaches.
 *
 * Each step holds a copy of the brush bitmap, which runs to about a megabyte on
 * the widest board in the catalogue, so this is a memory ceiling as much as a
 * usability one. Ten strokes is more than the "oops" window a brush needs.
 */
const UNDO_LIMIT = 10;

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
 * outline drawn over it by role, and an Apple-Pencil surface for correcting the
 * one that's wrong.
 *
 * Three ways to correct it. Redraw re-traces the whole silhouette in one loop,
 * which is what you want on a hold with no outline at all or one that is wrong
 * everywhere. Add and Erase brush the existing area, which is what you want the
 * rest of the time — most corrections are one lobe out of ten, and re-tracing a
 * hold to fix a lobe throws away nine good ones.
 */
export function OutlineCanvasScreen({ boardName, layoutId, sizeId, setIds }: OutlineCanvasScreenProps) {
  const { systemColors } = useTheme();
  const { showToast } = useToast();

  const [selectedPlacementId, setSelectedPlacementId] = useState<number | null>(null);
  const [editKind, setEditKind] = useState<HoldOutlineKind>('SILHOUETTE');
  const [drawMode, setDrawMode] = useState<DrawMode>('redraw');
  const [brushRadius, setBrushRadius] = useState(DEFAULT_BRUSH_RADIUS_BOARD_PX);
  const [fingerDraw, setFingerDraw] = useState(false);
  const [previewLit, setPreviewLit] = useState(false);
  const [draftOutline, setDraftOutline] = useState<number[] | null>(null);
  // One entry per committed stroke, most recent last. Each carries both halves
  // of the edit: the outline that was on screen, and the raster later strokes
  // compose onto. Rolling back only the outline would leave the next stroke
  // painting on top of the stroke just undone.
  const [undoStack, setUndoStack] = useState<EditStep[]>([]);
  const [errorText, setErrorText] = useState<string | null>(null);
  // TWO measurements, and they must stay separate.
  //
  // `containerBox` is the whole editor's box and decides rail-vs-stacked. It has
  // to be a quantity the branch cannot change, or the layout oscillates: the
  // board's own box is `(W - 320) x H` beside a rail and `W x (H - toolbar)`
  // under one, and the stacked shape is always the wider of the two — so on any
  // screen where `1.2H <= W < 1.2H + 320` (which is every landscape iPad) the
  // stacked layout would ask for a rail, the rail layout would ask for a stack,
  // and `onLayout` would fire forever.
  //
  // `canvasBox` is the board's own box and only ever sizes the board. Measured
  // rather than derived from the window because on a regular-width iPad this
  // screen renders inside the shell's content pane, so `useWindowDimensions()`
  // is wider than the space the board actually has.
  const [containerBox, setContainerBox] = useState({ width: 0, height: 0 });
  const [canvasBox, setCanvasBox] = useState({ width: 0, height: 0 });

  // The live stroke in board px. A shared value, not state: it is written on the
  // UI thread once per kept sample and read by the preview path's
  // useAnimatedProps, so no React render is involved until the stroke ends.
  const draftPointsSV = useSharedValue<number[]>(NO_POINTS);
  const fingerDrawSV = useSharedValue(false);
  // Whether `draftPointsSV` currently holds a live swept path or a committed
  // ring. The SVG layer needs the difference because only the first of those is
  // a brush band; a shared value, so the swap costs no React render.
  const strokeLiveSV = useSharedValue(false);

  // A stroke in progress must not also select a hold. Set from the one
  // stroke-start runOnJS hop rather than per frame.
  const drawingRef = useRef(false);

  // Imperative handle on the board's zoom. Next/Prev live in the toolbar, beside
  // or below the board, so they can't reach the transform through the render-prop
  // context the in-board overlays use.
  const boardControlsRef = useRef<FilterBoardControls | null>(null);

  const brushSession = useBrushSession();

  // Only the Kilter Homewall mounts its holds on a lit plate, so only there is
  // there an inner edge to trace. Everywhere else the editor is single-mode and
  // the toolbar shows no boundary control at all.
  const platedLayout = hasLedBasePlate(boardName, layoutId);
  const effectiveEditKind: HoldOutlineKind = platedLayout ? editKind : 'SILHOUETTE';

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
    if (!boardHolds || canvasBox.width <= 0 || canvasBox.height <= 0) return { width: 0, height: 0 };
    const boardAspect = boardHolds.boardWidth / boardHolds.boardHeight;
    if (canvasBox.width / canvasBox.height > boardAspect) {
      return { width: canvasBox.height * boardAspect, height: canvasBox.height };
    }
    return { width: canvasBox.width, height: canvasBox.width / boardAspect };
  }, [boardHolds, canvasBox]);

  const handleCanvasLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setCanvasBox((current) => (current.width === width && current.height === height ? current : { width, height }));
  }, []);

  const handleContainerLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setContainerBox((current) => (current.width === width && current.height === height ? current : { width, height }));
  }, []);

  const useRail = containerBox.width > 0 && containerBox.width / Math.max(1, containerBox.height) >= RAIL_MIN_ASPECT;

  /** The outline this hold currently carries for the kind being edited, in
   *  radius units, or null when there is nothing to brush yet. */
  const currentOutline = useMemo(() => {
    if (selectedPlacementId == null) return null;
    if (effectiveEditKind === 'LED_INNER') return layerData.ledInnerByPlacement.get(selectedPlacementId) ?? null;
    return (
      layerData.silhouetteByPlacement.get(selectedPlacementId) ??
      layerData.shardByPlacement.get(selectedPlacementId) ??
      null
    );
  }, [selectedPlacementId, effectiveEditKind, layerData]);

  // Brushing needs something to brush. A placement with no outline of this kind
  // has to be traced once before add/erase mean anything, so the toolbar offers
  // Redraw alone there.
  const canBrush = currentOutline != null;

  const clearDraft = useCallback(() => {
    setDraftOutline(null);
    setUndoStack([]);
    strokeLiveSV.value = false;
    draftPointsSV.value = NO_POINTS;
    brushSession.reset();
  }, [draftPointsSV, strokeLiveSV, brushSession]);

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
          maxScale: EDITOR_MAX_SCALE,
        }),
      );
    },
    [holdById, boardHolds, boardRender.width, boardRender.height],
  );

  /**
   * Run `action`, but never throw away a finished outline without asking. The
   * rule itself is `withUnsavedDraftGuard` (pure, and tested); this binds it to
   * the current draft and to the platform dialog that does the asking.
   */
  const withDraftGuard = useCallback(
    (action: () => void) => withUnsavedDraftGuard(draftOutline != null, action, confirmDiscardDraft),
    [draftOutline],
  );

  /**
   * Move the selection, unconditionally dropping whatever draft is in flight.
   *
   * The name is the contract: this is the "yes, discard it" half of the pair and
   * has no guard of its own. Reach it through {@link goToPlacement} (or
   * {@link withDraftGuard}) so an unsaved stroke gets its confirmation — it is
   * separate precisely so the guard can wrap it as the confirm action.
   */
  const selectPlacementUnguarded = useCallback(
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
      withDraftGuard(() => selectPlacementUnguarded(placementId));
    },
    [selectedPlacementId, zoomToPlacement, withDraftGuard, selectPlacementUnguarded],
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
    strokeLiveSV.value = true;
    setErrorText(null);
  }, [strokeLiveSV]);

  const handleStrokeCancel = useCallback(() => {
    // Only a stroke that actually STARTED may clear the preview. The overlay
    // finalizes on every touch it declines too (a finger while only the stylus
    // draws), and without this guard one of those would wipe the preview of an
    // already-validated draft while Save stayed armed — you'd store a ring you
    // could no longer see.
    if (!drawingRef.current) return;
    drawingRef.current = false;
    strokeLiveSV.value = false;
    draftPointsSV.value = NO_POINTS;
  }, [draftPointsSV, strokeLiveSV]);

  /**
   * Refuse a stroke without disturbing what the previous ones built.
   *
   * The draft that is already validated stays BOTH stored and on screen. Wiping
   * only the preview would leave `draftOutline` armed behind an empty board:
   * Save would still be enabled and would write a ring nothing is drawing, and
   * stepping away would raise "discard the outline you drew?" about an outline
   * that is not there. That is the same trap `handleStrokeCancel` guards, and
   * `no-change` walks into it constantly — every add stroke that lands inside
   * the outline reports it.
   */
  const failStroke = useCallback(
    (message: string, hold: BoardHoldTarget | null) => {
      strokeLiveSV.value = false;
      if (draftOutline && hold) {
        const restored = radiusRingToBoardPx(draftOutline, hold);
        draftPointsSV.value = [...restored, restored[0], restored[1]];
      } else {
        draftPointsSV.value = NO_POINTS;
      }
      setErrorText(message);
      showToast(message, 'error');
    },
    [draftPointsSV, showToast, draftOutline, strokeLiveSV],
  );

  /**
   * Show back exactly what would be stored — the decimated, closed ring — rather
   * than the raw stylus trail or the swept brush, so the preview and the write
   * agree. Everything the commit does that the live overlay cannot show (the
   * neck trim, hole filling, dropping an offcut, decimation) becomes visible as
   * this one snap when the pencil lifts.
   */
  /** Record the state a stroke is about to replace, so Undo can return to it. */
  const pushUndoStep = useCallback((step: EditStep) => {
    setUndoStack((stack) => [...stack, step].slice(-UNDO_LIMIT));
  }, []);

  const showCommittedDraft = useCallback(
    (outline: number[], hold: BoardHoldTarget) => {
      strokeLiveSV.value = false;
      const previewBoardRing = radiusRingToBoardPx(outline, hold);
      draftPointsSV.value = [...previewBoardRing, previewBoardRing[0], previewBoardRing[1]];
      setDraftOutline(outline);
    },
    [draftPointsSV, strokeLiveSV],
  );

  const handleStrokeEnd = useCallback(
    (strokeBoardPoints: number[]) => {
      drawingRef.current = false;
      const hold = selectedPlacementId == null ? null : holdById.get(selectedPlacementId);
      if (!hold) {
        strokeLiveSV.value = false;
        draftPointsSV.value = NO_POINTS;
        setErrorText('Tap a hold first, then draw its outline.');
        return;
      }

      // Snapshot BEFORE the stroke, push only if it commits: a refused stroke
      // changes nothing, so it must not leave an undo step that does nothing.
      const stepBefore: EditStep = { outline: draftOutline, maskCells: brushSession.snapshot() };

      if (drawMode === 'redraw' || !canBrush) {
        const result = buildOutlineRing(toRingPoints(strokeBoardPoints), hold);
        // Keep the board and the selection as they are — the fix is to draw
        // again, not to start over.
        if (!result.ok) return failStroke(rejectionMessage(result.reason), hold);
        pushUndoStep(stepBefore);
        showCommittedDraft(result.outline, hold);
        return;
      }

      // Brushing composes on the session's bitmap, so the base outline only
      // seeds the FIRST stroke on this hold: after that, what is on screen is
      // what the previous strokes painted, not the ring they produced.
      const base = draftOutline ?? currentOutline;
      if (!base) return failStroke('That hold has no outline to brush yet. Trace it once with Redraw first.', hold);

      const brushed = brushSession.applyStroke({
        placementId: hold.id,
        editKind: effectiveEditKind,
        hold,
        baseOutlineBoardPx: radiusRingToBoardPx(base, hold),
        strokeBoardPx: strokeBoardPoints,
        brushRadiusBoardPx: brushRadius,
        mode: drawMode,
      });
      if (!brushed.ok) return failStroke(brushRejectionMessage(brushed.reason, drawMode), hold);

      // Back through the same tail the freehand path uses, so the ring the brush
      // produced is rounded, closed and gated exactly as the server will.
      const finished = finishOutlineRing(brushed.outlineBoardPx, hold);
      if (!finished.ok) return failStroke(rejectionMessage(finished.reason), hold);

      pushUndoStep(stepBefore);
      showCommittedDraft(finished.outline, hold);
      if (brushed.droppedPieces > 0) {
        showToast(
          brushed.droppedPieces === 1
            ? 'Kept the piece over the bolt, dropped 1 that came loose.'
            : `Kept the piece over the bolt, dropped ${brushed.droppedPieces} that came loose.`,
          'info',
        );
      }
    },
    [
      selectedPlacementId,
      holdById,
      draftPointsSV,
      drawMode,
      canBrush,
      draftOutline,
      currentOutline,
      brushSession,
      effectiveEditKind,
      brushRadius,
      failStroke,
      showCommittedDraft,
      pushUndoStep,
      showToast,
    ],
  );

  /**
   * Step back one stroke.
   *
   * Restores both halves together — the outline on screen and the brush bitmap
   * behind it — so the next stroke composes onto the raster that produced the
   * outline it can see. Undoing to `outline: null` is a real destination: it is
   * the hold as stored, with Save disarmed.
   */
  const handleUndo = useCallback(() => {
    const previous = undoStack[undoStack.length - 1];
    if (!previous) return;
    setUndoStack((stack) => stack.slice(0, -1));
    setErrorText(null);
    strokeLiveSV.value = false;
    brushSession.restore(previous.maskCells);
    setDraftOutline(previous.outline);

    const hold = selectedPlacementId == null ? null : holdById.get(selectedPlacementId);
    if (previous.outline && hold) {
      const ring = radiusRingToBoardPx(previous.outline, hold);
      draftPointsSV.value = [...ring, ring[0], ring[1]];
    } else {
      draftPointsSV.value = NO_POINTS;
    }
  }, [undoStack, brushSession, selectedPlacementId, holdById, draftPointsSV, strokeLiveSV]);

  const handleSave = useCallback(() => {
    if (!draftOutline || selectedPlacementId == null) return;
    setErrorText(null);
    upsertOverride.mutate(
      {
        boardName,
        layoutId,
        sizeId,
        placementId: selectedPlacementId,
        kind: effectiveEditKind,
        outline: draftOutline,
      },
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
  }, [
    draftOutline,
    selectedPlacementId,
    upsertOverride,
    boardName,
    layoutId,
    sizeId,
    effectiveEditKind,
    clearDraft,
    showToast,
  ]);

  const handleRevert = useCallback(() => {
    if (selectedPlacementId == null) return;
    setErrorText(null);
    deleteOverride.mutate(
      { boardName, layoutId, sizeId, placementId: selectedPlacementId, kind: effectiveEditKind },
      {
        onSuccess: () => {
          clearDraft();
          showToast(
            effectiveEditKind === 'LED_INNER' ? 'Inner edge removed' : 'Reverted to the traced outline',
            'success',
          );
        },
        onError: (error: unknown) => {
          const message = extractGraphqlMessage(error) ?? 'Removing the override failed.';
          setErrorText(message);
          showToast(message, 'error');
        },
      },
    );
  }, [selectedPlacementId, deleteOverride, boardName, layoutId, sizeId, effectiveEditKind, clearDraft, showToast]);

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

  const handleDrawModeChange = useCallback(
    (mode: DrawMode) => {
      // A draft built one way is not a starting point for the other: a redrawn
      // loop has no session bitmap behind it, and a brushed one is mid-edit.
      withDraftGuard(() => {
        setDrawMode(mode);
        setErrorText(null);
        clearDraft();
      });
    },
    [withDraftGuard, clearDraft],
  );

  const hasOverride =
    selectedPlacementId != null && overrideMetaByKey.has(`${selectedPlacementId}:${effectiveEditKind}`);

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
    const meta = overrideMetaByKey.get(`${selectedPlacementId}:${effectiveEditKind}`);
    if (meta) {
      const author = meta.authorDisplayName ?? 'someone';
      return `#${selectedPlacementId} · overridden by ${author} on ${formatUpdatedAt(meta.updatedAt)}`;
    }
    if (effectiveEditKind === 'LED_INNER') return `#${selectedPlacementId} · no inner edge traced yet`;
    return layerData.shardByPlacement.has(selectedPlacementId)
      ? `#${selectedPlacementId} · traced`
      : `#${selectedPlacementId} · missing — the renderer falls back to a plain ring`;
  }, [selectedPlacementId, effectiveEditKind, overrideMetaByKey, layerData.shardByPlacement, placementOrder.length]);

  // ── The lit preview ────────────────────────────────────────────────────
  // The renderer only draws traced outlines in Boardsesh mode, behind a native
  // capability probe. Saying so beats previewing a lie: classic mode would show
  // the same board with a marker on it and none of the geometry being edited.
  const { effectiveRenderSettings, boardseshRendererAvailable } = useEffectiveBoardRenderSettings();
  const previewAvailable =
    selectedPlacementId != null && effectiveRenderSettings.mode === 'boardsesh' && boardseshRendererAvailable === true;

  const previewUnavailableNote = useMemo(() => {
    if (selectedPlacementId == null) return 'Pick a hold to preview it.';
    if (boardseshRendererAvailable === null) return 'Checking whether this build can draw traced outlines…';
    if (!previewAvailable) {
      return 'This build renders in classic mode, which ignores traced outlines, so there is nothing to preview.';
    }
    // A real limitation of what ships, not of the editor: the plate paint is
    // switched off in the renderer, so an inner edge changes no pixels today.
    if (effectiveEditKind === 'LED_INNER') {
      return "The renderer's LED plate is switched off, so an inner edge won't change the preview.";
    }
    return null;
  }, [selectedPlacementId, boardseshRendererAvailable, previewAvailable, effectiveEditKind]);

  const previewFrames = useMemo(() => {
    if (!previewLit || !previewAvailable || selectedPlacementId == null) return '';
    const handCode = STATE_TO_PRIMARY_CODE[boardName]?.HAND;
    return handCode === undefined ? '' : `p${selectedPlacementId}r${handCode}`;
  }, [previewLit, previewAvailable, selectedPlacementId, boardName]);

  /**
   * The geometry the preview renders with: the unsaved draft where there is one,
   * otherwise this hold's stored override, so what lights up is the edit in hand
   * rather than the shard's own version of it.
   *
   * Memoized on the values it is built from because it lands in the render cache
   * key — a new object identity every render would re-key every frame.
   */
  const previewGeometry = useMemo<HoldGeometryOverride | undefined>(() => {
    if (previewFrames === '' || selectedPlacementId == null) return undefined;
    const outline = draftOutline ?? currentOutline;
    if (!outline) return undefined;
    return effectiveEditKind === 'LED_INNER'
      ? { ledInner: { [selectedPlacementId]: outline } }
      : { outlines: { [selectedPlacementId]: outline } };
  }, [previewFrames, selectedPlacementId, draftOutline, currentOutline, effectiveEditKind]);

  const boardScale = renderToBoardScale(boardHolds?.boardWidth ?? 0, boardRender.width);

  const renderInTransform = useCallback(
    () =>
      boardHolds ? (
        <OutlineSvgLayer
          holdTargets={boardHolds.holdTargets}
          holdById={holdById}
          data={layerData}
          selectedPlacementId={selectedPlacementId}
          editKind={effectiveEditKind}
          draftPointsSV={draftPointsSV}
          brushMode={canBrush ? drawMode : 'redraw'}
          brushRadiusBoardPx={brushRadius}
          strokeLiveSV={strokeLiveSV}
          draftOutline={draftOutline}
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
      effectiveEditKind,
      draftPointsSV,
      canBrush,
      drawMode,
      brushRadius,
      strokeLiveSV,
      draftOutline,
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

  const toolbar = (
    <EditToolbar
      editKind={effectiveEditKind}
      onEditKindChange={handleEditKindChange}
      hasLedBasePlate={platedLayout}
      statusLine={statusLine}
      positionLabel={positionLabel}
      onNextPlacement={handleNextPlacement}
      onPreviousPlacement={handlePreviousPlacement}
      canStepPlacement={placementOrder.length > 0}
      errorText={errorText ?? (outlinesQuery.isError ? 'Loading the stored outlines failed.' : null)}
      hasDraft={draftOutline != null}
      canUndo={undoStack.length > 0}
      onUndo={handleUndo}
      onSave={handleSave}
      onDiscardDraft={clearDraft}
      hasOverride={hasOverride}
      onRevert={handleRevert}
      hasSelection={selectedPlacementId != null}
      onDeselect={handleDeselect}
      saving={upsertOverride.isPending || deleteOverride.isPending}
      fingerDraw={fingerDraw}
      onFingerDrawChange={handleFingerDrawChange}
      drawMode={drawMode}
      onDrawModeChange={handleDrawModeChange}
      canBrush={canBrush}
      brushRadiusBoardPx={brushRadius}
      onBrushRadiusChange={setBrushRadius}
      brushRadiusRange={BRUSH_RADIUS_RANGE}
      previewLit={previewLit}
      onPreviewLitChange={setPreviewLit}
      previewAvailable={previewAvailable}
      previewUnavailableNote={previewUnavailableNote}
      layout={useRail ? 'rail' : 'stacked'}
    />
  );

  const board = (
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
      maxScale={EDITOR_MAX_SCALE}
      frames={previewFrames}
      holdGeometryOverride={previewGeometry}
      renderInTransform={renderInTransform}
      renderAboveBoard={renderAboveBoard}
      controlRef={boardControlsRef}
    />
  );

  return (
    <View
      onLayout={handleContainerLayout}
      style={[
        styles.container,
        useRail ? styles.containerRail : styles.containerStacked,
        { backgroundColor: systemColors.background },
      ]}
    >
      <View style={styles.boardSection} onLayout={handleCanvasLayout}>
        {boardRender.width > 0 ? board : null}
      </View>

      {/* `contentInsetAdjustmentBehavior` is not decoration here. In the stacked
          layout the toolbar hangs below the board and never meets the header, but
          in the rail it runs the full height of the screen and its first control
          starts under the translucent nav bar. Letting UIKit supply the inset
          gets the real header height, which JS cannot compute without
          `@react-navigation/elements` (not a dependency here) and which a
          hardcoded number would get wrong on every device that changes it. */}
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentInsetAdjustmentBehavior="automatic"
        style={useRail ? styles.toolbarRail : styles.toolbarScroll}
        contentContainerStyle={useRail ? styles.toolbarRailContent : undefined}
      >
        {toolbar}
      </ScrollView>
    </View>
  );
}

/**
 * Ask before throwing a drawn outline away. Module scope, so the screen's guard
 * callback doesn't rebuild it every render.
 */
function confirmDiscardDraft(onConfirm: () => void): void {
  Alert.alert(
    // i18n-ignore-next-line — admin-only screen
    'Discard the outline you drew?',
    // i18n-ignore-next-line — admin-only screen
    "It hasn't been saved yet.",
    [
      // i18n-ignore-next-line — admin-only screen
      { text: 'Keep drawing', style: 'cancel' },
      // i18n-ignore-next-line — admin-only screen
      { text: 'Discard', style: 'destructive', onPress: onConfirm },
    ],
  );
}

function rejectionMessage(reason: StrokeRejection): string {
  if (reason === 'centre-outside') return "That ring doesn't cover the hold's centre. Draw around the hold you picked.";
  if (reason === 'out-of-bounds') return 'That ring is far bigger than a hold. Zoom in and trace the hold itself.';
  if (reason === 'too-complex') return "That stroke has too much detail to store. Trace the hold's edge in one pass.";
  return 'That stroke is too short to be an outline. Draw a full loop around the hold.';
}

/**
 * What a refused brush stroke tells the user.
 *
 * Each of these is a thing the pipeline genuinely cannot store, and each has a
 * different fix, so they get different sentences rather than one generic
 * refusal — "nothing happened" is the failure mode that makes a brush feel
 * broken.
 */
function brushRejectionMessage(reason: BrushRejection, mode: DrawMode): string {
  if (reason === 'anchor-erased') return "You erased the hold's centre. An outline has to cover its own bolt.";
  if (reason === 'nothing-left') return 'That erased the whole hold. There has to be some outline left.';
  if (reason === 'no-change') {
    return mode === 'erase'
      ? 'Nothing to erase there. Brush across the edge you want to pull in.'
      : 'That is already inside the outline. Brush outside the edge to grow it.';
  }
  if (reason === 'self-intersecting') return 'That left the outline crossing itself. Try a wider brush.';
  if (reason === 'too-complex') return 'That left too much detail to store. Try a wider brush.';
  return 'That left too little outline to store. Try a wider brush.';
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  // Board beside the controls once the space is wider than it is tall. The board
  // flexes and the rail is fixed, so every point the window gains goes to the
  // thing being drawn on.
  containerRail: {
    flexDirection: 'row',
  },
  containerStacked: {
    flexDirection: 'column',
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
  toolbarRail: {
    flexGrow: 0,
    width: RAIL_WIDTH,
  },
  toolbarRailContent: {
    paddingBottom: spacing[4],
  },
});
