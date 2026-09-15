import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Alert, ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSharedValue } from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';
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
import { extractGraphqlMessage } from '../../lib/graphql/extract-error-message';
import type { BoardHoldTarget } from '../../lib/create-board-holds';
import { getSprayWall, SPRAY_BOARD_NAME, subscribeToSprayWalls } from '../../lib/spray/spray-wall-registry';
import { useSprayWall } from '../../lib/spray/use-spray-wall';
import { useSaveSprayHolds } from '../../lib/spray/use-spray-hold-writes';
import { DrawStrokeOverlay } from './DrawStrokeOverlay';
import { SprayHoldSvgLayer } from './SprayHoldSvgLayer';
import { SprayEditToolbar, type SprayEditorTool } from './SprayEditToolbar';
import { renderToBoardScale, type StrokeRejection } from './stroke';
import { buildSprayHoldWritePlan, planHasWork } from './spray-hold-writes';
import { withUnsavedDraftGuard } from './draft-guard';
import {
  editorCounts,
  hasUnsavedWork as stateHasUnsavedWork,
  initialSprayEditorState,
  sprayEditorReducer,
  visibleHolds,
  type SprayEditorHold,
} from './spray-hold-editor-reducer';
import {
  classifyStroke,
  defaultHoldRadius,
  holdAtPoint,
  holdFromStroke,
  holdFromTap,
  SIZE_PRESETS,
  toBoardHoldTarget,
  toRingPoints,
  type SizePresetKey,
} from './spray-hold-tools';

/** Vertical space the chrome around the board needs — see `OutlineCanvasScreen`. */
const CHROME_BUDGET = 420;

const NO_POINTS: number[] = [];

/**
 * One detector candidate, in PHOTO pixels of the draft version's photo.
 *
 * Handed in rather than fetched because detection runs on the device (epic
 * decision 2026-09-15: trust the client's detections) and SW-06 owns where. The
 * editor's only opinion is that a candidate is drawn and never written until
 * somebody rules on it.
 */
export type SprayHoldCandidate = {
  cx: number;
  cy: number;
  r: number;
  /** Radius-unit ring, or null for a plain circle. */
  outline?: number[] | null;
  /** 0–1. Drives the threshold slider and the low-confidence styling. */
  confidence: number;
};

export type SprayHoldSaveSummary = {
  written: number;
  removed: number;
};

export type SprayHoldEditorScreenProps = {
  /** The wall being edited. Names the mutations' `wallUuid`. */
  wallUuid: string;
  /** The wall's `board_layouts` id — also its size id, and the SW-07 registry's key. */
  layoutId: number;
  /** `SprayWallVersion.id` of the wall's ONE open draft. Every write lands on it. */
  versionId: string;
  /** `SprayWall.viewerCanEdit`. False renders the read-only notice and no tools. */
  viewerCanEdit: boolean;
  /** The draft version's row-major photo→canonical homography (9 floats). */
  homography: readonly number[];
  /** Detector output awaiting review. Omit for the manual-only, zero-detection flow. */
  candidates?: readonly SprayHoldCandidate[];
  /** Fired after each successful save, with what the server actually applied. */
  onSaved?: (summary: SprayHoldSaveSummary) => void;
};

/**
 * The spray-wall hold editor (issue #5441).
 *
 * The same board surface, stroke chain and draw overlay the catalogue outline
 * editor uses — `DrawStrokeOverlay` is byte-identical here, so the
 * `manualActivation` + `pinchRef` coexistence that makes a zoomed board still
 * pannable mid-edit is not re-implemented and cannot drift.
 *
 * What changes is what a stroke MEANS. On a board, the holds are the
 * manufacturer's and a stroke can only redraw the boundary around one. On a wall
 * the holds themselves are the work, so a stroke is read through the active tool
 * — `classifyStroke` says tap or drag, the tool says what that does — and the
 * result goes through one pure reducer with undo. No gesture in this file knows
 * about holds, and no reducer action knows about gestures.
 *
 * Coordinates are the photograph's own pixels everywhere on screen. The single
 * hop into canonical wall coordinates happens in `buildSprayHoldWritePlan`, at
 * save time, once.
 */
