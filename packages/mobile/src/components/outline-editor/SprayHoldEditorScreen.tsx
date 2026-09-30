import { useCallback, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from 'react';
import {
  AccessibilityInfo,
  StyleSheet,
  View,
  type AccessibilityActionInfo,
  type LayoutChangeEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSharedValue } from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';
import { MAX_HOLDS_PER_WALL } from '@boardsesh/board-config';
import { Text } from '../Text';
import { ActivityIndicator } from '../ActivityIndicator';
import { InteractiveFilterBoard, type FilterBoardTransformContext } from '../search/InteractiveFilterBoard';
import { useTheme } from '../../providers/theme-provider';
import { overlays, spacing } from '../../theme/tokens';
import { glassSize } from '../../theme/layout';
import { hapticLight, hapticMedium, hapticSelection, hapticWarning } from '../../lib/haptics';
import { extractGraphqlMessage } from '../../lib/graphql/extract-error-message';
import { SPRAY_CAP_VALUES } from '../../lib/spray/spray-cap-copy';
import type { BoardHoldTarget } from '../../lib/create-board-holds';
import { getSprayWall, SPRAY_BOARD_NAME, subscribeToSprayWalls } from '../../lib/spray/spray-wall-registry';
import { useSprayWallDraft } from '../../lib/spray/use-spray-wall-draft';
import { useSaveSprayHolds } from '../../lib/spray/use-spray-hold-writes';
import { DrawStrokeOverlay } from './DrawStrokeOverlay';
import { SprayHoldSvgLayer } from './SprayHoldSvgLayer';
import { SelectedHoldOverlay } from './SelectedHoldOverlay';
import { SprayEditGestureOverlay, type SprayWallAccessibility } from './SprayEditGestureOverlay';
import { SprayEditorBottomBar, SPRAY_BAR_GUTTER, SPRAY_BAR_HEIGHT, sprayCountSummary } from './SprayEditorBottomBar';
import { SprayHoldChipBar } from './SprayHoldChipBar';
import { SprayEditorBanner } from './SprayEditorBanner';
import { renderToBoardScale, type StrokeRejection } from './stroke';
import { planHasWork, prepareCommit } from './spray-hold-writes';
import {
  buildEditorSeed,
  holdsToCarryOver,
  seedIncludesCandidates,
  seedReason,
  sprayEditorSeedKey,
} from './spray-hold-seed';
import type { SprayHoldCandidate, SprayHoldSaveSummary } from './spray-hold-editor-types';
import { editorTargetCapabilities, type SprayWallEditorTarget } from './editor-target';
import { fallbackRadiusAt, flattenHitHolds } from './spray-gesture-math';
import {
  countEditorHolds,
  editorIsDirty,
  holdRole,
  holdsInIdOrder,
  initialSprayEditorState,
  sprayEditorReducer,
  type SprayEditorHold,
  type SprayHoldRole,
} from './spray-hold-editor-reducer';
import { readingCursorPosition, readingOrderIndex, sprayHoldReadingOrder, stepReadingCursor } from './spray-hold-a11y';
import {
  defaultHoldRadius,
  holdAtPoint,
  holdFromStroke,
  holdFromTap,
  stepHoldSize,
  toRingPoints,
} from './spray-hold-tools';

/**
 * Vertical room kept free under the photo for the floating bottom bar: the bar,
 * the gutter under it and a matching gap above it. The safe-area inset is added
 * on top.
 */
const BAR_RESERVE = SPRAY_BAR_HEIGHT + SPRAY_BAR_GUTTER * 3;

const NO_POINTS: number[] = [];
const NO_HOLD_TARGETS: BoardHoldTarget[] = [];
const NO_SELECTION: number[] = [];
const NO_EDITOR_HOLDS: SprayEditorHold[] = [];
const NO_READING_ORDER: number[] = [];

/** The screen-reader actions the wall always has. See `SprayWallAccessibility`. */
const WALL_A11Y_ACTIONS: readonly AccessibilityActionInfo[] = [
  { name: 'increment' },
  { name: 'decrement' },
  { name: 'activate' },
];

/** Where the zoomed-in reset control sits: top-left, clear of the chip bar and the bottom bar. */
const RESET_ZOOM_STYLE = { left: spacing[2], top: spacing[2] };

// Re-exported so a caller that opens this screen imports one module. The shapes
// themselves live in `spray-hold-editor-types.ts`, which has no React in it, so
// the pure seeding rules can name a candidate without pulling the board surface
// into their test.
export type { SprayHoldCandidate, SprayHoldSaveSummary };

/**
 * What the editor is doing with the next touch.
 *
 * `edit` is the resting state: taps switch rings, long presses pick them up.
 * `trace` and `join` are one-shot tools a selected hold starts, each with its
 * own banner and a Cancel — never modes a climber has to remember to leave.
 */
type EditorTool = 'edit' | 'trace' | 'join';

/** A line pinned to the top of the photo when the wall has nothing on it yet. */
export type SprayEditorNotice = {
  message: string;
  actionLabel?: string;
  onAction?: () => void;
};

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
  /** `SprayWall.viewerCanEdit`. False leaves zoom and pan and nothing else. */
  viewerCanEdit: boolean;
  /** Detector output. Omit for the manual-only, zero-detection flow. */
  candidates?: readonly SprayHoldCandidate[];
  /** The bottom bar's one filled button — "Publish wall" on the add-a-wall flow. */
  primaryLabel: string;
  /** Shown over an empty wall: why there are no rings, and optionally a way to try again. */
  notice?: SprayEditorNotice;
  /**
   * The primary button's work is done: every hold is on the draft. Fired once
   * per successful commit, with what the server applied and how many holds the
   * wall now carries — including a commit that had nothing to write, because a
   * resumed draft is already saved and still has to move on.
   */
  onCommitted?: (summary: SprayHoldSaveSummary) => void;
  /** Whether leaving now would throw away a decision. Fired on change only. */
  onDirtyChange?: (dirty: boolean) => void;
};

