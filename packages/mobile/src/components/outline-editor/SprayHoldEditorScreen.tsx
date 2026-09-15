import { useCallback, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from 'react';
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
import { useSprayWallDraft } from '../../lib/spray/use-spray-wall-draft';
import { useSaveSprayHolds } from '../../lib/spray/use-spray-hold-writes';
import { DrawStrokeOverlay } from './DrawStrokeOverlay';
import { SprayHoldSvgLayer } from './SprayHoldSvgLayer';
import { SprayEditToolbar, type SprayEditorTool } from './SprayEditToolbar';
import { renderToBoardScale, type StrokeRejection } from './stroke';
import { buildSprayHoldWritePlan, planHasWork } from './spray-hold-writes';
import {
  buildEditorSeed,
  holdsToCarryOver,
  seedIncludesCandidates,
  seedReason,
  sprayEditorSeedKey,
} from './spray-hold-seed';
import type { SprayHoldCandidate, SprayHoldSaveSummary } from './spray-hold-editor-types';
import { editorTargetCapabilities, type SprayWallEditorTarget } from './editor-target';
import { withUnsavedDraftGuard } from './draft-guard';
import {
  editorCounts,
  filterVisible,
  holdsInIdOrder,
  hasUnsavedWork as stateHasUnsavedWork,
  initialSprayEditorState,
  sprayEditorReducer,
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

// Re-exported so a caller that opens this screen imports one module. The shapes
// themselves live in `spray-hold-editor-types.ts`, which has no React in it, so
// the pure seeding rules can name a candidate without pulling the board surface
// into their test.
export type { SprayHoldCandidate, SprayHoldSaveSummary };

export type SprayHoldEditorScreenProps = {
  /** The wall being edited. Names the mutations' `wallUuid`. */
  wallUuid: string;
  /** The wall's `board_layouts` id — also its size id, and the SW-07 registry's key. */
  layoutId: number;
  /** `SprayWallVersion.id` of the wall's ONE open draft. Every write lands on it. */
  versionId: string;
  /**
   * `SprayWallVersion.number` of that same draft — 1-based and dense per wall.
   *
   * Both come off one row and both are needed: the id is what the mutations
   * take, the number is what `sprayWallRenderData(uuid, version)` reads. Without
   * the number the editor would be seeded from the PUBLISHED generation, which
   * carries neither the draft's holds nor the draft's photograph.
   */
  versionNumber: number;
  /** `SprayWall.viewerCanEdit`. False renders the tools disabled and never writes. */
  viewerCanEdit: boolean;
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
  versionNumber,
  viewerCanEdit,
  candidates,
  onSaved,
}: SprayHoldEditorScreenProps) {
  const { systemColors } = useTheme();
  const { showToast } = useToast();
  const { t } = useTranslation('boards');
  const insets = useSafeAreaInsets();
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();

  const { isLoading, isUnavailable, homography } = useSprayWallDraft(layoutId, wallUuid, versionNumber);
  const saveHolds = useSaveSprayHolds();

  // The capabilities the adapter names for this target, read rather than
  // re-decided: `fingerDrawDefault` is why the wall opens with a tool that draws
  // where the catalogue target opens stylus-only.
  const capabilities = useMemo(() => {
    const target: SprayWallEditorTarget = { kind: 'sprayWall', wallUuid, layoutId, versionId, viewerCanEdit };
    return editorTargetCapabilities(target);
  }, [wallUuid, layoutId, versionId, viewerCanEdit]);

  const [tool, setTool] = useState<SprayEditorTool>('pan');
  const [errorText, setErrorText] = useState<string | null>(null);
  const [state, dispatch] = useReducer(sprayEditorReducer, undefined, () => initialSprayEditorState());

  const draftPointsSV = useSharedValue<number[]>(NO_POINTS);
  const fingerDrawSV = useSharedValue(false);
  const drawingRef = useRef(false);
  const boardControlsRef = useRef<FilterBoardControls | null>(null);

  // The registry is a module-level map, so the wall is read through
  // `useSyncExternalStore` — the same shape `useSprayWall` uses. Its own
  // `loadState` snapshot does NOT move when a wall is re-registered at the same
  // state (which is exactly what a save's refresh does), so the screen has to
  // subscribe to the wall itself or it would keep drawing the pre-save holds.
  // The snapshot is the registry's own object, so it is referentially stable
  // between registrations and the store never loops.
  const wall = useSyncExternalStore(
    subscribeToSprayWalls,
    useCallback(() => getSprayWall(layoutId), [layoutId]),
  );

  /**
   * A save has landed and the payload carrying what it wrote has not arrived yet.
   *
   * A ref, not state: it is a latch between two async events, and rendering on it
   * would change nothing on screen. Armed on save, disarmed by the arrival of a
   * payload that is both newer than the save and not the one already seeded —
   * see `spray-hold-seed.ts` for why neither test is enough on its own.
   */
  const awaitingSavedPayloadRef = useRef(false);
  const saveStartedAtMsRef = useRef<number | null>(null);

  // The WALL and its VERSION. The detector run is tracked separately, by array
  // identity: folding its COUNT in here made a fresh run of the same length
  // invisible and a run of a different length look like a new version.
  const seedKey = sprayEditorSeedKey(wall);
  const seededKeyRef = useRef<string | null>(null);
  const seededWallRef = useRef<typeof wall>(null);
  const seededCandidatesRef = useRef<readonly SprayHoldCandidate[] | null>(null);

  // Read by the seed effect without being one of its dependencies: the carry-over
  // is a snapshot of whatever is unsaved at the moment a seed happens, and making
  // it a dependency would re-run the effect on every edit.
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    if (!wall) return;
    const reason = seedReason({
      seedKey,
      seededKey: seededKeyRef.current,
      wall,
      seededWall: seededWallRef.current,
      candidatesChanged: seededCandidatesRef.current !== (candidates ?? null),
      awaitingSavedPayload: awaitingSavedPayloadRef.current,
      saveStartedAtMs: saveStartedAtMsRef.current,
    });
    if (!reason) return;

    seededKeyRef.current = seedKey;
    seededWallRef.current = wall;
    seededCandidatesRef.current = candidates ?? null;
    awaitingSavedPayloadRef.current = false;

    // Anything this session changed that the last save did not take comes with
    // us. A partial save tells the climber some holds were left out; dropping
    // them here would make that message a lie.
    const carryOver = holdsToCarryOver(Object.values(stateRef.current.holds));
    dispatch({
      type: 'LOAD',
      holds: buildEditorSeed(wall, candidates ?? [], seedIncludesCandidates(reason), carryOver),
    });
  }, [wall, seedKey, candidates]);

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

  // Memoised on `state.holds`, which only changes when a hold does — so a
  // selection tap and every frame of a threshold drag re-filter an already-sorted
  // list instead of re-sorting up to 1500 holds.
  const allEditorHolds = useMemo(() => holdsInIdOrder(state.holds), [state.holds]);
  const holds = useMemo(() => filterVisible(allEditorHolds, state.threshold), [allEditorHolds, state.threshold]);
  const counts = useMemo(() => editorCounts(state), [state]);
  const hasUnsaved = useMemo(() => stateHasUnsavedWork(state), [state]);

  // The board's own tap layer still gets targets, for the `pan` tool where the
  // draw overlay declines every touch and the board handles selection itself.
  const holdTargets = useMemo<BoardHoldTarget[]>(() => holds.map(toBoardHoldTarget), [holds]);

  /**
   * The hold size a tap places, and the unit the S/M/L/XL presets scale.
   *
   * Measured over EVERY hold, not the visible ones: the confidence slider must
   * not change what "M" means, and it would if the median moved with whichever
   * candidates happen to be on screen.
   */
  const medianRadius = useMemo(
    () => defaultHoldRadius(allEditorHolds, wall?.photoWidth ?? 0),
    [allEditorHolds, wall?.photoWidth],
  );

  useEffect(() => {
    // `pan` is the tool that hands touches back to the board. Every other tool
    // draws, which on a phone means the finger has to be allowed to — and that
    // permission is the target's, not this screen's: the catalogue target keeps
    // the stylus-only default, where a finger still pans a zoomed board.
    fingerDrawSV.value = capabilities.fingerDrawDefault && tool !== 'pan';
  }, [capabilities.fingerDrawDefault, tool, fingerDrawSV]);

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
      if (!viewerCanEdit || !target || !preset) return;
      dispatch({ type: 'RESIZE_HOLD', id: target.id, r: medianRadius * preset.scale });
    },
    [viewerCanEdit, state.selectedIds, holds, medianRadius],
  );

  // Every mutating handler refuses when the viewer may not edit. The toolbar is
  // disabled too, but the gate lives here as well: a disabled button is a
  // presentation detail, and the rule is that a read-only session never changes
  // the wall — not even locally, where the change would look real until Save
  // came back refused.
  const handleDelete = useCallback(() => {
    if (!viewerCanEdit || state.selectedIds.length === 0) return;
    dispatch({ type: 'DELETE', ids: state.selectedIds });
  }, [viewerCanEdit, state.selectedIds]);

  const handleMerge = useCallback(() => {
    if (!viewerCanEdit) return;
    if (state.selectedIds.length !== 2) {
      setErrorText(t('sprayEditor.errors.mergeNeedsTwo'));
      return;
    }
    dispatch({ type: 'MERGE', ids: state.selectedIds });
  }, [viewerCanEdit, state.selectedIds, t]);

  /**
   * The selected holds that are still awaiting a verdict.
   *
   * Drop and Keep act on these and nothing else. Delegating Drop to the general
   * delete would queue a PERSISTED hold for server removal the moment somebody
   * selected one while any candidate was pending — a review control silently
   * taking a hold off the wall.
   */
  const pendingSelectedIds = useMemo(
    () => state.selectedIds.filter((id) => state.holds[id]?.review === 'pending'),
    [state.selectedIds, state.holds],
  );

  const handleAcceptSelected = useCallback(() => {
    if (!viewerCanEdit) return;
    dispatch({ type: 'ACCEPT', ids: pendingSelectedIds });
  }, [viewerCanEdit, pendingSelectedIds]);

  // Rejecting a candidate is deleting it — it never became a hold, so there is
  // nothing else for "no" to mean. Only ever a candidate, though.
  const handleRejectSelected = useCallback(() => {
    if (!viewerCanEdit || pendingSelectedIds.length === 0) return;
    dispatch({ type: 'DELETE', ids: pendingSelectedIds });
  }, [viewerCanEdit, pendingSelectedIds]);

  const handleAcceptAll = useCallback(() => {
    if (!viewerCanEdit) return;
    dispatch({ type: 'ACCEPT_ALL' });
  }, [viewerCanEdit]);
  const handleUndo = useCallback(() => dispatch({ type: 'UNDO' }), []);
  const handleRedo = useCallback(() => dispatch({ type: 'REDO' }), []);
  const handleThresholdChange = useCallback((threshold: number) => dispatch({ type: 'SET_THRESHOLD', threshold }), []);

  const handleSave = useCallback(() => {
    if (!viewerCanEdit || homography == null) return;
    const plan = buildSprayHoldWritePlan(state, homography);
    if (!planHasWork(plan)) {
      // Nothing sendable, but the button was enabled — which means every dirty
      // hold is one the homography sends off the wall. Saying so beats a press
      // that does nothing and explains nothing.
      if (plan.unmappableIds.length > 0) setErrorText(t('sprayEditor.errors.allHoldsOffWall'));
      return;
    }
    if (plan.overCap) {
      setErrorText(t('sprayEditor.errors.tooManyHolds'));
      return;
    }
    setErrorText(null);
    // Stamped BEFORE the request so a payload registered while it was in flight —
    // a presigned-photo refresh, say — cannot be mistaken for its answer.
    saveStartedAtMsRef.current = Date.now();
    saveHolds.mutate(
      {
        wallUuid,
        versionNumber,
        versionId,
        plan,
        // Fired between the two calls. If the upsert then fails, the removals
        // have still landed, and re-sending them on a retry would be refused.
        onRemoved: () => dispatch({ type: 'MARK_REMOVED' }),
      },
      {
        onSuccess: (result) => {
          // Clear the dirty flags NOW rather than waiting for the refetch. Until
          // they are clear a second press of Save re-sends holds the server has
          // already applied, and a correction re-sent names an id the resolver
          // has just superseded — which fails the whole batch.
          dispatch({ type: 'MARK_SAVED', writtenIds: plan.writtenIds });
          // The refetched draft carries the server's own ids for every hold this
          // session minted locally, so the editor re-seeds from it rather than
          // keeping negative ids that no longer mean anything. Armed rather than
          // done here: the payload may not have landed yet, and re-seeding from
          // the pre-save one would undo the save on screen.
          awaitingSavedPayloadRef.current = true;
          showToast(t('sprayEditor.toast.saved', { value: result.written }), 'success');
          if (plan.unmappableIds.length > 0) {
            setErrorText(t('sprayEditor.errors.someHoldsOffWall', { value: plan.unmappableIds.length }));
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
  }, [viewerCanEdit, state, homography, saveHolds, wallUuid, versionNumber, versionId, showToast, onSaved, t]);

  const handleToolChange = useCallback((next: SprayEditorTool) => {
    setErrorText(null);
    setTool(next);
  }, []);

  const statusLine = useMemo(() => {
    if (!viewerCanEdit) return t('sprayEditor.status.readOnly');
    if (state.selectedIds.length === 2) return t('sprayEditor.status.twoSelected');
    if (state.selectedIds.length === 1) {
      // A hold this session drew has a negative id — this editor's own
      // bookkeeping, and "Hold #-1" means nothing to a wall owner.
      const [selectedId] = state.selectedIds;
      return selectedId > 0
        ? t('sprayEditor.status.oneSelected', { id: selectedId })
        : t('sprayEditor.status.oneSelectedNew');
    }
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

  if (!wall || isUnavailable || !homography) {
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
          pendingSelectedCount={pendingSelectedIds.length}
          canReviewCandidates={capabilities.canReviewCandidates}
          canUndo={state.past.length > 0}
          canRedo={state.future.length > 0}
          onUndo={handleUndo}
          onRedo={handleRedo}
          threshold={state.threshold}
          onThresholdChange={handleThresholdChange}
          onSave={handleSave}
          saving={saveHolds.isPending}
          readOnly={!viewerCanEdit}
          hasUnsavedWork={hasUnsaved}
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