export function SprayHoldEditorScreen({
  wallUuid,
  layoutId,
  versionId,
  viewerCanEdit,
  homography,
  candidates,
  onSaved,
}: SprayHoldEditorScreenProps) {
  const { systemColors } = useTheme();
  const { showToast } = useToast();
  const { t } = useTranslation('boards');
  const insets = useSafeAreaInsets();
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();

  const { isLoading, isUnrenderable } = useSprayWall(layoutId);
  const saveHolds = useSaveSprayHolds();

  const [tool, setTool] = useState<SprayEditorTool>('pan');
  const [errorText, setErrorText] = useState<string | null>(null);
  const [state, dispatch] = useReducer(sprayEditorReducer, undefined, () => initialSprayEditorState());

  const draftPointsSV = useSharedValue<number[]>(NO_POINTS);
  const fingerDrawSV = useSharedValue(false);
  const drawingRef = useRef(false);
  const boardControlsRef = useRef<FilterBoardControls | null>(null);

  // The registry is a module-level map written by `useSprayWall`, so the screen
  // subscribes to it rather than re-reading it every render — the same
  // `useSyncExternalStore` shape every other spray surface uses.
  const [registryVersion, setRegistryVersion] = useState(0);
  useEffect(() => subscribeToSprayWalls(() => setRegistryVersion((previous) => previous + 1)), []);
  const wall = useMemo(() => getSprayWall(layoutId), [layoutId, registryVersion]);

  // Seed the editor whenever the wall's own holds change underneath it (the
  // first load, and every save's refetch). Candidates are appended as PENDING,
  // so they are drawn from the first frame and written by nothing until accepted.
  useEffect(() => {
    if (!wall) return;
    const stored: SprayEditorHold[] = wall.holds.map((hold) => ({
      id: hold.id,
      cx: hold.cx,
      cy: hold.cy,
      r: hold.r,
      outline: hold.outline ? [...hold.outline] : null,
      source: 'MANUAL',
      confidence: null,
      review: 'accepted',
      dirty: false,
    }));
    let nextLocalId = -1;
    const pending: SprayEditorHold[] = (candidates ?? []).map((candidate) => ({
      id: nextLocalId--,
      cx: candidate.cx,
      cy: candidate.cy,
      r: candidate.r,
      outline: candidate.outline ? [...candidate.outline] : null,
      source: 'AUTO',
      confidence: candidate.confidence,
      review: 'pending',
      dirty: false,
    }));
    dispatch({ type: 'LOAD', holds: [...stored, ...pending] });
  }, [wall, candidates]);

  const boardRender = useMemo(() => {
    if (!wall) return { width: 0, height: 0 };
    const boardAspect = wall.photoWidth / wall.photoHeight;
    const availableWidth = windowWidth - spacing[4] * 2;
    const availableHeight = Math.max(200, windowHeight - insets.top - insets.bottom - CHROME_BUDGET);
    if (availableWidth / availableHeight > boardAspect) {
      return { width: availableHeight * boardAspect, height: availableHeight };
    }
    return { width: availableWidth, height: availableWidth / boardAspect };
  }, [wall, windowWidth, windowHeight, insets.top, insets.bottom]);

  const holds = useMemo(() => visibleHolds(state), [state]);
  const counts = useMemo(() => editorCounts(state), [state]);
  const hasUnsaved = useMemo(() => stateHasUnsavedWork(state), [state]);

  // The board's own tap layer still gets targets, for the `pan` tool where the
  // draw overlay declines every touch and the board handles selection itself.
  const holdTargets = useMemo<BoardHoldTarget[]>(() => holds.map(toBoardHoldTarget), [holds]);

  /** The hold size a tap places, and the unit the S/M/L/XL presets scale. */
  const medianRadius = useMemo(() => defaultHoldRadius(holds, wall?.photoWidth ?? 0), [holds, wall?.photoWidth]);

  useEffect(() => {
    // `pan` is the tool that hands touches back to the board. Every other tool
    // draws, which on a phone means the finger has to be allowed to.
    fingerDrawSV.value = tool !== 'pan';
  }, [tool, fingerDrawSV]);

  const clearStroke = useCallback(() => {
    draftPointsSV.value = NO_POINTS;
  }, [draftPointsSV]);

  const select = useCallback((ids: readonly number[]) => {
    dispatch({ type: 'SELECT', ids });
  }, []);

  const handleHoldTap = useCallback((holdId: number) => {
    if (drawingRef.current) return;
    setErrorText(null);
    dispatch({ type: 'TOGGLE_SELECT', id: holdId });
  }, []);

  const handleStrokeStart = useCallback(() => {
    drawingRef.current = true;
    setErrorText(null);
  }, []);

  const handleStrokeCancel = useCallback(() => {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    clearStroke();
  }, [clearStroke]);

  const handleStrokeEnd = useCallback(
    (strokeBoardPoints: number[]) => {
      drawingRef.current = false;
      clearStroke();
      if (!viewerCanEdit) return;

      const points = toRingPoints(strokeBoardPoints);
      const gesture = classifyStroke(points, medianRadius);
      if (!gesture) return;

      if (gesture.kind === 'tap') {
        const hit = holdAtPoint(holds, gesture.x, gesture.y);
        // A tap on an existing hold always selects it, whatever the tool: on a
        // wall with 600 holds there is almost nowhere that is not a hold, and a
        // tool that dropped a new hold on top of an old one would make the
        // editor unusable exactly where it is needed most.
        if (hit) {
          dispatch({ type: 'TOGGLE_SELECT', id: hit.id });
          return;
        }
        if (tool !== 'add') {
          select([]);
          return;
        }
        dispatch({ type: 'ADD_HOLD', geometry: holdFromTap(gesture.x, gesture.y, medianRadius) });
        return;
      }

      if (tool === 'move') {
        const grabbed = holdAtPoint(holds, gesture.fromX, gesture.fromY) ?? singleSelection(state.selectedIds, holds);
        if (!grabbed) {
          setErrorText(t('sprayEditor.errors.nothingToMove'));
          return;
        }
        dispatch({
          type: 'MOVE_HOLD',
          id: grabbed.id,
          cx: grabbed.cx + (gesture.toX - gesture.fromX),
          cy: grabbed.cy + (gesture.toY - gesture.fromY),
        });
        select([grabbed.id]);
        return;
      }

      // `add` and `draw` both turn a loop into a silhouette; they differ only in
      // where it lands — a brand new hold, or the selected one's outline.
      const drawn = holdFromStroke(gesture.points);
      if (!drawn.ok) {
        const message = rejectionMessage(drawn.reason, t);
        setErrorText(message);
        showToast(message, 'error');
        return;
      }

      if (tool === 'draw') {
        const target = singleSelection(state.selectedIds, holds);
        if (!target) {
          setErrorText(t('sprayEditor.errors.pickOneToRedraw'));
          return;
        }
        dispatch({ type: 'SET_OUTLINE', id: target.id, geometry: drawn.hold });
        return;
      }

      dispatch({ type: 'ADD_HOLD', geometry: drawn.hold });
    },
    [viewerCanEdit, clearStroke, medianRadius, holds, tool, state.selectedIds, select, showToast, t],
  );

  const handleResize = useCallback(
    (presetKey: SizePresetKey) => {
      const target = singleSelection(state.selectedIds, holds);
      const preset = SIZE_PRESETS.find((candidate) => candidate.key === presetKey);
      if (!target || !preset) return;
      dispatch({ type: 'RESIZE_HOLD', id: target.id, r: medianRadius * preset.scale });
    },
    [state.selectedIds, holds, medianRadius],
  );

  const handleDelete = useCallback(() => {
    if (state.selectedIds.length === 0) return;
    dispatch({ type: 'DELETE', ids: state.selectedIds });
  }, [state.selectedIds]);

  const handleMerge = useCallback(() => {
    if (state.selectedIds.length !== 2) {
      setErrorText(t('sprayEditor.errors.mergeNeedsTwo'));
      return;
    }
    dispatch({ type: 'MERGE', ids: state.selectedIds });
  }, [state.selectedIds, t]);

  const handleAcceptSelected = useCallback(() => {
    dispatch({ type: 'ACCEPT', ids: state.selectedIds });
  }, [state.selectedIds]);

  // Rejecting a candidate is deleting it — it never became a hold, so there is
  // nothing else for "no" to mean.
  const handleRejectSelected = handleDelete;

  const handleAcceptAll = useCallback(() => dispatch({ type: 'ACCEPT_ALL' }), []);
  const handleUndo = useCallback(() => dispatch({ type: 'UNDO' }), []);
  const handleRedo = useCallback(() => dispatch({ type: 'REDO' }), []);
  const handleThresholdChange = useCallback((threshold: number) => dispatch({ type: 'SET_THRESHOLD', threshold }), []);

  const handleSave = useCallback(() => {
    const plan = buildSprayHoldWritePlan(state, homography);
    if (!planHasWork(plan)) return;
    if (plan.overCap) {
      setErrorText(t('sprayEditor.errors.tooManyHolds'));
      return;
    }
    setErrorText(null);
    saveHolds.mutate(
      { wallUuid, versionId, plan },
      {
        onSuccess: (result) => {
          if (plan.unmappableIds.length > 0) {
            showToast(t('sprayEditor.toast.someHoldsSkipped', { value: plan.unmappableIds.length }), 'error');
          } else {
            showToast(t('sprayEditor.toast.saved', { value: result.written }), 'success');
          }
          onSaved?.(result);
        },
        onError: (error: unknown) => {
          const message = extractGraphqlMessage(error) ?? t('sprayEditor.errors.saveFailed');
          setErrorText(message);
          showToast(message, 'error');
        },
      },
    );
  }, [state, homography, saveHolds, wallUuid, versionId, showToast, onSaved, t]);

  const handleToolChange = useCallback((next: SprayEditorTool) => {
    setErrorText(null);
    setTool(next);
  }, []);

  const statusLine = useMemo(() => {
    if (!viewerCanEdit) return t('sprayEditor.status.readOnly');
    if (state.selectedIds.length === 2) return t('sprayEditor.status.twoSelected');
    if (state.selectedIds.length === 1) return t('sprayEditor.status.oneSelected', { id: state.selectedIds[0] });
    if (tool === 'add') return t('sprayEditor.status.add');
    if (tool === 'move') return t('sprayEditor.status.move');
    if (tool === 'draw') return t('sprayEditor.status.draw');
    return t('sprayEditor.status.pan');
  }, [viewerCanEdit, state.selectedIds, tool, t]);

  const boardScale = renderToBoardScale(wall?.photoWidth ?? 0, boardRender.width);

  const renderInTransform = useCallback(
    () =>
      wall ? (
        <SprayHoldSvgLayer
          holds={holds}
          threshold={state.threshold}
          selectedIds={state.selectedIds}
          draftPointsSV={draftPointsSV}
          boardWidth={wall.photoWidth}
          boardHeight={wall.photoHeight}
          renderWidth={boardRender.width}
          renderHeight={boardRender.height}
        />
      ) : null,
    [wall, holds, state.threshold, state.selectedIds, draftPointsSV, boardRender.width, boardRender.height],
  );

  // Mounted for every tool but `pan`, which is the tool that exists so the board
  // can be panned and zoomed with a finger. Unmounting it there is stronger than
  // declining touches: RNGH never sees the detector at all.
  const renderAboveBoard = useCallback(
    (context: FilterBoardTransformContext) =>
      tool === 'pan' ? null : (
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
    [tool, draftPointsSV, fingerDrawSV, boardScale, handleStrokeStart, handleStrokeEnd, handleStrokeCancel],
  );

  if (isLoading) {
    return (
      <View style={[styles.centered, { backgroundColor: systemColors.background }]}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  if (!wall || isUnrenderable) {
    return (
      <View style={[styles.centered, { backgroundColor: systemColors.background }]}>
        <Text variant="headline" style={styles.centeredText}>
          {t('sprayEditor.empty.noPhoto')}
        </Text>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: systemColors.background }]}>
      <View style={styles.boardSection}>
        <InteractiveFilterBoard
          boardName={SPRAY_BOARD_NAME}
          layoutId={layoutId}
          sizeId={layoutId}
          setIds=""
          boardWidth={wall.photoWidth}
          boardHeight={wall.photoHeight}
          holdTargets={holdTargets}
          activeHoldId={state.selectedIds[0] ?? null}
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
        <SprayEditToolbar
          tool={tool}
          onToolChange={handleToolChange}
          counts={counts}
          statusLine={statusLine}
          errorText={errorText}
          selectedCount={state.selectedIds.length}
          onDelete={handleDelete}
          onMerge={handleMerge}
          onResize={handleResize}
          onAcceptSelected={handleAcceptSelected}
          onRejectSelected={handleRejectSelected}
          onAcceptAll={handleAcceptAll}
          canUndo={state.past.length > 0}
          canRedo={state.future.length > 0}
          onUndo={handleUndo}
          onRedo={handleRedo}
          threshold={state.threshold}
          onThresholdChange={handleThresholdChange}
          onSave={handleSave}
          saving={saveHolds.isPending}
          hasUnsavedWork={viewerCanEdit && hasUnsaved}
        />
      </ScrollView>
    </View>
  );
}

/** The one selected hold, or null when nothing (or more than one) is selected. */
function singleSelection(selectedIds: readonly number[], holds: readonly SprayEditorHold[]): SprayEditorHold | null {
  if (selectedIds.length !== 1) return null;
  return holds.find((hold) => hold.id === selectedIds[0]) ?? null;
}

type Translate = (key: string, options?: Record<string, unknown>) => string;

function rejectionMessage(reason: StrokeRejection, t: Translate): string {
  if (reason === 'centre-outside') return t('sprayEditor.errors.strokeNotClosed');
  if (reason === 'out-of-bounds') return t('sprayEditor.errors.strokeTooBig');
  if (reason === 'too-complex') return t('sprayEditor.errors.strokeTooDetailed');
  return t('sprayEditor.errors.strokeTooShort');
}

/**
 * Ask before leaving with unsaved holds on screen.
 *
 * Exported rather than wired to a navigation listener here: SW-09 owns the route
 * this screen sits on and therefore owns its back button, and a guard installed
 * from inside would fight the one the route installs. The RULE is
 * `withUnsavedDraftGuard`, shared with the catalogue editor.
 */
export function confirmDiscardSprayEdits(
  hasUnsaved: boolean,
  action: () => void,
  strings: { title: string; message: string; keep: string; discard: string },
): void {
  withUnsavedDraftGuard(hasUnsaved, action, (onConfirm) => {
    Alert.alert(strings.title, strings.message, [
      { text: strings.keep, style: 'cancel' },
      { text: strings.discard, style: 'destructive', onPress: onConfirm },
    ]);
  });
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
  centeredText: {
    textAlign: 'center',
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