/**
 * The spray-wall hold editor (issue #5441), rebuilt around one idea: rings are
 * holds, tap to switch one off or on, tap bare wall to add one.
 *
 * The detector's confident finds open ON and its unsure ones as dashed maybes,
 * so the climber's job is fixing the machine's mistakes rather than approving
 * every one of its guesses. A long press picks a ring up for the chip bar —
 * size, trace, join, remove — and the same touch can carry on into a move.
 * Everything goes through one pure reducer with undo, and one button saves and
 * hands over (`onCommitted`).
 *
 * The board surface is the shared `InteractiveFilterBoard`. The rings, the dim
 * layer and the selection draw INSIDE its zoom transform; the gesture surface
 * sits above it and inverts the transform itself. Trace reuses the catalogue
 * editor's `DrawStrokeOverlay` and stroke → ring chain unchanged, so a wall's
 * traced outline obeys exactly the ring contract a board's does.
 *
 * Coordinates are the photograph's own pixels everywhere on screen. The single
 * hop into canonical wall coordinates happens in `prepareCommit`, once.
 */
export function SprayHoldEditorScreen({
  wallUuid,
  layoutId,
  versionId,
  versionNumber,
  viewerCanEdit,
  candidates,
  primaryLabel,
  notice,
  onCommitted,
  onDirtyChange,
}: SprayHoldEditorScreenProps) {
  const { systemColors } = useTheme();
  const { t } = useTranslation('boards');
  const insets = useSafeAreaInsets();

  const { isLoading, isUnavailable, homography } = useSprayWallDraft(layoutId, wallUuid, versionNumber);
  const saveHolds = useSaveSprayHolds();

  const capabilities = useMemo(() => {
    const target: SprayWallEditorTarget = { kind: 'sprayWall', wallUuid, layoutId, versionId, viewerCanEdit };
    return editorTargetCapabilities(target);
  }, [wallUuid, layoutId, versionId, viewerCanEdit]);

  const [tool, setTool] = useState<EditorTool>('edit');
  const [errorText, setErrorText] = useState<string | null>(null);
  const [showMaybes, setShowMaybes] = useState(true);
  const [moveRevision, setMoveRevision] = useState(0);
  /**
   * Where a screen reader's swipes have got to while Join waits for its second
   * hold. Outside Join the cursor IS the selection, so it needs no state of its
   * own; inside Join the selection has to stay put on the first hold.
   */
  const [joinCursorId, setJoinCursorId] = useState<number | null>(null);
  const [area, setArea] = useState({ width: 0, height: 0 });
  const [state, dispatch] = useReducer(sprayEditorReducer, undefined, () => initialSprayEditorState());

  const draftPointsSV = useSharedValue<number[]>(NO_POINTS);
  // The wall target draws with a finger — there is no Pencil in a garage.
  const fingerDrawSV = useSharedValue(capabilities.fingerDrawDefault);
  const hitHoldsSV = useSharedValue<number[]>(NO_POINTS);
  const selectedHoldSV = useSharedValue<number[]>(NO_SELECTION);
  const dragOffsetXSV = useSharedValue(0);
  const dragOffsetYSV = useSharedValue(0);
  const dragHoldIdSV = useSharedValue(0);
  /** A commit is in flight. A ref as well as the mutation's flag, so a double press is refused synchronously. */
  const committingRef = useRef(false);

  useEffect(() => {
    fingerDrawSV.value = capabilities.fingerDrawDefault;
  }, [capabilities.fingerDrawDefault, fingerDrawSV]);

  // The registry is a module-level map, so the wall is read through
  // `useSyncExternalStore` — the same shape `useSprayWall` uses. Its own
  // `loadState` snapshot does NOT move when a wall is re-registered at the same
  // state (which is exactly what a save's refresh does), so the screen has to
  // subscribe to the wall itself or it would keep drawing the pre-save holds.
  const wall = useSyncExternalStore(
    subscribeToSprayWalls,
    useCallback(() => getSprayWall(layoutId), [layoutId]),
  );

  /**
   * A save has landed and the payload carrying what it wrote has not arrived yet.
   * A ref, not state: it is a latch between two async events. See
   * `spray-hold-seed.ts` for why the re-seed needs both halves of its test.
   */
  const awaitingSavedPayloadRef = useRef(false);
  const saveStartedAtMsRef = useRef<number | null>(null);

  const seedKey = sprayEditorSeedKey(wall);
  const seededKeyRef = useRef<string | null>(null);
  const seededWallRef = useRef<typeof wall>(null);
  const seededCandidatesRef = useRef<readonly SprayHoldCandidate[] | null>(null);
  /** What the last seed loaded — where "Start over" goes back to. */
  const seedHoldsRef = useRef<readonly SprayEditorHold[]>([]);

  // Read by callbacks without being their dependencies, so the gesture handlers
  // and the board's render props keep one identity across edits.
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
    // us, so a re-seed never quietly drops work.
    const carryOver = holdsToCarryOver(Object.values(stateRef.current.holds));
    const seed = buildEditorSeed(wall, candidates ?? [], seedIncludesCandidates(reason), carryOver);
    seedHoldsRef.current = seed;
    dispatch({ type: 'LOAD', holds: seed });
  }, [wall, seedKey, candidates]);

  const handleAreaLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setArea((previous) => (previous.width === width && previous.height === height ? previous : { width, height }));
  }, []);

  // Full width, fitted to the height the bottom bar leaves free. `slotHeight` is
  // that free height: the photo is centred in it, so a landscape wall sits in
  // the middle of the screen rather than pinned to the top over a black void.
  const boardRender = useMemo(() => {
    if (!wall || area.width <= 0) return { width: 0, height: 0, slotHeight: 0 };
    const boardAspect = wall.photoWidth / wall.photoHeight;
    const availableWidth = area.width;
    const availableHeight = Math.max(200, area.height - insets.bottom - BAR_RESERVE);
    if (availableWidth / availableHeight > boardAspect) {
      return { width: availableHeight * boardAspect, height: availableHeight, slotHeight: availableHeight };
    }
    return { width: availableWidth, height: availableWidth / boardAspect, slotHeight: availableHeight };
  }, [wall, area.width, area.height, insets.bottom]);

  const boardScale = renderToBoardScale(wall?.photoWidth ?? 0, boardRender.width);

  // Memoised on `state.holds`, which only changes when a hold does — never on a
  // selection tap.
  const allEditorHolds = useMemo(() => holdsInIdOrder(state.holds), [state.holds]);
  // What is drawn and what a tap can reach. Hiding the maybes hides them from
  // both, so a hidden ring can never be switched on by a tap that missed.
  const visibleHolds = useMemo(
    () => (showMaybes ? allEditorHolds : allEditorHolds.filter((hold) => holdRole(hold) !== 'maybe')),
    [allEditorHolds, showMaybes],
  );
  const visibleHoldsRef = useRef(visibleHolds);
  visibleHoldsRef.current = visibleHolds;
  /** The maybes a tap cannot see while they are hidden — see `handleTap`. */
  const hiddenMaybes = useMemo(
    () => (showMaybes ? NO_EDITOR_HOLDS : allEditorHolds.filter((hold) => holdRole(hold) === 'maybe')),
    [allEditorHolds, showMaybes],
  );
  const hiddenMaybesRef = useRef(hiddenMaybes);
  hiddenMaybesRef.current = hiddenMaybes;

  const counts = useMemo(() => countEditorHolds(state.holds, state.removedIds.length), [state.holds, state.removedIds]);
  const countsRef = useRef(counts);
  countsRef.current = counts;

  const dirty = editorIsDirty(state, counts);
  const wallLabel = t('sprayEditor.a11y.wall', { summary: sprayCountSummary(t, counts, showMaybes) });
  const onDirtyChangeRef = useRef(onDirtyChange);
  onDirtyChangeRef.current = onDirtyChange;
  useEffect(() => {
    onDirtyChangeRef.current?.(dirty);
  }, [dirty]);

  // The long-press hit list, mirrored to the UI thread whenever the drawn rings
  // change. One flat array, so the worklet scans it without allocating.
  useEffect(() => {
    hitHoldsSV.value = flattenHitHolds(visibleHolds);
  }, [visibleHolds, hitHoldsSV]);

  /**
   * The hold size a tap places, and the unit Smaller and Bigger step through.
   * Measured over EVERY hold, so hiding the maybes does not change what "a
   * normal hold" means.
   */
  const medianRadius = useMemo(
    () => defaultHoldRadius(allEditorHolds, wall?.photoWidth ?? 0),
    [allEditorHolds, wall?.photoWidth],
  );
  const medianRadiusRef = useRef(medianRadius);
  medianRadiusRef.current = medianRadius;

  const selectedHold = state.selectedId != null ? (state.holds[state.selectedId] ?? null) : null;

  // The screen reader's walk: every tappable ring in reading order. Only built
  // for a viewer who can edit — nobody else gets the gesture surface it drives.
  const readingOrder = useMemo(
    () => (viewerCanEdit ? sprayHoldReadingOrder(visibleHolds, medianRadius) : NO_READING_ORDER),
    [viewerCanEdit, visibleHolds, medianRadius],
  );
  const readingIndex = useMemo(() => readingOrderIndex(readingOrder), [readingOrder]);
  const readingOrderRef = useRef(readingOrder);
  readingOrderRef.current = readingOrder;
  const readingIndexRef = useRef(readingIndex);
  readingIndexRef.current = readingIndex;
  const joinCursorIdRef = useRef(joinCursorId);
  joinCursorIdRef.current = joinCursorId;
  /** The next change to the wall's spoken value (or an error) is read out — set by actions a swipe did not start. */
  const announceNextRef = useRef(false);

  const committing = saveHolds.isPending;
  const canEdit = viewerCanEdit && !committing;
  const canEditRef = useRef(canEdit);
  canEditRef.current = canEdit;
  const toolRef = useRef(tool);
  toolRef.current = tool;

  // A one-shot tool needs its hold. An undo that took the selection away ends it.
  useEffect(() => {
    if (tool !== 'edit' && selectedHold == null) setTool('edit');
  }, [tool, selectedHold]);

  /** The cap said out loud, with its number, from the constant the server refuses on. */
  const refuseOverCap = useCallback(() => {
    hapticWarning();
    setErrorText(t('sprayEditor.errors.tooManyHolds', { max: SPRAY_CAP_VALUES.holds }));
  }, [t]);

  /**
   * Moving, resizing or tracing a ring switches it ON (the reducer's `touched`),
   * so an edit to an OFF ring or a maybe is an add as far as the cap goes.
   * Refuses — and says why — when that add would pass the cap.
   */
  const editWouldPassCap = useCallback(
    (hold: SprayEditorHold) => {
      if (holdRole(hold) === 'on' || countsRef.current.on < MAX_HOLDS_PER_WALL) return false;
      refuseOverCap();
      return true;
    },
    [refuseOverCap],
  );

  /** A ring switched ON or OFF, with the cap check a tap and a screen reader share. False when the cap refused it. */
  const toggleHold = useCallback(
    (hold: SprayEditorHold) => {
      const turningOn = holdRole(hold) !== 'on';
      if (turningOn && countsRef.current.on >= MAX_HOLDS_PER_WALL) {
        refuseOverCap();
        return false;
      }
      if (turningOn) hapticLight();
      else hapticSelection();
      dispatch({ type: 'TOGGLE_HOLD', id: hold.id });
      return true;
    },
    [refuseOverCap],
  );

  const handleTap = useCallback(
    (boardX: number, boardY: number, zoom: number) => {
      if (!canEditRef.current) return;
      setErrorText(null);
      const current = stateRef.current;
      const fallbackRadius = fallbackRadiusAt(boardScale, zoom);
      // A hidden maybe is still a hold under the finger. Adding a hand-drawn
      // ring on top of it would put a duplicate on the wall, so a tap there is
      // read as a tap on the maybe — which turns it ON, and ON rings are drawn
      // whether maybes are shown or not.
      const hit =
        holdAtPoint(visibleHoldsRef.current, boardX, boardY, fallbackRadius) ??
        holdAtPoint(hiddenMaybesRef.current, boardX, boardY, fallbackRadius);

      if (toolRef.current === 'join') {
        // Join waits for the second hold and nothing else: bare wall or the
        // selected hold itself leaves it waiting.
        if (hit && current.selectedId != null && hit.id !== current.selectedId) {
          hapticMedium();
          dispatch({ type: 'MERGE', ids: [current.selectedId, hit.id] });
          setTool('edit');
        }
        return;
      }

      // With a hold selected, bare wall only clears the selection — the first tap
      // away from a hold is "I'm done with it", not "add one here".
      if (current.selectedId != null && !hit) {
        dispatch({ type: 'SELECT', id: null });
        return;
      }
      if (current.selectedId != null && hit && hit.id !== current.selectedId) {
        dispatch({ type: 'SELECT', id: null });
      }

      if (hit) {
        toggleHold(hit);
        return;
      }

      if (countsRef.current.on >= MAX_HOLDS_PER_WALL) {
        refuseOverCap();
        return;
      }
      hapticMedium();
      dispatch({ type: 'ADD_HOLD', geometry: holdFromTap(boardX, boardY, medianRadiusRef.current) });
    },
    [boardScale, refuseOverCap, toggleHold],
  );

  const handlePickUp = useCallback((holdId: number) => {
    if (!canEditRef.current || toolRef.current !== 'edit') return;
    setErrorText(null);
    hapticSelection();
    dispatch({ type: 'SELECT', id: holdId });
  }, []);

  const handleMoveEnd = useCallback(
    (holdId: number, deltaX: number, deltaY: number) => {
      const hold = stateRef.current.holds[holdId];
      if (canEditRef.current && hold && !editWouldPassCap(hold)) {
        dispatch({ type: 'MOVE_HOLD', id: holdId, cx: hold.cx + deltaX, cy: hold.cy + deltaY });
      }
      // Always, so the preview re-syncs to the reducer's answer — including a
      // refused move, which snaps back.
      setMoveRevision((revision) => revision + 1);
    },
    [editWouldPassCap],
  );

  const shrinkTo = selectedHold ? stepHoldSize(selectedHold.r, medianRadius, -1) : null;
  const growTo = selectedHold ? stepHoldSize(selectedHold.r, medianRadius, 1) : null;

  const handleShrink = useCallback(() => {
    if (!canEdit || !selectedHold || shrinkTo == null || editWouldPassCap(selectedHold)) return;
    hapticSelection();
    dispatch({ type: 'RESIZE_HOLD', id: selectedHold.id, r: shrinkTo });
  }, [canEdit, selectedHold, shrinkTo, editWouldPassCap]);

  const handleGrow = useCallback(() => {
    if (!canEdit || !selectedHold || growTo == null || editWouldPassCap(selectedHold)) return;
    hapticSelection();
    dispatch({ type: 'RESIZE_HOLD', id: selectedHold.id, r: growTo });
  }, [canEdit, selectedHold, growTo, editWouldPassCap]);

  const handleStartTrace = useCallback(() => {
    setErrorText(null);
    setTool('trace');
  }, []);

  const handleStartJoin = useCallback(() => {
    setErrorText(null);
    setJoinCursorId(null);
    setTool('join');
  }, []);

  const handleCancelTool = useCallback(() => {
    draftPointsSV.value = NO_POINTS;
    setErrorText(null);
    setJoinCursorId(null);
    setTool('edit');
  }, [draftPointsSV]);

  const handleRemove = useCallback(() => {
    if (!canEdit || state.selectedId == null) return;
    hapticSelection();
    dispatch({ type: 'DELETE', id: state.selectedId });
  }, [canEdit, state.selectedId]);

  const handleStrokeStart = useCallback(() => setErrorText(null), []);
  const handleStrokeCancel = useCallback(() => {
    draftPointsSV.value = NO_POINTS;
  }, [draftPointsSV]);

  const handleStrokeEnd = useCallback(
    (strokeBoardPoints: number[]) => {
      draftPointsSV.value = NO_POINTS;
      const targetId = stateRef.current.selectedId;
      if (!canEditRef.current || targetId == null) return;
      const target = stateRef.current.holds[targetId];
      if (!target) return;
      if (editWouldPassCap(target)) {
        setTool('edit');
        return;
      }
      const drawn = holdFromStroke(toRingPoints(strokeBoardPoints));
      if (!drawn.ok) {
        // Stays in Trace: one missed loop should cost one more loop, not a trip
        // back through the chip bar.
        hapticWarning();
        setErrorText(rejectionMessage(drawn.reason, t));
        return;
      }
      hapticMedium();
      dispatch({ type: 'SET_OUTLINE', id: targetId, geometry: drawn.hold });
      setTool('edit');
    },
    [draftPointsSV, editWouldPassCap, t],
  );

  const handleUndo = useCallback(() => {
    setErrorText(null);
    hapticSelection();
    dispatch({ type: 'UNDO' });
  }, []);

  const handleKeepMaybes = useCallback(() => {
    if (!canEditRef.current) return;
    const maybes = countsRef.current.maybes;
    if (countsRef.current.on + maybes > MAX_HOLDS_PER_WALL) {
      refuseOverCap();
      return;
    }
    hapticLight();
    dispatch({ type: 'KEEP_MAYBES' });
  }, [refuseOverCap]);

  const handleToggleMaybes = useCallback(() => {
    const selected = stateRef.current.selectedId != null ? stateRef.current.holds[stateRef.current.selectedId] : null;
    // A hidden ring cannot stay under the chip bar.
    if (showMaybes && selected && holdRole(selected) === 'maybe') dispatch({ type: 'SELECT', id: null });
    setShowMaybes((shown) => !shown);
  }, [showMaybes]);

  const handleStartOver = useCallback(() => {
    if (!canEditRef.current) return;
    setErrorText(null);
    setTool('edit');
    setShowMaybes(true);
    dispatch({ type: 'START_OVER', holds: seedHoldsRef.current });
  }, []);

  const handlePrimary = useCallback(() => {
    if (!viewerCanEdit || homography == null || committingRef.current) return;
    const { state: prepared, plan } = prepareCommit(stateRef.current, homography);
    const holdCount = countEditorHolds(prepared.holds, 0).on;
    if (holdCount === 0) return;
    if (plan.overCap) {
      refuseOverCap();
      return;
    }
    if (plan.unmappableIds.length > 0) {
      // Rare — the homography has to send a hold to infinity — but publishing
      // without them would lose holds the screen is showing as ON.
      hapticWarning();
      setErrorText(t('sprayEditor.errors.someHoldsOffWall', { count: plan.unmappableIds.length }));
      return;
    }

    setErrorText(null);
    setTool('edit');
    // `prepareCommit` already applied ACCEPT_DEFAULTS to build the plan; this
    // brings React state to the same place. Idempotent, so a repeat is harmless.
    dispatch({ type: 'ACCEPT_DEFAULTS' });
    if (!planHasWork(plan)) {
      // A resumed draft with nothing changed: every hold is already on it.
      onCommitted?.({ written: 0, removed: 0, holdCount });
      return;
    }

    committingRef.current = true;
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
        onRemoved: () => {
          // Gone from the server, so gone from "Start over" too: bringing one
          // back ON would name a removed id and the next upsert would refuse the
          // whole batch.
          const removed = new Set(plan.removeIds);
          seedHoldsRef.current = seedHoldsRef.current.filter((hold) => !removed.has(hold.id));
          dispatch({ type: 'MARK_REMOVED' });
        },
      },
      {
        onSuccess: (result) => {
          committingRef.current = false;
          // Clear the dirty flags NOW rather than waiting for the refetch, so a
          // retry can never re-send holds the server already has.
          dispatch({ type: 'MARK_SAVED', writtenIds: plan.writtenIds });
          awaitingSavedPayloadRef.current = true;
          onCommitted?.({ ...result, holdCount });
        },
        onError: (error: unknown) => {
          committingRef.current = false;
          hapticWarning();
          setErrorText(extractGraphqlMessage(error) ?? t('sprayEditor.errors.saveFailed'));
        },
      },
    );
  }, [viewerCanEdit, homography, refuseOverCap, saveHolds, wallUuid, versionNumber, versionId, onCommitted, t]);

  /**
   * A screen reader's swipe up (`1`) or down (`-1`). Outside Join it selects the
   * next ring in reading order, which is what brings up the chip bar; inside
   * Join it only moves the cursor, skipping the hold being joined.
   */
  const stepWallCursor = useCallback((delta: 1 | -1) => {
    announceNextRef.current = false;
    if (!canEditRef.current) return;
    const order = readingOrderRef.current;
    const indexById = readingIndexRef.current;
    if (toolRef.current === 'join') {
      const selectedId = stateRef.current.selectedId;
      let next = stepReadingCursor(order, indexById, joinCursorIdRef.current, delta);
      if (next != null && next === selectedId && order.length > 1) {
        next = stepReadingCursor(order, indexById, next, delta);
      }
      setJoinCursorId(next);
      return;
    }
    if (toolRef.current !== 'edit') return;
    const next = stepReadingCursor(order, indexById, stateRef.current.selectedId, delta);
    if (next == null) return;
    setErrorText(null);
    dispatch({ type: 'SELECT', id: next });
  }, []);

  /**
   * A screen reader's double tap: acts on the cursor's hold and nothing else, and
   * does nothing with no cursor — never on whatever sits under the view's centre.
   */
  const activateWallCursor = useCallback(() => {
    if (!canEditRef.current) return;
    const current = stateRef.current;
    const onWalk = (id: number | null): id is number => id != null && readingIndexRef.current.has(id);
    if (toolRef.current === 'join') {
      const targetId = joinCursorIdRef.current;
      if (!onWalk(targetId) || current.selectedId == null || targetId === current.selectedId) return;
      hapticMedium();
      announceNextRef.current = true;
      dispatch({ type: 'MERGE', ids: [current.selectedId, targetId] });
      setJoinCursorId(null);
      setTool('edit');
      return;
    }
    if (toolRef.current !== 'edit' || !onWalk(current.selectedId)) return;
    const hold = current.holds[current.selectedId];
    if (!hold) return;
    setErrorText(null);
    announceNextRef.current = true;
    toggleHold(hold);
  }, [toggleHold]);

  /**
   * "Add a hold here" for a screen reader, which has no finger to say where:
   * the middle of whatever part of the wall is on screen. A ring already there
   * is picked instead of stacking a duplicate on it — switched on first if it is
   * a hidden maybe, just as a tap would.
   */
  const addHoldAtViewCentre = useCallback(
    (boardX: number, boardY: number) => {
      if (!canEditRef.current || toolRef.current !== 'edit') return;
      setErrorText(null);
      announceNextRef.current = true;
      const visibleHit = holdAtPoint(visibleHoldsRef.current, boardX, boardY);
      const hiddenHit = visibleHit ? null : holdAtPoint(hiddenMaybesRef.current, boardX, boardY);
      if (hiddenHit && !toggleHold(hiddenHit)) return;
      const hit = visibleHit ?? hiddenHit;
      if (hit) {
        hapticSelection();
        dispatch({ type: 'SELECT', id: hit.id });
        return;
      }
      if (countsRef.current.on >= MAX_HOLDS_PER_WALL) {
        refuseOverCap();
        return;
      }
      hapticMedium();
      // ADD_HOLD takes the next local id; selecting it straight after puts the
      // new ring under the chip bar and the cursor.
      const newId = stateRef.current.nextLocalId;
      dispatch({ type: 'ADD_HOLD', geometry: holdFromTap(boardX, boardY, medianRadiusRef.current) });
      dispatch({ type: 'SELECT', id: newId });
    },
    [refuseOverCap, toggleHold],
  );

  const handleWallAccessibilityAction = useCallback(
    (actionName: string, viewCentreX: number, viewCentreY: number) => {
      switch (actionName) {
        case 'increment':
          stepWallCursor(1);
          return;
        case 'decrement':
          stepWallCursor(-1);
          return;
        case 'activate':
          activateWallCursor();
          return;
        case WALL_ACTION.shrink:
          handleShrink();
          return;
        case WALL_ACTION.grow:
          handleGrow();
          return;
        case WALL_ACTION.remove:
          announceNextRef.current = true;
          handleRemove();
          return;
        case WALL_ACTION.addHold:
          addHoldAtViewCentre(viewCentreX, viewCentreY);
          return;
        default:
          return;
      }
    },
    [stepWallCursor, activateWallCursor, handleShrink, handleGrow, handleRemove, addHoldAtViewCentre],
  );

  const cursorId = tool === 'join' ? joinCursorId : state.selectedId;
  const cursorPosition = readingCursorPosition(readingIndex, cursorId);
  const cursorHold = cursorPosition && cursorId != null ? (state.holds[cursorId] ?? null) : null;
  const wallValue =
    cursorPosition && cursorHold
      ? t('sprayEditor.a11y.holdValue', {
          position: cursorPosition.position,
          total: cursorPosition.total,
          role: roleLabel(holdRole(cursorHold), t),
        })
      : t('sprayEditor.a11y.noHold');
  const wallHint = tool === 'join' ? t('sprayEditor.a11y.joinHint') : t('sprayEditor.a11y.hint');
  const holdToolsOpen = tool === 'edit' && canEdit;
  const hasSelection = selectedHold != null;
  const canShrinkSelected = shrinkTo != null;
  const canGrowSelected = growTo != null;

  const wallActions = useMemo<readonly AccessibilityActionInfo[]>(() => {
    if (!holdToolsOpen) return WALL_A11Y_ACTIONS;
    const actions: AccessibilityActionInfo[] = [...WALL_A11Y_ACTIONS];
    if (hasSelection) {
      if (canShrinkSelected) actions.push({ name: WALL_ACTION.shrink, label: t('sprayEditor.a11y.actions.smaller') });
      if (canGrowSelected) actions.push({ name: WALL_ACTION.grow, label: t('sprayEditor.a11y.actions.bigger') });
      actions.push({ name: WALL_ACTION.remove, label: t('sprayEditor.a11y.actions.remove') });
    }
    actions.push({ name: WALL_ACTION.addHold, label: t('sprayEditor.a11y.actions.addHold') });
    return actions;
  }, [holdToolsOpen, hasSelection, canShrinkSelected, canGrowSelected, t]);

  const wallAccessibility = useMemo<SprayWallAccessibility>(
    () => ({
      label: wallLabel,
      value: wallValue,
      hint: wallHint,
      actions: wallActions,
      onAction: handleWallAccessibilityAction,
    }),
    [wallLabel, wallValue, wallHint, wallActions, handleWallAccessibilityAction],
  );

  // A swipe's new value is read out by the adjustable element itself. A double
  // tap or a named action is not, so its outcome — or the error that refused
  // it — is announced once it has rendered.
  useEffect(() => {
    if (!announceNextRef.current) return;
    announceNextRef.current = false;
    AccessibilityInfo.announceForAccessibility(errorText ?? wallValue);
  }, [wallValue, errorText]);

  const renderInTransform = useCallback(
    (context: FilterBoardTransformContext) =>
      wall ? (
        <>
          {/* Between the photo and the rings: calms a busy wall so the rings read,
              and deepens while a hold is picked so the chip bar's hold stands out. */}
          <View
            pointerEvents="none"
            style={[
              StyleSheet.absoluteFill,
              { backgroundColor: selectedHold ? overlays.photoDimFocused : overlays.photoDim },
            ]}
          />
          <SprayHoldSvgLayer
            holds={allEditorHolds}
            showMaybes={showMaybes}
            selectedId={selectedHold?.id ?? null}
            draftPointsSV={draftPointsSV}
            scaleSV={context.scaleSV}
            boardWidth={wall.photoWidth}
            boardHeight={wall.photoHeight}
            renderWidth={boardRender.width}
            renderHeight={boardRender.height}
          />
          <SelectedHoldOverlay
            hold={selectedHold}
            revision={moveRevision}
            selectedHoldSV={selectedHoldSV}
            dragOffsetXSV={dragOffsetXSV}
            dragOffsetYSV={dragOffsetYSV}
            dragHoldIdSV={dragHoldIdSV}
            scaleSV={context.scaleSV}
            boardScale={boardScale}
          />
        </>
      ) : null,
    [
      wall,
      selectedHold,
      allEditorHolds,
      showMaybes,
      draftPointsSV,
      boardRender.width,
      boardRender.height,
      moveRevision,
      selectedHoldSV,
      dragOffsetXSV,
      dragOffsetYSV,
      dragHoldIdSV,
      boardScale,
    ],
  );

  const renderAboveBoard = useCallback(
    (context: FilterBoardTransformContext) => {
      // Read-only: zoom and pan, and nothing that could change the wall.
      if (!viewerCanEdit) return null;
      if (tool === 'trace') {
        return (
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
        );
      }
      return (
        <SprayEditGestureOverlay
          scaleSV={context.scaleSV}
          translateXSV={context.translateXSV}
          translateYSV={context.translateYSV}
          containerWidthSV={context.containerWidthSV}
          containerHeightSV={context.containerHeightSV}
          isPinchingSV={context.isPinchingSV}
          pinchRef={context.pinchRef}
          boardScale={boardScale}
          hitHoldsSV={hitHoldsSV}
          selectedHoldSV={selectedHoldSV}
          dragOffsetXSV={dragOffsetXSV}
          dragOffsetYSV={dragOffsetYSV}
          dragHoldIdSV={dragHoldIdSV}
          canMove={tool === 'edit' && canEdit}
          accessibility={wallAccessibility}
          onTap={handleTap}
          onPickUp={handlePickUp}
          onMoveEnd={handleMoveEnd}
        />
      );
    },
    [
      viewerCanEdit,
      tool,
      canEdit,
      draftPointsSV,
      fingerDrawSV,
      boardScale,
      hitHoldsSV,
      selectedHoldSV,
      dragOffsetXSV,
      dragOffsetYSV,
      dragHoldIdSV,
      wallAccessibility,
      handleStrokeStart,
      handleStrokeEnd,
      handleStrokeCancel,
      handleTap,
      handlePickUp,
      handleMoveEnd,
    ],
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

  const wallIsEmpty = counts.on + counts.maybes + counts.off === 0;
  const banner = bannerFor({
    tool,
    errorText,
    viewerCanEdit,
    notice: wallIsEmpty ? notice : undefined,
    onCancel: handleCancelTool,
    t,
  });

  return (
    <View style={[styles.container, { backgroundColor: systemColors.background }]} onLayout={handleAreaLayout}>
      {boardRender.width > 0 ? (
        <View style={[styles.boardSlot, { height: boardRender.slotHeight }]}>
          <InteractiveFilterBoard
            boardName={SPRAY_BOARD_NAME}
            layoutId={layoutId}
            sizeId={layoutId}
            setIds=""
            boardWidth={wall.photoWidth}
            boardHeight={wall.photoHeight}
            holdTargets={NO_HOLD_TARGETS}
            renderWidth={boardRender.width}
            renderHeight={boardRender.height}
            renderInTransform={renderInTransform}
            renderAboveBoard={renderAboveBoard}
            resetZoomStyle={RESET_ZOOM_STYLE}
          />
        </View>
      ) : null}

      {banner ? (
        <View pointerEvents="box-none" style={styles.bannerSlot}>
          <SprayEditorBanner {...banner} />
        </View>
      ) : null}

      {selectedHold && tool === 'edit' && canEdit ? (
        <SprayHoldChipBar
          bottom={insets.bottom + SPRAY_BAR_GUTTER * 2 + SPRAY_BAR_HEIGHT}
          canShrink={shrinkTo != null}
          canGrow={growTo != null}
          onShrink={handleShrink}
          onGrow={handleGrow}
          onTrace={handleStartTrace}
          onJoin={handleStartJoin}
          onRemove={handleRemove}
        />
      ) : null}

      <SprayEditorBottomBar
        counts={counts}
        showMaybes={showMaybes}
        canReviewMaybes={capabilities.canReviewCandidates}
        canUndo={state.past.length > 0}
        locked={!canEdit}
        primaryLabel={primaryLabel}
        primaryLoading={committing}
        bottomInset={insets.bottom}
        onUndo={handleUndo}
        onKeepMaybes={handleKeepMaybes}
        onToggleMaybes={handleToggleMaybes}
        onStartOver={handleStartOver}
        onPrimary={handlePrimary}
      />
    </View>
  );
}

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** The named screen-reader actions on the wall, mirroring the chip bar. */
const WALL_ACTION = {
  shrink: 'shrink',
  grow: 'grow',
  remove: 'remove',
  addHold: 'addHold',
} as const;

/** A ring's state as a screen reader says it. Literal keys, so the catalogue checks can see them. */
function roleLabel(role: SprayHoldRole, t: Translate): string {
  if (role === 'on') return t('sprayEditor.a11y.role.on');
  if (role === 'maybe') return t('sprayEditor.a11y.role.maybe');
  return t('sprayEditor.a11y.role.off');
}

/** The one line at the top of the photo, most urgent first: the active tool, an error, read-only, the empty wall. */
function bannerFor({
  tool,
  errorText,
  viewerCanEdit,
  notice,
  onCancel,
  t,
}: {
  tool: EditorTool;
  errorText: string | null;
  viewerCanEdit: boolean;
  notice: SprayEditorNotice | undefined;
  onCancel: () => void;
  t: Translate;
}): { message: string; actionLabel?: string; onAction?: () => void; tone?: 'info' | 'error' } | null {
  if (tool === 'trace') {
    return errorText
      ? { message: errorText, actionLabel: t('sprayEditor.banner.cancel'), onAction: onCancel, tone: 'error' }
      : { message: t('sprayEditor.banner.trace'), actionLabel: t('sprayEditor.banner.cancel'), onAction: onCancel };
  }
  if (tool === 'join') {
    return { message: t('sprayEditor.banner.join'), actionLabel: t('sprayEditor.banner.cancel'), onAction: onCancel };
  }
  if (errorText) return { message: errorText, tone: 'error' };
  if (!viewerCanEdit) return { message: t('sprayEditor.readOnly') };
  if (notice) return notice;
  return null;
}

function rejectionMessage(reason: StrokeRejection, t: Translate): string {
  if (reason === 'centre-outside') return t('sprayEditor.errors.strokeNotClosed');
  if (reason === 'out-of-bounds') return t('sprayEditor.errors.strokeTooBig');
  if (reason === 'too-complex') return t('sprayEditor.errors.strokeTooDetailed');
  return t('sprayEditor.errors.strokeTooShort');
}

// Re-exported from its own module so a caller imports one file, and so the
// dialog's own wiring can be tested without mounting a board.
export { confirmDiscardSprayEdits, type SprayDiscardStrings } from './spray-discard-guard';

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
  },
  boardSlot: {
    alignSelf: 'stretch',
    alignItems: 'center',
    justifyContent: 'center',
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
  // Below the top-left reset-zoom control, so the two never overlap.
  bannerSlot: {
    position: 'absolute',
    top: spacing[2] * 2 + glassSize.mini,
    left: spacing[4],
    right: spacing[4],
  },
});
