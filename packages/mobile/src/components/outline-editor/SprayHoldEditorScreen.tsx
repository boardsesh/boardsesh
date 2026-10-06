import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  StyleSheet,
  View,
  type AccessibilityActionInfo,
  type LayoutChangeEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import Animated, {
  ReduceMotion,
  runOnJS,
  runOnUI,
  useAnimatedReaction,
  useAnimatedStyle,
  useDerivedValue,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';
import { MAX_HOLDS_PER_WALL } from '@boardsesh/board-config';
import { Text } from '../Text';
import {
  InteractiveFilterBoard,
  type FilterBoardControls,
  type FilterBoardTransformContext,
} from '../search/InteractiveFilterBoard';
import { GlassIconButton } from '../GlassIconButton';
import { OnboardingTipBanner } from '../onboarding/OnboardingTipBanner';
import { useTransparentHeaderInset } from '../../hooks/use-transparent-header-inset';
import { useTheme } from '../../providers/theme-provider';
import { overlays, spacing } from '../../theme/tokens';
import { glassSize } from '../../theme/layout';
import { timingFor } from '../../theme/motion-config';
import { hapticLight, hapticMedium, hapticSelection, hapticSuccess, hapticWarning } from '../../lib/haptics';
import {
  extractGraphqlMessage,
  sprayWallLifecycleRefusal,
  sprayWallRefusalMeansStaleWall,
} from '../../lib/graphql/extract-error-message';
import { sprayWallLifecycleMessage } from '../../lib/spray/spray-lifecycle-copy';
import { SPRAY_CAP_VALUES } from '../../lib/spray/spray-cap-copy';
import type { BoardHoldTarget } from '../../lib/create-board-holds';
import { refreshSprayWall, SPRAY_BOARD_NAME } from '../../lib/spray/spray-wall-registry';
import { useSprayWallDraft } from '../../lib/spray/use-spray-wall-draft';
import { useSaveSprayHolds } from '../../lib/spray/use-spray-hold-writes';
import { SegmentedControl } from '../SegmentedControl';
import { DrawStrokeOverlay } from './DrawStrokeOverlay';
import { PolygonTapOverlay } from './PolygonTapOverlay';
import { SprayHoldSvgLayer } from './SprayHoldSvgLayer';
import { SelectedHoldOverlay } from './SelectedHoldOverlay';
import { SprayPlacementPreview } from './SprayPlacementPreview';
import { SprayResizeHandle } from './SprayResizeHandle';
import { SprayLoupe } from './SprayLoupe';
import { useSprayLoupeFeed } from './spray-loupe-feed';
import { SprayEditGestureOverlay, type SprayWallAccessibility } from './SprayEditGestureOverlay';
import { SprayEditorBottomBar, sprayCountSummary } from './SprayEditorBottomBar';
import { SprayEditorMenu } from './SprayCountCapsule';
import { SprayCornersChipBar, SprayHoldChipBar, SprayRefineBar } from './SprayHoldChipBar';
import { SprayHoldInspector } from './SprayHoldInspector';
import { SprayRefineLayer } from './SprayRefineLayer';
import { planRefineExit, useSprayRefineSession, type RefineRejection } from './use-spray-refine-session';
import {
  FULL_REFINE_BRUSH_RANGE,
  refineBrushLimits,
  refineBrushRadiusAtZoom,
  refineBrushRangeAtZoom,
  type RefineMode,
} from './spray-refine';
import { useSprayRefineBrush } from './use-spray-refine-brush';
import { SprayHoverPreview } from './SprayHoverPreview';
import { SprayPencilSurface } from './SprayPencilSurface';
import { SprayTabletChrome } from './SprayTabletChrome';
import { SprayToolRail } from './SprayToolRail';
import { SprayEditorKeyScope } from './SprayEditorKeyScope';
import { SprayPencilPalette } from './SprayPencilPalette';
import { pencilPaletteCentre } from './pencil-palette-layout';
import {
  resolvePencilGesture,
  resolveSprayShortcut,
  sprayShortcutCommands,
  type SprayShortcutId,
} from './spray-editor-shortcuts';
import type { NativePencilGesture, NativeShortcutCommand } from '../../../modules/spray-editor-input/src/index';
import { pencilStrokeTarget } from './pencil-session';
import { useSprayPencilMode } from './use-spray-pencil-mode';
import { useSprayRailSide } from './use-spray-rail-side';
import {
  sprayTabletPlacement,
  SPRAY_INSPECTOR_WIDTH,
  SPRAY_RAIL_MARGIN,
  SPRAY_TABLET_CONTENT_MAX_WIDTH,
} from './spray-tablet-layout';
import { zoomTargetForHold } from './hold-navigation';
import { SprayUndoToast, type SprayUndoToastContent } from './SprayUndoToast';
import { resolveEditTap, type SprayEditorTool } from './spray-edit-tap';
import { SprayEditorBanner } from './SprayEditorBanner';
import { SprayEditorLoading, type SprayEditorLoadingPhoto } from './SprayEditorLoading';
import { SprayScanBand, SCAN_BAND_HEIGHT } from './SprayScanBand';
import { SprayHoldSpotlight } from './SprayHoldSpotlight';
import { SprayPublishSweep, PUBLISH_SWEEP_MS } from './SprayPublishSweep';
import {
  fitSprayPhoto,
  SPRAY_BAR_GUTTER,
  SPRAY_BAR_HEIGHT,
  SPRAY_BAR_TOTAL_HEIGHT,
  SPRAY_EDITOR_MAX_SCALE,
} from './spray-photo-frame';
import { photoSignatureLapsed, sprayFullResolutionPhoto } from './spray-full-photo';
import { useSprayAddShape, type SprayAddShape } from './use-spray-add-shape';
import { sprayPhotoReservesBottom, useSprayEditorLayout } from './use-spray-editor-layout';
import { sprayFlowCoversScreen } from '../../lib/spray/spray-flow-presentation';
import { revertedHold, type SpraySpotlightKind, type SpraySpotlightPulse } from './spray-spotlight';
import { useSprayEditorHints, type SprayHintId } from './use-spray-editor-hints';
import { renderToBoardScale, type StrokeRejection } from './stroke';
import { confirmPlanRemovals, planHasWork, prepareCommit } from './spray-hold-writes';
import {
  buildEditorSeed,
  holdsToCarryOver,
  seedIncludesCandidates,
  seedReason,
  sprayEditorSeedKey,
} from './spray-hold-seed';
import type { SprayHoldCandidate, SprayHoldSaveSummary } from './spray-hold-editor-types';
import type { HoldGeometry } from './spray-hold-tools';
import { editorTargetCapabilities, type SprayWallEditorTarget } from './editor-target';
import { fallbackRadiusAt, flattenHitHolds, holdReach, loupeMagnification } from './spray-gesture-math';
import {
  actionChangesWall,
  countEditorHolds,
  editorIsDirty,
  holdRole,
  holdsInIdOrder,
  initialSprayEditorState,
  sprayEditorReducer,
  type SprayEditorAction,
  type SprayEditorHold,
  type SprayEditorPresent,
  type SprayHoldRole,
} from './spray-hold-editor-reducer';
import { readingCursorPosition, readingOrderIndex, sprayHoldReadingOrder, stepReadingCursor } from './spray-hold-a11y';
import {
  clampPointToPhoto,
  defaultHoldRadius,
  holdAtPoint,
  holdFromPolygon,
  holdFromStroke,
  holdFromTap,
  holdRadiusBounds,
  POLYGON_MAX_VERTICES,
  stepHoldRadius,
  stepHoldRadiusBy,
  strokeExtent,
  toRingPoints,
} from './spray-hold-tools';

/** The ring reveal's sweep down the wall, after a fresh scan. */
const REVEAL_MS = 700;
/** Grid steps per screen-reader bigger / smaller: about 22% a swipe, so four swipes double a hold. */
const A11Y_RESIZE_STEPS = 4;
/** The maybes' fade once the ON rings are in. */
const MAYBE_FADE_MS = 250;
/** The whole reveal, when Reduce Motion turns it into a fade. */
const REVEAL_FADE_MS = 150;
/** How long the publish moment plays before the editor hands over. */
const CELEBRATION_MS = PUBLISH_SWEEP_MS + 250;
/** The same, with Reduce Motion: long enough to read the checkmark. */
const CELEBRATION_REDUCED_MS = 450;

/** Screenshot captures never show a hint over the wall. */
const SCREENSHOT_MODE = process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1';

const NO_POINTS: number[] = [];
const NO_HOLD_TARGETS: BoardHoldTarget[] = [];
const NO_SELECTION: number[] = [];
const NO_EDITOR_HOLDS: SprayEditorHold[] = [];
const NO_READING_ORDER: number[] = [];
/** A read-only viewer: the scope is still the root, with nothing to answer. */
const NO_SHORTCUT_COMMANDS: NativeShortcutCommand[] = [];

/** A cancelled Refine stroke needs nothing: the overlay clears its own points. */
const IGNORE_STROKE_CANCEL = () => {};

/**
 * Clear Refine's stroke preview, but only if it is still the stroke JS just
 * handled. Run on the UI thread, where the draw overlay writes the same value,
 * so the check and the clear cannot be split by the next stroke's touch-down:
 * a quick second dab that has already started keeps its points (a different
 * first sample), and its own end reads them intact.
 */
function clearStrokeIfStill(pointsSV: SharedValue<number[]>, firstX: number, firstY: number) {
  'worklet';
  const points = pointsSV.value;
  if (points.length >= 2 && points[0] === firstX && points[1] === firstY) pointsSV.value = [];
}

/** The screen-reader actions the wall always has. See `SprayWallAccessibility`. */
const WALL_A11Y_ACTIONS: readonly AccessibilityActionInfo[] = [
  { name: 'increment' },
  { name: 'decrement' },
  { name: 'activate' },
];

/**
 * A Draw stroke that stays inside this many screen points is a tap: it drops a
 * circle at the median hold size rather than failing as a stroke too short.
 */
const ADD_TAP_SLOP_PT = 10;

/** Corners an outline needs before it can close. */
const MIN_CORNERS = 3;

/** The loupe stays this far below the top of the editor, in points. */
const LOUPE_TOP_SAFE = spacing[2];

/** "Nothing below here to avoid" for the resize handle, until the bottom dock has been laid out. */
const NO_AVOID_TOP = 1e9;

/** How long the brush-size disc stays on the hold after the slider lets go, then fades, in ms. */
const REFINE_SIZE_RING_HOLD_MS = 700;
const REFINE_SIZE_RING_FADE_MS = 150;
/** Refine's brush clamp before a hold is open: never drawn, only a typed placeholder. */
const NO_REFINE_LIMITS = { floorBoardPx: 0, capBoardPx: 0 };

/** Where the zoomed-in reset control sits: top-left, clear of the chip bar and the bottom bar. */
const RESET_ZOOM_STYLE = { left: spacing[2], top: spacing[2] };
/** On iPad it goes to the top corner away from the tool rail. */
const RESET_ZOOM_STYLE_RIGHT = { right: spacing[2], top: spacing[2] };

/**
 * How much wall the inspector's Previous / Next frame round the hold they pick,
 * in units of its radius. Wide enough that the neighbours stay in view and a
 * walk down the wall reads as moving along it, not jumping between close-ups:
 * about 4x on an iPad for a typical spray hold.
 */
const STEP_FRAME_CONTEXT_RADII = 9;

// Re-exported so a caller that opens this screen imports one module. The shapes
// themselves live in `spray-hold-editor-types.ts`, which has no React in it, so
// the pure seeding rules can name a candidate without pulling the board surface
// into their test.
export type { SprayHoldCandidate, SprayHoldSaveSummary };

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
  /**
   * The rings have just been found: sweep them in from the top on first show,
   * then fade the maybes in. Only after a fresh scan. A resumed draft opens
   * with its holds already there.
   */
  revealOnMount?: boolean;
  /** The bottom bar's one filled button — "Pick a look" on the add-a-wall flow. */
  primaryLabel: string;
  /**
   * The wall's photo as this phone still holds it, when it does. Shown dimmed
   * while the draft loads, so the wait keeps the wall on screen. Without it the
   * wait is a spinner and a status line.
   */
  loadingPhoto?: SprayEditorLoadingPhoto | null;
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
  /**
   * True from the moment the primary button starts a commit until the editor
   * has handed over (`onCommitted`) or the save failed. Fired on change only.
   *
   * The host must not remove the screen while it is true, and must not ask
   * about it either: the holds may already be saved (the dirty flag is clear),
   * and removing the screen cancels the hand-over that would publish them.
   */
  onHandoverChange?: (handingOver: boolean) => void;
  /**
   * Asked before a save that takes stored holds off the wall (a removal, or a
   * move, which the server records as a removal plus a new hold), with their
   * ids. Resolves whether the save may go on. The hold route passes the
   * "Remove a hold that climbs use?" check; left out (a new wall in the wizard,
   * where no climb can use a hold yet), nothing is asked.
   */
  confirmHoldRemoval?: (holdIds: readonly number[]) => Promise<boolean>;
};

/**
 * The spray-wall hold editor (issue #5441), rebuilt around one idea: rings are
 * holds, a tap picks one, and a tap on the picked one switches it off or on.
 *
 * The detector's confident finds open ON and its unsure ones as dashed maybes,
 * so the climber's job is fixing the machine's mistakes rather than approving
 * every one of its guesses. A picked ring gets the chip bar for its role —
 * size, trace, join and switch off for an ON ring, switch on or delete for a
 * ghost, keep or switch off for a maybe — and a long press picks a ring up so
 * the same touch can carry on into a move, or on bare wall places a new hold
 * that slides with the finger until it lifts. The picked ring carries a resize
 * handle that scales it on the same 5% grid as the − / + chips. A stray tap
 * therefore never changes the wall: switching off leaves a ghost, and only a
 * ghost can be deleted.
 * Everything goes through one pure reducer with undo and redo, the heavy
 * actions raise an in-screen undo toast, and one button saves and hands over
 * (`onCommitted`).
 *
 * The board surface is the shared `InteractiveFilterBoard`. The rings, the dim
 * layer and the selection draw INSIDE its zoom transform; the gesture surface
 * sits above it and inverts the transform itself. Trace reuses the catalogue
 * editor's `DrawStrokeOverlay` and stroke → ring chain unchanged, so a wall's
 * traced outline obeys exactly the ring contract a board's does.
 *
 * On an iPad at full width (`useSprayEditorLayout`) the photo takes the whole
 * screen and the chrome changes shape around the same handlers: a tool rail
 * down one side (`SprayToolRail`), the picked hold in an inspector card on the
 * other (`SprayHoldInspector`), and the counts and the primary button in a
 * cluster at the bottom (`SprayTabletChrome`). The Apple Pencil marks there:
 * a Pencil tap switches a ring or adds one, a Pencil stroke outlines a hold,
 * and fingers pick and move around — see `pencil-session.ts`. A hardware
 * keyboard and the Pencil's double tap and squeeze reach the same handlers
 * through `SprayEditorKeyScope` (`spray-editor-shortcuts.ts`).
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
  revealOnMount = false,
  primaryLabel,
  loadingPhoto,
  notice,
  onCommitted,
  onDirtyChange,
  onHandoverChange,
  confirmHoldRemoval,
}: SprayHoldEditorScreenProps) {
  const { systemColors, motion } = useTheme();
  const reduceMotion = useReducedMotion();
  const { t } = useTranslation('boards');
  const insets = useSafeAreaInsets();
  const headerInset = useTransparentHeaderInset();
  const { layout, landscape } = useSprayEditorLayout();
  const tablet = layout === 'tablet';
  const tabletRef = useRef(tablet);
  tabletRef.current = tablet;
  // The Pencil marks and fingers inspect (iPad only). See `pencil-session.ts`.
  const pencil = useSprayPencilMode(tablet);
  const pencilOnlyRef = useRef(pencil.pencilOnly);
  pencilOnlyRef.current = pencil.pencilOnly;
  const pencilSeenRef = useRef(pencil.pencilSeen);
  pencilSeenRef.current = pencil.pencilSeen;
  const [railSide, setRailSide] = useSprayRailSide(tablet);
  /**
   * The wall-wide menu: the rail's More on iPad, the count capsule on a phone.
   * Kept here for both so Esc can close it.
   */
  const [menuOpen, setMenuOpen] = useState(false);
  /**
   * The Apple Pencil squeeze palette, open at the Pencil tip (null x/y: the
   * Pencil was not hovering, so mid-screen). iPad only. See `SprayPencilPalette`.
   */
  const [pencilPalette, setPencilPalette] = useState<{ x: number | null; y: number | null } | null>(null);

  const { isLoading, isUnavailable, isStalled, retry, homography, wall, photoFullUrl, refreshPhotoUrls } =
    useSprayWallDraft(layoutId, wallUuid, versionNumber, versionId);
  // The sharper photo for deep zoom (#5911). Null on walls that have none, which
  // keep the base photo alone.
  const fullResolutionPhoto = useMemo(() => sprayFullResolutionPhoto(wall, photoFullUrl), [wall, photoFullUrl]);
  const photoExpiresAt = wall?.photoExpiresAt ?? null;
  const lastPhotoRefreshAtRef = useRef(0);
  const handleFullPhotoError = useCallback(() => {
    // The full photo is first fetched on the first deep zoom, which in a long
    // sitting can be after the draft's 15-minute signature ran out. Read the
    // draft again for fresh URLs; anything else leaves the base photo on screen.
    // At most once a minute, so a photo that fails for another reason with a
    // clock that keeps saying "expired" cannot spin on refetches.
    const nowMs = Date.now();
    if (!photoExpiresAt || !photoSignatureLapsed(photoExpiresAt, nowMs)) return;
    if (nowMs - lastPhotoRefreshAtRef.current < 60 * 1000) return;
    lastPhotoRefreshAtRef.current = nowMs;
    refreshPhotoUrls();
  }, [photoExpiresAt, refreshPhotoUrls]);
  const saveHolds = useSaveSprayHolds();

  const capabilities = useMemo(() => {
    const target: SprayWallEditorTarget = { kind: 'sprayWall', wallUuid, layoutId, versionId, viewerCanEdit };
    return editorTargetCapabilities(target);
  }, [wallUuid, layoutId, versionId, viewerCanEdit]);

  const [tool, setTool] = useState<SprayEditorTool>('edit');
  /** "Joined 2 holds · Undo" after a heavy action, until it times out or the next edit. */
  const [undoToast, setUndoToast] = useState<SprayUndoToastContent | null>(null);
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
  /** The first seed has run, so "no holds" now means no holds rather than not loaded yet. */
  const [seeded, setSeeded] = useState(false);
  const [revealDone, setRevealDone] = useState(!revealOnMount);
  const [spotlight, setSpotlight] = useState<SpraySpotlightPulse | null>(null);
  /** The holds are saved and the publish moment is playing, just before the hand-over. */
  const [celebrating, setCelebrating] = useState(false);

  const [addShape, pickAddShape] = useSprayAddShape();
  /** Corners placed so far in Corners mode. The corners themselves live on the UI thread in `cornersSV`. */
  const [cornerCount, setCornerCount] = useState(0);
  /**
   * The hold add mode put in last. It keeps the resize handle (and no chip bar)
   * until the next add or the next touch on the wall, so a hold that went in
   * the wrong size is fixed without leaving add mode.
   */
  const [lastAddedId, setLastAddedId] = useState<number | null>(null);

  /**
   * Refine's brush: Add or Erase for the visit, and its size in screen points,
   * remembered per device (`useSprayRefineBrush`).
   */
  const [refineMode, setRefineMode] = useState<RefineMode>('add');
  const [refineBrushPt, pickRefineBrushPt] = useSprayRefineBrush();
  /** The slider's live size, read by the previews and by a stroke's commit. */
  const refineBrushPtSV = useSharedValue(refineBrushPt);
  /** The board's zoom when the live Refine stroke started: its preview and its commit both read it. */
  const refineStrokeZoomSV = useSharedValue(1);
  /** The brush-size disc over the hold: shown while the slider moves, faded out after. */
  const refineSizeRingSV = useSharedValue(0);
  /** The board's zoom, mirrored out of the board by the refine layer, for the size dot by the slider. */
  const refineBoardZoomSV = useSharedValue(1);
  /**
   * The zoom the board last SETTLED at, reported by the refine layer once per
   * settle (and once when Refine opens), never per frame: the slider's range
   * follows it.
   */
  const [refineSettledZoom, setRefineSettledZoom] = useState(1);
  /** A line about the last kept stroke that is not an error: the stray pieces it dropped. */
  const [refineNotice, setRefineNotice] = useState<string | null>(null);
  const refine = useSprayRefineSession();
  const refineView = refine.view;
  const refineHoldId = refineView?.holdId;
  // The size disc starts hidden on every open and goes with the session (Done,
  // Cancel, the hold vanishing): a slider drag cut short by leaving Refine never
  // gets the release that would fade it.
  useEffect(() => {
    refineSizeRingSV.value = 0;
  }, [refineHoldId, refineSizeRingSV]);
  const refineHoldRadius = refineView?.holdRadiusBoardPx;
  const refineFrame = refineView?.frame;
  /** The open hold's brush clamp, or null outside Refine. Fixed for the session. */
  const refineLimits = useMemo(
    () => (refineHoldRadius !== undefined && refineFrame ? refineBrushLimits(refineHoldRadius, refineFrame) : null),
    [refineHoldRadius, refineFrame],
  );
  // Read by the stroke handlers, so they keep one identity across strokes.
  const refineRef = useRef(refine);
  refineRef.current = refine;
  const refineModeRef = useRef(refineMode);
  refineModeRef.current = refineMode;
  useEffect(() => {
    refineBrushPtSV.value = refineBrushPt;
  }, [refineBrushPt, refineBrushPtSV]);

  const draftPointsSV = useSharedValue<number[]>(NO_POINTS);
  /** Refine's live brush stroke, in board px. Its own value, so it is drawn as a brush and not as Trace's line. */
  const refinePointsSV = useSharedValue<number[]>(NO_POINTS);
  const cornersSV = useSharedValue<number[]>(NO_POINTS);
  // Add mode's Draw takes a finger, whatever the target's default — unless
  // "Pencil only" is on, when fingers pan and only the Pencil draws.
  const addDrawSV = useSharedValue(true);
  const pencilOnlySV = useSharedValue(false);
  /** What a hovering Pencil is over, for `SprayHoverPreview`. Written by the edit overlay. */
  const hoverSV = useSharedValue<number[]>(NO_POINTS);
  useEffect(() => {
    addDrawSV.value = !pencil.pencilOnly;
    pencilOnlySV.value = pencil.pencilOnly;
  }, [pencil.pencilOnly, addDrawSV, pencilOnlySV]);
  // The corners are written on the UI thread (a tap, a close) and on JS (undo,
  // a refused close putting them back). The count is read from the one place
  // they live, so the two can never disagree.
  useAnimatedReaction(
    () => Math.floor(cornersSV.value.length / 2),
    (count, previous) => {
      if (count !== previous) runOnJS(setCornerCount)(count);
    },
    [cornersSV],
  );
  // The wall target draws with a finger — there is no Pencil in a garage.
  const fingerDrawSV = useSharedValue(capabilities.fingerDrawDefault);
  const hitHoldsSV = useSharedValue<number[]>(NO_POINTS);
  const selectedHoldSV = useSharedValue<number[]>(NO_SELECTION);
  const dragOffsetXSV = useSharedValue(0);
  const dragOffsetYSV = useSharedValue(0);
  const dragHoldIdSV = useSharedValue(0);
  /** The resize handle's live scale and the hold it is on (0 for none). See `SprayResizeHandle`. */
  const resizeScaleSV = useSharedValue(1);
  const resizeHoldIdSV = useSharedValue(0);
  /** A press and hold's circle under the finger, `[x, y, r]` in board px. See `SprayPlacementPreview`. */
  const placeHoldSV = useSharedValue<number[]>(NO_POINTS);
  /** The bottom dock's top edge in the board's own points, for the resize handle to stay above. */
  const avoidTopSV = useSharedValue(NO_AVOID_TOP);
  /** The finger the loupe follows, written by whichever overlay owns the touch. See `SprayLoupe`. */
  const loupeFeed = useSprayLoupeFeed();
  /** The loupe's magnification, which its own ring layers also read to keep their strokes thin. */
  const loupeMagnificationSV = useDerivedValue(() => loupeMagnification(loupeFeed.zoomSV.value));
  /** The reveal's progress: the ring layer's clip height, or its opacity with Reduce Motion. */
  const revealSV = useSharedValue(revealOnMount ? 0 : 1);
  const maybeRevealSV = useSharedValue(revealOnMount ? 0 : 1);
  const revealStartedRef = useRef(false);
  const spotlightKeyRef = useRef(0);
  /**
   * A commit is in flight, or its publish moment is still playing. A ref as well
   * as the mutation's flag, so a double press is refused synchronously.
   */
  const committingRef = useRef(false);
  const handoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onCommittedRef = useRef(onCommitted);
  onCommittedRef.current = onCommitted;
  const onHandoverChangeRef = useRef(onHandoverChange);
  onHandoverChangeRef.current = onHandoverChange;
  const reduceMotionRef = useRef(reduceMotion);
  reduceMotionRef.current = reduceMotion;

  /** Sets `committingRef` and tells the host, once per change. */
  const setHandingOver = useCallback((handingOver: boolean) => {
    if (committingRef.current === handingOver) return;
    committingRef.current = handingOver;
    onHandoverChangeRef.current?.(handingOver);
  }, []);

  useEffect(
    () => () => {
      if (handoverTimerRef.current != null) clearTimeout(handoverTimerRef.current);
      // A host that removed the screen anyway must not keep believing it is busy.
      if (committingRef.current) {
        committingRef.current = false;
        onHandoverChangeRef.current?.(false);
      }
    },
    [],
  );

  useEffect(() => {
    // Trace follows "Pencil only" too: with it on, a finger never draws.
    fingerDrawSV.value = capabilities.fingerDrawDefault && !pencil.pencilOnly;
  }, [capabilities.fingerDrawDefault, pencil.pencilOnly, fingerDrawSV]);

  // The registry is a module-level map, so the wall is read through
  // `useSyncExternalStore` — the same shape `useSprayWall` uses. Its own
  // `loadState` snapshot does NOT move when a wall is re-registered at the same
  // state (which is exactly what a save's refresh does), so the screen has to
  // subscribe to the wall itself or it would keep drawing the pre-save holds.

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
    setSeeded(true);
  }, [wall, seedKey, candidates]);

  const handleAreaLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setArea((previous) => (previous.width === width && previous.height === height ? previous : { width, height }));
  }, []);

  // Full width, fitted to the height the bottom bar leaves free. `slotHeight` is
  // that free height: the photo is centred in it, so a landscape wall sits in
  // the middle of the screen rather than pinned to the top over a black void.
  // On the tablet layout nothing is kept free and the photo fills the screen.
  // The scan step fits its photo the same way, so the rings land where the
  // scan band was.
  const photoWidth = wall?.photoWidth ?? 0;
  const photoHeight = wall?.photoHeight ?? 0;
  const reserveBottom = sprayPhotoReservesBottom(layout);
  const boardRender = useMemo(
    () =>
      fitSprayPhoto({
        areaWidth: area.width,
        areaHeight: area.height,
        bottomInset: insets.bottom,
        photoWidth,
        photoHeight,
        reserveBottom,
      }),
    [area.width, area.height, insets.bottom, photoWidth, photoHeight, reserveBottom],
  );

  const boardControlRef = useRef<FilterBoardControls | null>(null);
  /**
   * Bumped when the photo changes size, to remount the gesture overlay and so
   * drop whatever touch it was tracking. See below.
   */
  const [gestureEpoch, setGestureEpoch] = useState(0);
  const fittedSizeRef = useRef({ width: 0, height: 0 });
  // An iPad window resizes under the editor: a rotation, Split View, Stage
  // Manager, or the layout crossing between tablet and phone. The zoom is a
  // transform of the OLD size, so it is reset rather than left framing
  // something else, and a stroke or drag in progress is dropped rather than
  // finished against a board that moved under the finger. Its points are in
  // board pixels, so nothing already drawn is wrong; only the rest of the
  // stroke would be. iPad only: phones are portrait-locked, and Android keeps
  // the editor it had.
  useEffect(() => {
    const previous = fittedSizeRef.current;
    fittedSizeRef.current = { width: boardRender.width, height: boardRender.height };
    if (!sprayFlowCoversScreen() || previous.width === 0) return;
    if (previous.width === boardRender.width && previous.height === boardRender.height) return;
    boardControlRef.current?.resetZoom();
    draftPointsSV.value = NO_POINTS;
    refinePointsSV.value = NO_POINTS;
    dragOffsetXSV.value = 0;
    dragOffsetYSV.value = 0;
    dragHoldIdSV.value = 0;
    // A resize, a press-and-hold placement and the loupe are gestures in
    // progress too: they are dropped with the rest.
    resizeScaleSV.value = 1;
    resizeHoldIdSV.value = 0;
    placeHoldSV.value = NO_POINTS;
    loupeFeed.touchDownAtSV.value = 0;
    // The remounted overlay's old hover may never finalize: drop its ghost too.
    hoverSV.value = NO_POINTS;
    setMoveRevision((revision) => revision + 1);
    setGestureEpoch((epoch) => epoch + 1);
  }, [
    boardRender.width,
    boardRender.height,
    draftPointsSV,
    refinePointsSV,
    dragOffsetXSV,
    dragOffsetYSV,
    dragHoldIdSV,
    resizeScaleSV,
    resizeHoldIdSV,
    placeHoldSV,
    loupeFeed,
    hoverSV,
  ]);

  const boardScale = renderToBoardScale(wall?.photoWidth ?? 0, boardRender.width);
  /** Refine's slider range at the settled zoom: finest to biggest brush that paints differently. */
  const refineBrushRange = useMemo(
    () =>
      refineLimits ? refineBrushRangeAtZoom(boardScale, refineSettledZoom, refineLimits) : FULL_REFINE_BRUSH_RANGE,
    [boardScale, refineSettledZoom, refineLimits],
  );

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

  // An open Refine with strokes in it is unsaved work too: they reach the
  // reducer only on Done.
  const dirty = editorIsDirty(state, counts) || (refineView?.changed ?? false);
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
   * The hold size a press and hold places, and the unit of the 5% resize grid
   * the handle and the − / + steppers share. Measured over EVERY hold, so
   * hiding the maybes does not change what "a normal hold" means.
   */
  const medianRadius = useMemo(
    () => defaultHoldRadius(allEditorHolds, wall?.photoWidth ?? 0),
    [allEditorHolds, wall?.photoWidth],
  );
  const medianRadiusRef = useRef(medianRadius);
  medianRadiusRef.current = medianRadius;
  /** The same size, for a press and hold's circle and the Pencil hover's "a tap adds this" ghost. */
  const medianRadiusSV = useSharedValue(medianRadius);
  useEffect(() => {
    medianRadiusSV.value = medianRadius;
  }, [medianRadius, medianRadiusSV]);
  const radiusBounds = useMemo(
    () => holdRadiusBounds(medianRadius, photoWidth, photoHeight),
    [medianRadius, photoWidth, photoHeight],
  );

  const selectedHold = state.selectedId != null ? (state.holds[state.selectedId] ?? null) : null;
  const lastAddedHold = tool === 'add' && lastAddedId != null ? (state.holds[lastAddedId] ?? null) : null;
  /**
   * The ring drawn full strength over its ghost, and the one the resize handle
   * sits on: the selection, or in add mode the hold just added.
   */
  const focusedHold = tool === 'add' ? lastAddedHold : tool === 'refine' ? null : selectedHold;
  /**
   * Drawn as a faint ghost in the ring layer: the focused hold (its overlay
   * draws the real ring), or while refining the hold's ORIGINAL outline, under
   * the area being brushed.
   */
  const ghostedHoldId = refineView ? refineView.holdId : (focusedHold?.id ?? null);
  const focusedReachRatio = focusedHold && focusedHold.r > 0 ? holdReach(focusedHold) / focusedHold.r : 1;

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
  // Nothing takes a touch until the rings have finished arriving: a tap during
  // the sweep would land on a ring that is not drawn yet.
  const canEdit = viewerCanEdit && !committing && !celebrating && revealDone;
  const canEditRef = useRef(canEdit);
  canEditRef.current = canEdit;
  const toolRef = useRef(tool);
  toolRef.current = tool;

  // A hover left over from before a tool change must not flash up on the way back.
  useEffect(() => {
    hoverSV.value = NO_POINTS;
  }, [tool, hoverSV]);

  /** Says what the reveal found, once it has. A ref so the reveal effect need not re-run on a count. */
  const announceRevealRef = useRef(() => {});
  announceRevealRef.current = () => {
    AccessibilityInfo.announceForAccessibility(
      t('sprayEditor.a11y.revealed', { summary: sprayCountSummary(t, countsRef.current, showMaybes) }),
    );
  };

  const hints = useSprayEditorHints({
    enabled: viewerCanEdit && !SCREENSHOT_MODE,
    hasMaybes: showMaybes && counts.maybes > 0,
  });
  const recordHint = hints.record;

  // The reveal, once per mount and only after a fresh scan: the ring layer's
  // clip grows from the top of the photo to the bottom on the UI thread, the
  // maybes fade in after it, and one success buzz closes it. Waits for the first
  // seed and a laid-out board, so it plays over rings that are really there.
  const holdCount = allEditorHolds.length;
  useEffect(() => {
    if (!revealOnMount || revealStartedRef.current || !seeded || boardRender.height <= 0) return;
    revealStartedRef.current = true;
    if (holdCount === 0) {
      revealSV.value = 1;
      maybeRevealSV.value = 1;
      setRevealDone(true);
      return;
    }
    // Always ends the reveal, even when the animation was cut short: input is
    // locked until it does, so a reveal that never finished would leave a wall
    // that cannot be edited.
    const finish = (finished: boolean) => {
      if (!finished) {
        revealSV.value = 1;
        maybeRevealSV.value = 1;
      }
      hapticSuccess();
      setRevealDone(true);
      announceRevealRef.current();
    };
    if (reduceMotion) {
      // `Never`: with the default (`System`) Reduce Motion would skip the fade
      // itself and the rings would jump in, which is what this path replaces.
      const fade = { duration: REVEAL_FADE_MS, reduceMotion: ReduceMotion.Never };
      maybeRevealSV.value = withTiming(1, fade);
      revealSV.value = withTiming(1, fade, (finished) => {
        runOnJS(finish)(finished === true);
      });
      return;
    }
    revealSV.value = withTiming(1, { ...timingFor(motion.emphasized), duration: REVEAL_MS }, (finished) => {
      if (finished) maybeRevealSV.value = withTiming(1, { duration: MAYBE_FADE_MS });
      runOnJS(finish)(finished === true);
    });
  }, [revealOnMount, seeded, boardRender.height, holdCount, reduceMotion, motion.emphasized, revealSV, maybeRevealSV]);

  const renderHeight = boardRender.height;
  const revealClipStyle = useAnimatedStyle(() => {
    if (reduceMotion) return { height: renderHeight, opacity: revealSV.value };
    return { height: revealSV.value * renderHeight, opacity: 1 };
  }, [reduceMotion, renderHeight]);
  // The scan band rides the reveal's leading edge, so the scan step's sweep
  // reads as turning into the rings.
  const revealBandStyle = useAnimatedStyle(() => {
    const progress = revealSV.value;
    return {
      opacity: progress > 0 && progress < 1 ? 1 : 0,
      transform: [{ translateY: progress * renderHeight - SCAN_BAND_HEIGHT }],
    };
  }, [renderHeight]);

  /** Mark one hold with the spotlight. A fresh key every time, so a repeat still plays. */
  const pulseSpotlight = useCallback((kind: SpraySpotlightKind, hold: HoldGeometry) => {
    spotlightKeyRef.current += 1;
    setSpotlight({ key: spotlightKeyRef.current, kind, hold });
  }, []);

  // A one-shot tool needs its hold. An undo that took the selection away ends it.
  // Add mode has no hold of its own, so it is left alone.
  useEffect(() => {
    if ((tool === 'trace' || tool === 'join' || tool === 'refine') && selectedHold == null) setTool('edit');
  }, [tool, selectedHold]);

  // Refine ends with its tool, whichever way the tool ended — Start over, or an
  // undo toast that took the hold away. Done and Cancel have ended it already.
  useEffect(() => {
    if (tool === 'refine' || !refineRef.current.view) return;
    refineRef.current.cancel();
    refinePointsSV.value = NO_POINTS;
  }, [tool, refinePointsSV]);

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

  /**
   * A ring switched ON (`turnOn`) or OFF, with the cap check a tap, a chip and a
   * screen reader share. OFF is always a ghost, never a removal. False when the
   * cap refused it; true when it was already that way.
   */
  const switchHold = useCallback(
    (hold: SprayEditorHold, turnOn: boolean) => {
      const role = holdRole(hold);
      if (turnOn ? role === 'on' : role === 'off') return true;
      if (turnOn && countsRef.current.on >= MAX_HOLDS_PER_WALL) {
        refuseOverCap();
        return false;
      }
      if (turnOn) hapticLight();
      else hapticSelection();
      dispatch(turnOn ? { type: 'TOGGLE_HOLD', id: hold.id } : { type: 'SWITCH_OFF', id: hold.id });
      pulseSpotlight(turnOn ? 'toggleOn' : 'toggleOff', hold);
      recordHint(role === 'maybe' ? 'maybe' : 'toggle');
      return true;
    },
    [refuseOverCap, pulseSpotlight, recordHint],
  );

  /** The second tap on a picked ring: ON goes OFF, OFF or a maybe goes ON. */
  const toggleHold = useCallback((hold: SprayEditorHold) => switchHold(hold, holdRole(hold) !== 'on'), [switchHold]);

  /**
   * The undo stack as the toast last saw it. Null between raising a toast and
   * the render that carries its action, so the effect below can tell the
   * action that raised the toast from the edit after it.
   */
  const toastPastRef = useRef<readonly SprayEditorPresent[] | null>(null);
  const toastNonceRef = useRef(0);

  /**
   * Dispatch one of the heavy edits — Delete, Join, Keep all maybes, Start over
   * — and raise the undo toast for it. Only when the edit changed the wall: a
   * refused join must not leave an Undo that would take back the edit before it.
   */
  const dispatchWithUndoToast = useCallback((action: SprayEditorAction, message: string) => {
    if (!actionChangesWall(stateRef.current, action)) return false;
    dispatch(action);
    toastNonceRef.current += 1;
    toastPastRef.current = null;
    setUndoToast({ message, nonce: toastNonceRef.current });
    return true;
  }, []);

  // The toast goes the moment the wall changes again — an edit, an undo (its
  // own Undo included), a redo or a save — so its Undo can only ever undo the
  // action it names. Selecting a ring leaves the undo stack, and the toast,
  // alone.
  useEffect(() => {
    if (!undoToast) return;
    if (toastPastRef.current == null) {
      toastPastRef.current = state.past;
      return;
    }
    if (toastPastRef.current !== state.past) setUndoToast(null);
  }, [state.past, undoToast]);

  const dismissUndoToast = useCallback(() => setUndoToast(null), []);

  /** Join the selected hold with a second one. Shared by a tap and the screen reader's double tap. */
  const joinHolds = useCallback(
    (selectedId: number, otherId: number) => {
      const joined = dispatchWithUndoToast(
        { type: 'MERGE', ids: [selectedId, otherId] },
        t('sprayEditor.toast.joined'),
      );
      if (joined) {
        hapticMedium();
        recordHint('edit');
      } else {
        hapticWarning();
      }
      setJoinCursorId(null);
      setTool('edit');
      return joined;
    },
    [dispatchWithUndoToast, recordHint, t],
  );

  /** One hand-added hold, with the cap check every add shares. False when the cap refused it. */
  const addHold = useCallback(
    (geometry: HoldGeometry) => {
      if (countsRef.current.on >= MAX_HOLDS_PER_WALL) {
        refuseOverCap();
        return false;
      }
      hapticMedium();
      // The id ADD_HOLD is about to take: add mode keeps a resize handle on it.
      setLastAddedId(stateRef.current.nextLocalId);
      dispatch({ type: 'ADD_HOLD', geometry });
      pulseSpotlight('add', geometry);
      recordHint('add');
      return true;
    },
    [refuseOverCap, pulseSpotlight, recordHint],
  );

  const handleTap = useCallback(
    (boardX: number, boardY: number, zoom: number, isStylus = false) => {
      if (!canEditRef.current) return;
      setErrorText(null);
      const current = stateRef.current;
      const fallbackRadius = fallbackRadiusAt(boardScale, zoom);
      // A hidden maybe is still a hold under the finger, so a tap there picks
      // the maybe rather than finding nothing.
      const hit =
        holdAtPoint(visibleHoldsRef.current, boardX, boardY, fallbackRadius) ??
        holdAtPoint(hiddenMaybesRef.current, boardX, boardY, fallbackRadius);

      // The Pencil's own rule applies on the iPad layout only.
      const input = tabletRef.current && isStylus ? 'pencil' : 'finger';
      const answer = resolveEditTap({
        tool: toolRef.current,
        hitId: hit?.id ?? null,
        selectedId: current.selectedId,
        input,
        pencilOnly: pencilOnlyRef.current,
      });
      switch (answer) {
        case 'select':
          if (!hit) return;
          hapticSelection();
          dispatch({ type: 'SELECT', id: hit.id });
          // A finger picking a ring is the half of the Pencil lesson nobody
          // finds by accident, so once a Pencil is out it uses that hint up.
          recordHint(input === 'finger' && pencilSeenRef.current ? 'fingerPick' : 'select');
          return;
        case 'toggle':
          if (hit) toggleHold(hit);
          return;
        case 'deselect':
          // The first tap away from a hold is "I'm done with it", nothing more.
          dispatch({ type: 'SELECT', id: null });
          return;
        case 'merge':
          if (hit && current.selectedId != null) joinHolds(current.selectedId, hit.id);
          return;
        case 'bareWallHint':
          // A tap here used to add a hold. It no longer does, so it is answered
          // rather than ignored: a ripple where it landed, and a hint saying
          // where adding lives now.
          pulseSpotlight('ping', holdFromTap(boardX, boardY, medianRadiusRef.current));
          recordHint('bareWall');
          return;
        case 'addHold':
          // A Pencil tap on bare wall: the Pencil marks.
          addHold(holdFromTap(boardX, boardY, medianRadiusRef.current));
          return;
        case 'none':
          return;
      }
    },
    [boardScale, toggleHold, joinHolds, pulseSpotlight, recordHint, addHold],
  );

  const handlePickUp = useCallback(
    (holdId: number) => {
      if (!canEditRef.current || toolRef.current !== 'edit') return;
      setErrorText(null);
      hapticSelection();
      dispatch({ type: 'SELECT', id: holdId });
      recordHint('longPress');
    },
    [recordHint],
  );

  const handleMoveEnd = useCallback(
    (holdId: number, deltaX: number, deltaY: number) => {
      const hold = stateRef.current.holds[holdId];
      if (canEditRef.current && hold && !editWouldPassCap(hold)) {
        // A finger dragged past the board's edge leaves the hold at the edge.
        const centre = clampPointToPhoto(hold.cx + deltaX, hold.cy + deltaY, photoWidth, photoHeight);
        dispatch({ type: 'MOVE_HOLD', id: holdId, cx: centre.x, cy: centre.y });
        recordHint('edit');
      }
      // Always, so the preview re-syncs to the reducer's answer — including a
      // refused move, which snaps back, and a clamped one.
      setMoveRevision((revision) => revision + 1);
    },
    [editWouldPassCap, recordHint, photoWidth, photoHeight],
  );

  // One press is one step of the same 5% grid the handle snaps to, and one undo step.
  const shrinkTo = selectedHold ? stepHoldRadius(selectedHold.r, medianRadius, -1, radiusBounds) : null;
  const growTo = selectedHold ? stepHoldRadius(selectedHold.r, medianRadius, 1, radiusBounds) : null;

  /** The selected hold to a new radius: one `RESIZE_HOLD`, one undo step. */
  const resizeSelectedTo = useCallback(
    (radius: number | null) => {
      if (!canEdit || !selectedHold || radius == null || editWouldPassCap(selectedHold)) return;
      hapticSelection();
      dispatch({ type: 'RESIZE_HOLD', id: selectedHold.id, r: radius });
      recordHint('edit');
    },
    [canEdit, selectedHold, editWouldPassCap, recordHint],
  );
  const handleShrink = useCallback(() => resizeSelectedTo(shrinkTo), [resizeSelectedTo, shrinkTo]);
  const handleGrow = useCallback(() => resizeSelectedTo(growTo), [resizeSelectedTo, growTo]);
  /** The screen reader's bigger / smaller: a few grid steps per swipe, still one undo step. */
  const handleAccessibilityResize = useCallback(
    (direction: 1 | -1) => {
      if (!selectedHold) return;
      resizeSelectedTo(stepHoldRadiusBy(selectedHold.r, medianRadius, direction, radiusBounds, A11Y_RESIZE_STEPS));
    },
    [selectedHold, medianRadius, radiusBounds, resizeSelectedTo],
  );

  /**
   * The resize handle let go at a new radius: one `RESIZE_HOLD`, one undo step.
   * Resizing an OFF ring or a maybe switches it ON, so it meets the cap check;
   * a refusal snaps the ring back to the size it had.
   */
  const handleResizeEnd = useCallback(
    (holdId: number, radius: number) => {
      const hold = stateRef.current.holds[holdId];
      if (!canEditRef.current || !hold || hold.r === radius || editWouldPassCap(hold)) {
        resizeScaleSV.value = 1;
        return;
      }
      setErrorText(null);
      // `SelectedHoldOverlay` hands the live scale back to 1 in the commit that
      // draws the new radius.
      dispatch({ type: 'RESIZE_HOLD', id: holdId, r: radius });
      recordHint('edit');
    },
    [editWouldPassCap, recordHint, resizeScaleSV],
  );

  /** Set by a placement; the layout effect below clears the preview in the commit that draws the hold. */
  const clearPlacementOnRenderRef = useRef(false);
  useLayoutEffect(() => {
    if (!clearPlacementOnRenderRef.current) return;
    clearPlacementOnRenderRef.current = false;
    placeHoldSV.value = NO_POINTS;
  }, [state.holds, placeHoldSV]);

  const handlePlaceStart = useCallback(() => {
    setErrorText(null);
    hapticMedium();
  }, []);

  /**
   * A press and hold on bare wall lifted here: a median-size circle goes in and
   * is selected, so the handle is on it straight away. ADD_HOLD then SELECT is
   * one undo step — selecting never touches the history.
   */
  const handlePlace = useCallback(
    (boardX: number, boardY: number) => {
      if (!canEditRef.current || toolRef.current !== 'edit') {
        placeHoldSV.value = NO_POINTS;
        return;
      }
      if (countsRef.current.on >= MAX_HOLDS_PER_WALL) {
        placeHoldSV.value = NO_POINTS;
        refuseOverCap();
        return;
      }
      const newId = stateRef.current.nextLocalId;
      // The finger can slide past the board's edge before it lifts.
      const centre = clampPointToPhoto(boardX, boardY, photoWidth, photoHeight);
      const geometry = holdFromTap(centre.x, centre.y, medianRadiusRef.current);
      clearPlacementOnRenderRef.current = true;
      dispatch({ type: 'ADD_HOLD', geometry });
      dispatch({ type: 'SELECT', id: newId });
      pulseSpotlight('add', geometry);
      recordHint('add');
    },
    [placeHoldSV, refuseOverCap, pulseSpotlight, recordHint, photoWidth, photoHeight],
  );

  const handleStartTrace = useCallback(() => {
    setErrorText(null);
    setTool('trace');
  }, []);

  const handleStartJoin = useCallback(() => {
    setErrorText(null);
    setJoinCursorId(null);
    setTool('join');
  }, []);

  /** Refine on the picked hold: its outline (or its circle) becomes an area to brush. ON holds only, like Trace. */
  const handleStartRefine = useCallback(() => {
    const current = stateRef.current;
    const hold = current.selectedId != null ? current.holds[current.selectedId] : null;
    if (!canEditRef.current || !hold || holdRole(hold) !== 'on') return;
    setErrorText(null);
    setRefineNotice(null);
    // Its Undo would take back a wall edit from under the open session.
    setUndoToast(null);
    refinePointsSV.value = NO_POINTS;
    refineRef.current.start(hold);
    hapticSelection();
    setTool('refine');
  }, [refinePointsSV]);

  /**
   * Leave Refine. Kept, the area goes on the hold as ONE `SET_OUTLINE` — one
   * step for the editor's Undo, however many strokes made it. Not kept, every
   * stroke is dropped and the hold is as it was.
   */
  const leaveRefine = useCallback(
    (keep: boolean) => {
      const session = refineRef.current;
      const holdId = session.view?.holdId ?? null;
      const hold = holdId != null ? stateRef.current.holds[holdId] : undefined;
      // Everything that can stop a commit is checked BEFORE the session ends,
      // so a refusal leaves the climber in Refine with every stroke intact.
      const plan = planRefineExit({
        keep,
        result: keep ? session.result() : null,
        holdExists: hold != null,
        canEdit: canEditRef.current,
        overCap: hold != null && holdRole(hold) !== 'on' && countsRef.current.on >= MAX_HOLDS_PER_WALL,
      });
      if (plan.kind === 'stay') {
        if (plan.reason === 'cap') refuseOverCap();
        else if (plan.reason === 'refused') {
          hapticWarning();
          setErrorText(refineRejectionMessage(plan.rejection, t));
        }
        return false;
      }
      if (plan.kind === 'commit' && holdId != null) {
        hapticMedium();
        dispatch({ type: 'SET_OUTLINE', id: holdId, geometry: plan.hold });
        recordHint('edit');
      }
      session.cancel();
      refinePointsSV.value = NO_POINTS;
      setRefineNotice(null);
      setErrorText(null);
      setTool('edit');
      return true;
    },
    [refinePointsSV, refuseOverCap, recordHint, t],
  );
  const handleRefineDone = useCallback(() => leaveRefine(true), [leaveRefine]);

  const handleRefineModeChange = useCallback((mode: RefineMode) => {
    setErrorText(null);
    setRefineNotice(null);
    setRefineMode(mode);
  }, []);

  // The slider ticks its own haptics. A live value shows the size disc on the
  // hold; a commit (or a cancel) leaves it up long enough to read, then fades it.
  const handleRefineBrushLive = useCallback(
    (screenPt: number) => {
      refineBrushPtSV.value = screenPt;
      refineSizeRingSV.value = withTiming(1, { duration: REFINE_SIZE_RING_FADE_MS });
    },
    [refineBrushPtSV, refineSizeRingSV],
  );
  const fadeRefineSizeRing = useCallback(() => {
    refineSizeRingSV.value = withDelay(REFINE_SIZE_RING_HOLD_MS, withTiming(0, { duration: REFINE_SIZE_RING_FADE_MS }));
  }, [refineSizeRingSV]);
  const handleRefineBrushCommit = useCallback(
    (screenPt: number) => {
      refineBrushPtSV.value = screenPt;
      pickRefineBrushPt(screenPt);
      fadeRefineSizeRing();
    },
    [pickRefineBrushPt, refineBrushPtSV, fadeRefineSizeRing],
  );
  const handleRefineBrushCancel = useCallback(() => {
    refineBrushPtSV.value = refineBrushPt;
    fadeRefineSizeRing();
  }, [refineBrushPt, refineBrushPtSV, fadeRefineSizeRing]);

  const handleRefineStrokeStart = useCallback(() => {
    setErrorText(null);
    setRefineNotice(null);
  }, []);

  /** A kept stroke's first sample; the layout effect below clears its preview in the commit that draws the new area. */
  const pendingRefineClearRef = useRef<readonly [number, number] | null>(null);
  useLayoutEffect(() => {
    const pending = pendingRefineClearRef.current;
    if (!pending) return;
    pendingRefineClearRef.current = null;
    runOnUI(clearStrokeIfStill)(refinePointsSV, pending[0], pending[1]);
  }, [refineView, refinePointsSV]);

  /**
   * One Refine stroke lifted: paint it into the area with the brush size in
   * screen points at the zoom the stroke started at, clamped to the hold
   * (`refineBrushRadiusAtZoom`, the radius its preview drew). A kept stroke
   * ticks; one that would leave nothing storable is refused with the reason and
   * the area is untouched.
   */
  const handleRefineStrokeEnd = useCallback(
    (strokeBoardPoints: number[]) => {
      if (strokeBoardPoints.length < 2) return;
      const firstX = strokeBoardPoints[0];
      const firstY = strokeBoardPoints[1];
      const session = refineRef.current;
      const view = session.view;
      if (!canEditRef.current || !view) {
        runOnUI(clearStrokeIfStill)(refinePointsSV, firstX, firstY);
        return;
      }
      const { floorBoardPx, capBoardPx } = refineBrushLimits(view.holdRadiusBoardPx, view.frame);
      const radius = refineBrushRadiusAtZoom(
        refineBrushPtSV.get(),
        boardScale,
        refineStrokeZoomSV.get(),
        floorBoardPx,
        capBoardPx,
      );
      const liftStartedAt = __DEV__ ? performance.now() : 0;
      const outcome = session.applyStroke(strokeBoardPoints, radius, refineModeRef.current);
      // Device QA reads the real per-lift cost here; Node's numbers are in spray-refine.ts.
      if (__DEV__) {
        console.info(
          `[refine] lift ${(performance.now() - liftStartedAt).toFixed(1)} ms, brush ${radius.toFixed(2)} board px, ${outcome.ok ? 'kept' : outcome.reason}`,
        );
      }
      // Add reached the furthest a hold can grow and the rest was clipped: say
      // so, or the brush just looks like it stopped working.
      const limitLine = outcome.reachedLimit ? t('sprayEditor.refine.atLimit') : null;
      if (outcome.ok) {
        // The preview stays until the commit that draws the new area, so the
        // stroke does not blink out while JS works (at most a frame between the
        // clear and the new path mounting on Fabric).
        pendingRefineClearRef.current = [firstX, firstY];
        if (limitLine) {
          hapticWarning();
          setRefineNotice(limitLine);
          return;
        }
        hapticSelection();
        if (outcome.droppedPieces > 0) {
          setRefineNotice(t('sprayEditor.refine.dropped', { count: outcome.droppedPieces }));
        }
        return;
      }
      runOnUI(clearStrokeIfStill)(refinePointsSV, firstX, firstY);
      // A stroke that painted nothing (erasing bare wall, adding inside) is not
      // an error — unless it painted nothing because it was all past the limit.
      if (outcome.reason === 'no-change') {
        if (limitLine) {
          hapticWarning();
          setRefineNotice(limitLine);
        }
        return;
      }
      hapticWarning();
      setErrorText(refineRejectionMessage(outcome.reason, t));
    },
    [refinePointsSV, refineBrushPtSV, refineStrokeZoomSV, boardScale, t],
  );

  const handleCancelTool = useCallback(() => {
    if (toolRef.current === 'refine') {
      leaveRefine(false);
      return;
    }
    draftPointsSV.value = NO_POINTS;
    setErrorText(null);
    setJoinCursorId(null);
    setTool('edit');
  }, [draftPointsSV, leaveRefine]);

  const clearCorners = useCallback(() => {
    cornersSV.value = NO_POINTS;
  }, [cornersSV]);

  /**
   * Closes a Corners outline the caller has already taken off `cornersSV`.
   * A refusal puts the corners back, so one crossed side costs one undo rather
   * than the whole outline. True when the hold went on the wall.
   */
  const closeCorners = useCallback(
    (cornerBoardPoints: number[]) => {
      // Only onto an empty board: a corner tapped while JS was deciding starts
      // the climber's next attempt, and wins over the refused one.
      const restore = () => {
        if (cornersSV.value.length === 0) cornersSV.value = cornerBoardPoints;
      };
      if (!canEditRef.current) {
        restore();
        return false;
      }
      const outlined = holdFromPolygon(toRingPoints(cornerBoardPoints));
      if (!outlined.ok) {
        hapticWarning();
        setErrorText(cornersRejectionMessage(outlined.reason, t));
        restore();
        return false;
      }
      setErrorText(null);
      if (addHold(outlined.hold)) return true;
      restore();
      return false;
    },
    [addHold, cornersSV, t],
  );

  /** Takes the corners off the UI thread, the same hand-off the first-corner tap makes, then closes them. */
  const takeAndCloseCorners = useCallback(() => {
    const corners = cornersSV.value;
    cornersSV.value = NO_POINTS;
    return closeCorners(corners);
  }, [closeCorners, cornersSV]);

  const handleCornerAdded = useCallback(() => {
    setErrorText(null);
    setLastAddedId(null);
    hapticSelection();
  }, []);

  const handleCornerLimit = useCallback(() => {
    hapticWarning();
  }, []);

  const leaveAddMode = useCallback(() => {
    // Done means done: an outline with enough corners is kept rather than
    // thrown away. One that cannot close stays on screen with its error, in
    // add mode, so the climber can fix it or undo it.
    if (cornersSV.value.length / 2 >= MIN_CORNERS && !takeAndCloseCorners()) return;
    clearCorners();
    draftPointsSV.value = NO_POINTS;
    setLastAddedId(null);
    setTool('edit');
  }, [takeAndCloseCorners, clearCorners, cornersSV, draftPointsSV]);

  const handleToggleAddMode = useCallback(() => {
    if (toolRef.current === 'add') {
      leaveAddMode();
      return;
    }
    // Refine's strokes are kept, not thrown away by a tap on +. One that could
    // not be kept says why and stays out of add mode.
    if (toolRef.current === 'refine' && !leaveRefine(true)) return;
    setErrorText(null);
    setJoinCursorId(null);
    draftPointsSV.value = NO_POINTS;
    clearCorners();
    // Nothing is picked up while adding, so nothing stays picked up either.
    dispatch({ type: 'SELECT', id: null });
    setLastAddedId(null);
    hapticSelection();
    setTool('add');
  }, [leaveAddMode, leaveRefine, clearCorners, draftPointsSV]);

  const handleAddShapeChange = useCallback(
    (shape: SprayAddShape) => {
      setErrorText(null);
      clearCorners();
      draftPointsSV.value = NO_POINTS;
      pickAddShape(shape);
    },
    [clearCorners, draftPointsSV, pickAddShape],
  );

  /** A Draw stroke in add mode: a new hold round it, or a circle when it was really a tap. */
  const handleAddStrokeEnd = useCallback(
    (strokeBoardPoints: number[], zoom: number) => {
      draftPointsSV.value = NO_POINTS;
      if (!canEditRef.current || strokeBoardPoints.length < 2) return;
      const tapSlop = (ADD_TAP_SLOP_PT * boardScale) / Math.max(1, zoom);
      if (strokeExtent(strokeBoardPoints) <= tapSlop) {
        setErrorText(null);
        addHold(holdFromTap(strokeBoardPoints[0], strokeBoardPoints[1], medianRadiusRef.current));
        return;
      }
      const drawn = holdFromStroke(toRingPoints(strokeBoardPoints));
      if (!drawn.ok) {
        hapticWarning();
        setErrorText(rejectionMessage(drawn.reason, t));
        return;
      }
      setErrorText(null);
      addHold(drawn.hold);
    },
    [draftPointsSV, boardScale, addHold, t],
  );

  /** Delete the picked hold — only ever a ghost, so a removal is always two deliberate steps. */
  const handleDelete = useCallback(() => {
    if (!canEdit || !selectedHold || holdRole(selectedHold) !== 'off') return;
    if (!dispatchWithUndoToast({ type: 'DELETE', id: selectedHold.id }, t('sprayEditor.toast.deleted'))) return;
    hapticMedium();
    recordHint('edit');
  }, [canEdit, selectedHold, dispatchWithUndoToast, recordHint, t]);

  const handleSwitchSelectedOff = useCallback(() => {
    if (!canEdit || !selectedHold) return;
    setErrorText(null);
    switchHold(selectedHold, false);
  }, [canEdit, selectedHold, switchHold]);

  const handleSwitchSelectedOn = useCallback(() => {
    if (!canEdit || !selectedHold) return;
    setErrorText(null);
    switchHold(selectedHold, true);
  }, [canEdit, selectedHold, switchHold]);

  const handleStrokeStart = useCallback(() => setErrorText(null), []);
  /** A touch on the wall in add mode: the last hold added is done with, so its handle goes. */
  const handleAddStrokeStart = useCallback(() => {
    setErrorText(null);
    setLastAddedId(null);
  }, []);
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
      recordHint('edit');
      setTool('edit');
    },
    [draftPointsSV, editWouldPassCap, t, recordHint],
  );

  /**
   * Take back the last wall edit. The toast's Undo calls this directly: it
   * names one edit, so it must never spend itself on a Corners corner instead.
   */
  const undoWallEdit = useCallback(() => {
    setErrorText(null);
    hapticSelection();
    // Worked out before the dispatch, from the snapshot the undo is about to
    // restore: the hold it changes gets the violet halo.
    const current = stateRef.current;
    const restoring = current.past[current.past.length - 1];
    const reverted = restoring ? revertedHold(current.holds, restoring.holds) : null;
    dispatch({ type: 'UNDO' });
    // A snapshot from before add mode carries its selection; nothing is picked
    // up while adding.
    if (toolRef.current === 'add') dispatch({ type: 'SELECT', id: null });
    if (reverted) pulseSpotlight('undo', reverted);
  }, [pulseSpotlight]);

  /** The bar's Undo: a Corners outline in progress gives back its last corner before any hold. */
  const handleUndo = useCallback(() => {
    // While refining, Undo takes back one stroke; the hold itself is untouched until Done.
    if (toolRef.current === 'refine') {
      if (refineRef.current.undo()) {
        setErrorText(null);
        setRefineNotice(null);
        hapticSelection();
      }
      return;
    }
    const corners = cornersSV.value;
    if (toolRef.current === 'add' && corners.length >= 2) {
      setErrorText(null);
      hapticSelection();
      cornersSV.value = corners.slice(0, -2);
      return;
    }
    undoWallEdit();
  }, [cornersSV, undoWallEdit]);

  const handleRedo = useCallback(() => {
    if (toolRef.current === 'refine') return;
    const current = stateRef.current;
    const next = current.future[current.future.length - 1];
    if (!next) return;
    setErrorText(null);
    hapticSelection();
    // The same halo Undo gives, on the hold the redo changes.
    const changed = revertedHold(current.holds, next.holds);
    dispatch({ type: 'REDO' });
    if (toolRef.current === 'add') dispatch({ type: 'SELECT', id: null });
    if (changed) pulseSpotlight('undo', changed);
  }, [pulseSpotlight]);

  const handleKeepMaybes = useCallback(() => {
    if (!canEditRef.current) return;
    const maybes = countsRef.current.maybes;
    if (countsRef.current.on + maybes > MAX_HOLDS_PER_WALL) {
      refuseOverCap();
      return;
    }
    if (!dispatchWithUndoToast({ type: 'KEEP_MAYBES' }, t('sprayEditor.toast.keptMaybes', { count: maybes }))) return;
    hapticLight();
    // Keeping them all is the lesson the maybe hint teaches, done in bulk, so it
    // counts as using it: otherwise the hint comes back on the next wall.
    recordHint('maybe');
  }, [refuseOverCap, dispatchWithUndoToast, recordHint, t]);

  const handleToggleMaybes = useCallback(() => {
    const selected = stateRef.current.selectedId != null ? stateRef.current.holds[stateRef.current.selectedId] : null;
    // A hidden ring cannot stay under the chip bar.
    if (showMaybes && selected && holdRole(selected) === 'maybe') dispatch({ type: 'SELECT', id: null });
    setShowMaybes((shown) => !shown);
  }, [showMaybes]);

  const handleStartOver = useCallback(() => {
    if (!canEditRef.current) return;
    setErrorText(null);
    clearCorners();
    setTool('edit');
    setShowMaybes(true);
    dispatchWithUndoToast({ type: 'START_OVER', holds: seedHoldsRef.current }, t('sprayEditor.toast.startedOver'));
  }, [clearCorners, dispatchWithUndoToast, t]);

  /** The first Pencil touch or hover: "Pencil only" turns itself on, and the Pencil hint asks to be shown. */
  const notePencil = pencil.notePencil;
  const handlePencilSeen = useCallback(() => {
    if (notePencil()) recordHint('pencil');
  }, [notePencil, recordHint]);
  // `notePencil` answers true once per app process, but the hints' "asked"
  // flag restarts with each mount: a Pencil met on an earlier wizard step still
  // asks for its hint here. Idempotent, and a hint already used stays hidden.
  // `viewerCanEdit` is a dep because the hints ignore events until it is true.
  const pencilSeen = pencil.pencilSeen;
  useEffect(() => {
    if (pencilSeen && viewerCanEdit) recordHint('pencil');
  }, [pencilSeen, viewerCanEdit, recordHint]);

  /**
   * A Pencil on the resting iPad editor, anywhere but the selected ring (that
   * touch is a move, and the edit overlay has it). Short enough to be a tap, it
   * is the Pencil's tap: switch the ring under it, or add one on bare wall. A
   * real stroke outlines a hold — a new one, or the selected one again when
   * the loop is centred inside it.
   */
  const handlePencilStroke = useCallback(
    (strokeBoardPoints: number[], zoom: number) => {
      draftPointsSV.value = NO_POINTS;
      if (!canEditRef.current || toolRef.current !== 'edit' || strokeBoardPoints.length < 2) return;
      const tapSlop = (ADD_TAP_SLOP_PT * boardScale) / Math.max(1, zoom);
      if (strokeExtent(strokeBoardPoints) <= tapSlop) {
        handleTap(strokeBoardPoints[0], strokeBoardPoints[1], zoom, true);
        return;
      }
      const drawn = holdFromStroke(toRingPoints(strokeBoardPoints));
      if (!drawn.ok) {
        hapticWarning();
        setErrorText(rejectionMessage(drawn.reason, t));
        return;
      }
      setErrorText(null);
      const current = stateRef.current;
      const selected = current.selectedId != null ? (current.holds[current.selectedId] ?? null) : null;
      const target = pencilStrokeTarget(drawn.hold, selected);
      if (target.kind === 'add' || !selected) {
        addHold(drawn.hold);
        return;
      }
      if (editWouldPassCap(selected)) return;
      hapticMedium();
      dispatch({ type: 'SET_OUTLINE', id: target.id, geometry: drawn.hold });
      recordHint('edit');
    },
    [draftPointsSV, boardScale, handleTap, addHold, editWouldPassCap, recordHint, t],
  );

  /** iPad: a quick two-finger tap takes back the last wall edit. */
  const handleTwoFingerUndo = useCallback(() => {
    if (!canEditRef.current || stateRef.current.past.length === 0) return;
    undoWallEdit();
  }, [undoWallEdit]);

  /** The rail's Mark: back to the resting tool from Add, Trace, Join or Refine. Add and Refine keep their work, as their Done does. */
  const handleMarkTool = useCallback(() => {
    if (toolRef.current === 'add') leaveAddMode();
    else if (toolRef.current === 'refine') leaveRefine(true);
    else handleCancelTool();
  }, [leaveAddMode, leaveRefine, handleCancelTool]);

  const handleFitWall = useCallback(() => boardControlRef.current?.resetZoom(), []);
  const handlePutDown = useCallback(() => dispatch({ type: 'SELECT', id: null }), []);
  const toggleMenu = useCallback(() => setMenuOpen((open) => !open), []);
  const closeMenu = useCallback(() => setMenuOpen(false), []);

  /**
   * The inspector's Previous / Next: pick the neighbouring ring in reading order
   * (the screen reader's walk) and frame it, so a correction pass goes hold by
   * hold without hunting for the next one.
   */
  const stepSelection = useCallback(
    (delta: 1 | -1) => {
      if (!canEditRef.current || toolRef.current !== 'edit') return;
      const nextId = stepReadingCursor(
        readingOrderRef.current,
        readingIndexRef.current,
        stateRef.current.selectedId,
        delta,
      );
      const hold = nextId != null ? stateRef.current.holds[nextId] : null;
      if (nextId == null || !hold) return;
      setErrorText(null);
      hapticSelection();
      dispatch({ type: 'SELECT', id: nextId });
      boardControlRef.current?.zoomTo(
        zoomTargetForHold({
          hold,
          boardWidth: photoWidth,
          renderWidth: boardRender.width,
          renderHeight: boardRender.height,
          contextRadii: STEP_FRAME_CONTEXT_RADII,
          maxScale: SPRAY_EDITOR_MAX_SCALE,
        }),
      );
    },
    [photoWidth, boardRender.width, boardRender.height],
  );
  const handleSelectPrevious = useCallback(() => stepSelection(-1), [stepSelection]);
  const handleSelectNext = useCallback(() => stepSelection(1), [stepSelection]);

  /**
   * The holds are on the draft: play the publish moment, then hand over. The
   * hand-over waits for it because the host moves on (the wizard swaps this
   * screen for its publish step) the moment `onCommitted` fires. `committingRef`
   * stays set until then, so the button cannot start a second commit.
   */
  const celebrateThenHandOver = useCallback(
    (summary: SprayHoldSaveSummary) => {
      setHandingOver(true);
      hapticSuccess();
      setCelebrating(true);
      AccessibilityInfo.announceForAccessibility(t('sprayEditor.bar.saved'));
      handoverTimerRef.current = setTimeout(
        () => {
          handoverTimerRef.current = null;
          setCelebrating(false);
          // Hand over first, THEN drop the flag: the host moves on inside
          // `onCommitted`, so there is no moment where it could see the editor
          // idle on a step it is about to leave.
          onCommittedRef.current?.(summary);
          setHandingOver(false);
        },
        reduceMotionRef.current ? CELEBRATION_REDUCED_MS : CELEBRATION_MS,
      );
    },
    [setHandingOver, t],
  );

  const confirmHoldRemovalRef = useRef(confirmHoldRemoval);
  confirmHoldRemovalRef.current = confirmHoldRemoval;
  const unmountedRef = useRef(false);
  useEffect(
    () => () => {
      unmountedRef.current = true;
    },
    [],
  );

  /**
   * The plan for this press, or null after saying why there is none. Re-run
   * after the removal check, so holds taken off while it was up are asked
   * about too.
   */
  const planPrimary = useCallback(() => {
    if (homography == null) return null;
    const { state: prepared, plan } = prepareCommit(stateRef.current, homography);
    const holdCount = countEditorHolds(prepared.holds, 0).on;
    if (holdCount === 0) return null;
    if (plan.overCap) {
      refuseOverCap();
      return null;
    }
    if (plan.unmappableIds.length > 0) {
      // Rare — the homography has to send a hold to infinity — but publishing
      // without them would lose holds the screen is showing as ON.
      hapticWarning();
      setErrorText(t('sprayEditor.errors.someHoldsOffWall', { count: plan.unmappableIds.length }));
      return null;
    }
    return { plan, holdCount };
  }, [homography, refuseOverCap, t]);

  const handlePrimary = useCallback(async () => {
    if (!viewerCanEdit || homography == null || committingRef.current || toolRef.current === 'refine') return;
    // Ask before taking stored holds off a live wall that climbs may use. The
    // press owns the screen while the host asks (`committingRef`), so a second
    // press waits, and a declined check leaves every edit where it was.
    const askAboutRemoval = confirmHoldRemovalRef.current;
    const planned = askAboutRemoval
      ? await confirmPlanRemovals(planPrimary, askAboutRemoval, {
          onAsking: setHandingOver,
          stillHere: () => !unmountedRef.current,
        })
      : planPrimary();
    if (!planned) return;
    const { plan, holdCount } = planned;

    setErrorText(null);
    clearCorners();
    setTool('edit');
    // `prepareCommit` already applied ACCEPT_DEFAULTS to build the plan; this
    // brings React state to the same place. Idempotent, so a repeat is harmless.
    dispatch({ type: 'ACCEPT_DEFAULTS' });
    if (!planHasWork(plan)) {
      // A resumed draft with nothing changed: every hold is already on it.
      celebrateThenHandOver({ written: 0, removed: 0, holdCount });
      return;
    }

    setHandingOver(true);
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
          // Clear the dirty flags NOW rather than waiting for the refetch, so a
          // retry can never re-send holds the server already has.
          dispatch({ type: 'MARK_SAVED', writtenIds: plan.writtenIds });
          awaitingSavedPayloadRef.current = true;
          celebrateThenHandOver({ ...result, holdCount });
        },
        onError: (error: unknown) => {
          setHandingOver(false);
          hapticWarning();
          // Archived since the editor opened: say so in the climber's words and
          // re-read the wall for every other surface that still offers an edit.
          const refusal = sprayWallLifecycleRefusal(error);
          if (sprayWallRefusalMeansStaleWall(refusal)) refreshSprayWall(layoutId);
          setErrorText(
            refusal
              ? sprayWallLifecycleMessage(refusal, t)
              : (extractGraphqlMessage(error) ?? t('sprayEditor.errors.saveFailed')),
          );
        },
      },
    );
  }, [
    viewerCanEdit,
    homography,
    planPrimary,
    saveHolds,
    wallUuid,
    versionNumber,
    versionId,
    celebrateThenHandOver,
    setHandingOver,
    clearCorners,
    layoutId,
    t,
  ]);
  const pressPrimary = useCallback(() => {
    void handlePrimary();
  }, [handlePrimary]);

  /**
   * One rule for the bar, the rail, the Pencil palette and ⌘Z. While refining,
   * Undo and Redo are about strokes: Undo takes back the last one, and there is
   * nothing to redo.
   */
  const canUndo =
    tool === 'refine'
      ? (refineView?.strokeCount ?? 0) > 0
      : state.past.length > 0 || (tool === 'add' && cornerCount > 0);
  const canRedo = tool !== 'refine' && state.future.length > 0;

  // ---- Keyboard shortcuts and the Apple Pencil's own gestures ----
  // `modules/spray-editor-input` reports a shortcut id or a Pencil double tap /
  // squeeze; `spray-editor-shortcuts.ts` decides what it means right now, and
  // the handler is the one the matching button runs. Each reads the latest
  // render through a ref, so the native view's callbacks keep one identity.

  /** What the Cmd-hold overlay lists, in the climber's language. */
  const shortcutCommands = useMemo(
    () =>
      sprayShortcutCommands({
        undo: t('sprayEditor.bar.undo'),
        redo: t('sprayEditor.bar.redo'),
        delete: t('sprayEditor.shortcuts.delete'),
        escape: t('sprayEditor.banner.cancel'),
        add: t('sprayEditor.bar.addA11y'),
        smaller: t('sprayEditor.a11y.actions.smaller'),
        bigger: t('sprayEditor.a11y.actions.bigger'),
        previous: t('sprayEditor.inspector.previous'),
        next: t('sprayEditor.inspector.next'),
        primary: primaryLabel,
      }),
    [t, primaryLabel],
  );

  const shortcutRef = useRef<(id: SprayShortcutId) => void>(() => {});
  shortcutRef.current = (id) => {
    const action = resolveSprayShortcut(id, {
      canEdit,
      tool,
      selectedRole: selectedHold ? holdRole(selectedHold) : null,
      canUndo,
      canRedo,
      canStep: readingOrder.length > 1,
      // The primary button's own enabled rule.
      primaryReady: cornerCount === 0 && tool !== 'refine' && counts.on > 0,
      popoverOpen: pencilPalette != null || menuOpen,
    });
    switch (action) {
      case 'undo':
        handleUndo();
        return;
      case 'redo':
        handleRedo();
        return;
      case 'switchOff':
        handleSwitchSelectedOff();
        return;
      case 'delete':
        handleDelete();
        return;
      case 'closePopover':
        setPencilPalette(null);
        setMenuOpen(false);
        return;
      case 'leaveAdd':
        leaveAddMode();
        return;
      case 'cancelTool':
        handleCancelTool();
        return;
      case 'deselect':
        handlePutDown();
        return;
      case 'toggleAdd':
        handleToggleAddMode();
        return;
      case 'shrink':
        handleShrink();
        return;
      case 'grow':
        handleGrow();
        return;
      case 'previous':
        handleSelectPrevious();
        return;
      case 'next':
        handleSelectNext();
        return;
      case 'primary':
        pressPrimary();
        return;
      case 'none':
        return;
    }
  };
  const handleShortcut = useCallback((id: SprayShortcutId) => shortcutRef.current(id), []);

  const pencilGestureRef = useRef<(gesture: NativePencilGesture) => void>(() => {});
  pencilGestureRef.current = (gesture) => {
    switch (resolvePencilGesture(gesture.preferredAction, { tablet, canEdit, tool })) {
      case 'add':
        setPencilPalette(null);
        handleToggleAddMode();
        return;
      case 'mark':
        setPencilPalette(null);
        handleMarkTool();
        return;
      case 'refineSwitchMode':
        hapticSelection();
        handleRefineModeChange(refineModeRef.current === 'add' ? 'erase' : 'add');
        return;
      case 'palette':
        // A second squeeze puts it away again.
        hapticSelection();
        setPencilPalette((open) => (open ? null : { x: gesture.x ?? null, y: gesture.y ?? null }));
        return;
      case 'none':
        return;
    }
  };
  const handlePencilGesture = useCallback((gesture: NativePencilGesture) => pencilGestureRef.current(gesture), []);

  const closePencilPalette = useCallback(() => setPencilPalette(null), []);
  // The palette's Draw and Corners go straight into Add with that outline shape.
  const addWithShape = useCallback(
    (shape: SprayAddShape) => {
      if (toolRef.current !== 'add') handleToggleAddMode();
      handleAddShapeChange(shape);
    },
    [handleToggleAddMode, handleAddShapeChange],
  );
  const handlePaletteDraw = useCallback(() => addWithShape('draw'), [addWithShape]);
  const handlePaletteCorners = useCallback(() => addWithShape('corners'), [addWithShape]);
  // Gone when the wall locks (a save, the hand-over) or the window drops to the phone layout.
  useEffect(() => {
    if (!tablet || !canEdit) setPencilPalette(null);
  }, [tablet, canEdit]);

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
      announceNextRef.current = true;
      joinHolds(current.selectedId, targetId);
      return;
    }
    if (toolRef.current !== 'edit' || !onWalk(current.selectedId)) return;
    const hold = current.holds[current.selectedId];
    if (!hold) return;
    setErrorText(null);
    announceNextRef.current = true;
    toggleHold(hold);
  }, [toggleHold, joinHolds]);

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
      const geometry = holdFromTap(boardX, boardY, medianRadiusRef.current);
      dispatch({ type: 'ADD_HOLD', geometry });
      dispatch({ type: 'SELECT', id: newId });
      pulseSpotlight('add', geometry);
      recordHint('add');
    },
    [refuseOverCap, toggleHold, pulseSpotlight, recordHint],
  );

  const handleWallAccessibilityAction = useCallback(
    (actionName: string, viewCentreX: number, viewCentreY: number) => {
      // The same lock a finger meets: nothing during the reveal, a save, or the
      // hand-over that follows it.
      if (!canEditRef.current || committingRef.current) return;
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
          handleAccessibilityResize(-1);
          return;
        case WALL_ACTION.grow:
          handleAccessibilityResize(1);
          return;
        case WALL_ACTION.delete:
          announceNextRef.current = true;
          handleDelete();
          return;
        case WALL_ACTION.addHold:
          addHoldAtViewCentre(viewCentreX, viewCentreY);
          return;
        default:
          return;
      }
    },
    [stepWallCursor, activateWallCursor, handleAccessibilityResize, handleDelete, addHoldAtViewCentre],
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
  const selectedRole = selectedHold ? holdRole(selectedHold) : null;
  const canShrinkSelected = shrinkTo != null;
  const canGrowSelected = growTo != null;

  // The named actions mirror the chip bar for the picked ring's role. Switching
  // on and off is the double tap (`activate`), so it needs no action of its own.
  const wallActions = useMemo<readonly AccessibilityActionInfo[]>(() => {
    if (!holdToolsOpen) return WALL_A11Y_ACTIONS;
    const actions: AccessibilityActionInfo[] = [...WALL_A11Y_ACTIONS];
    if (selectedRole === 'on') {
      if (canShrinkSelected) actions.push({ name: WALL_ACTION.shrink, label: t('sprayEditor.a11y.actions.smaller') });
      if (canGrowSelected) actions.push({ name: WALL_ACTION.grow, label: t('sprayEditor.a11y.actions.bigger') });
    } else if (selectedRole === 'off') {
      actions.push({ name: WALL_ACTION.delete, label: t('sprayEditor.a11y.actions.delete') });
    }
    actions.push({ name: WALL_ACTION.addHold, label: t('sprayEditor.a11y.actions.addHold') });
    return actions;
  }, [holdToolsOpen, selectedRole, canShrinkSelected, canGrowSelected, t]);

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

  /** Under the hold cap, so a press and hold on bare wall has something to place. */
  const canAddHold = counts.on < MAX_HOLDS_PER_WALL;

  // The resize handle flips off any diagonal that would put it under the bottom
  // dock (toast, chip bar) or the bar beneath it. The dock is laid out in the
  // screen's container and the handle in the board's, so the board's top in
  // the container is taken off: the board is centred in its slot.
  const boardTopInContainer = (boardRender.slotHeight - boardRender.height) / 2;
  const dockTopRef = useRef<number | null>(null);
  const handleDockLayout = useCallback(
    (event: LayoutChangeEvent) => {
      dockTopRef.current = event.nativeEvent.layout.y;
      avoidTopSV.value = event.nativeEvent.layout.y - boardTopInContainer;
    },
    [avoidTopSV, boardTopInContainer],
  );
  // The iPad has no bottom dock: its chrome floats over the photo, and what
  // sits along the bottom edge is the count and primary cluster. The handle
  // stays above that band instead.
  const tabletClusterTop = area.height - (insets.bottom + SPRAY_BAR_GUTTER + SPRAY_BAR_HEIGHT);
  useEffect(() => {
    if (tablet) {
      avoidTopSV.value = tabletClusterTop - boardTopInContainer;
      return;
    }
    if (dockTopRef.current != null) avoidTopSV.value = dockTopRef.current - boardTopInContainer;
  }, [avoidTopSV, boardTopInContainer, tablet, tabletClusterTop]);
  // What a hovering Pencil would do, on the resting iPad editor only.
  const hoverShown = tablet && tool === 'edit' && canEdit;

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
          {/* The reveal clips this box, never the SVG inside it: the ring layer
              renders once at full size and only the clip's height animates. */}
          <Animated.View
            pointerEvents="none"
            style={[styles.revealClip, { width: boardRender.width }, revealClipStyle]}
          >
            {/* While refining, the rest of the wall steps back so the area reads. */}
            <View
              style={[
                { width: boardRender.width, height: boardRender.height },
                refineView ? styles.refineDimmed : null,
              ]}
            >
              <SprayHoldSvgLayer
                holds={allEditorHolds}
                showMaybes={showMaybes}
                selectedId={ghostedHoldId}
                maybeOpacitySV={maybeRevealSV}
                draftPointsSV={draftPointsSV}
                polygonSV={cornersSV}
                scaleSV={context.scaleSV}
                boardWidth={wall.photoWidth}
                boardHeight={wall.photoHeight}
                renderWidth={boardRender.width}
                renderHeight={boardRender.height}
              />
            </View>
          </Animated.View>
          {revealOnMount && !revealDone && !reduceMotion ? <SprayScanBand style={revealBandStyle} /> : null}
          {celebrating && !reduceMotion ? (
            <SprayPublishSweep
              holds={allEditorHolds}
              scaleSV={context.scaleSV}
              boardWidth={wall.photoWidth}
              boardHeight={wall.photoHeight}
              renderWidth={boardRender.width}
              renderHeight={boardRender.height}
            />
          ) : null}
          {/* Outside the reveal's clip, so held back until the rings are all in. */}
          <SprayHoldSpotlight
            pulse={revealDone ? spotlight : null}
            reduceMotion={reduceMotion}
            scaleSV={context.scaleSV}
            boardScale={boardScale}
          />
          <SelectedHoldOverlay
            hold={focusedHold}
            role={focusedHold ? holdRole(focusedHold) : 'on'}
            revision={moveRevision}
            selectedHoldSV={selectedHoldSV}
            dragOffsetXSV={dragOffsetXSV}
            dragOffsetYSV={dragOffsetYSV}
            dragHoldIdSV={dragHoldIdSV}
            resizeScaleSV={resizeScaleSV}
            resizeHoldIdSV={resizeHoldIdSV}
            scaleSV={context.scaleSV}
            boardScale={boardScale}
          />
          <SprayPlacementPreview
            placeHoldSV={placeHoldSV}
            radius={medianRadius}
            scaleSV={context.scaleSV}
            boardScale={boardScale}
          />
          {hoverShown ? (
            <SprayHoverPreview hoverSV={hoverSV} scaleSV={context.scaleSV} boardScale={boardScale} />
          ) : null}
          {refineView ? (
            <SprayRefineLayer
              outlineBoardPx={refineView.outlineBoardPx}
              pointsSV={refinePointsSV}
              mode={refineMode}
              brushPtSV={refineBrushPtSV}
              strokeZoomSV={refineStrokeZoomSV}
              boardZoomSV={context.scaleSV}
              zoomMirrorSV={refineBoardZoomSV}
              onZoomSettle={setRefineSettledZoom}
              boardPxPerPt={boardScale}
              limits={refineLimits ?? NO_REFINE_LIMITS}
              sizeRingOpacitySV={refineSizeRingSV}
              sizeRingX={refineView.frame.originX}
              sizeRingY={refineView.frame.originY}
              scaleSV={context.scaleSV}
              boardWidth={wall.photoWidth}
              boardHeight={wall.photoHeight}
              renderWidth={boardRender.width}
              renderHeight={boardRender.height}
            />
          ) : null}
        </>
      ) : null,
    [
      wall,
      refineView,
      refinePointsSV,
      refineMode,
      refineBrushPtSV,
      refineStrokeZoomSV,
      refineSizeRingSV,
      refineLimits,
      ghostedHoldId,
      hoverShown,
      hoverSV,
      selectedHold,
      focusedHold,
      medianRadius,
      resizeScaleSV,
      resizeHoldIdSV,
      placeHoldSV,
      allEditorHolds,
      showMaybes,
      maybeRevealSV,
      revealClipStyle,
      revealBandStyle,
      revealOnMount,
      revealDone,
      reduceMotion,
      celebrating,
      spotlight,
      draftPointsSV,
      cornersSV,
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

  // The loupe's copy of the board, in render px: the photo (a memory-cache hit,
  // it is the same URI the board draws), the same dim, and second instances of
  // the layers that draw a gesture's live state from shared values — so the
  // loupe shows the stroke, the Corners preview, the move and the placed
  // circle with no extra wiring. Memoised so the loupe re-renders only when the
  // rings themselves do — or when its zoom crosses a stroke step: the feed's
  // zoom is written at touch-down, so the first touch after a pinch that
  // crossed a step re-renders these layers' widths on the JS thread while the
  // loupe waits out its delay. The hold paths are memoised on the holds, so that
  // render only re-joins strings; it is the price of keeping the loupe's
  // strokes hairlines at every magnification.
  //
  // The ring layer's strokes follow the loupe's magnification, but the Corners
  // dots and close target follow the BOARD's zoom (`geometryScaleSV`): they
  // are geometry, magnified with the photo, so the target covers exactly what
  // `PolygonTapOverlay` will close on.
  const loupeContent = useMemo(
    () =>
      wall && viewerCanEdit ? (
        <>
          <Image
            source={{ uri: wall.photoUrl }}
            style={StyleSheet.absoluteFill}
            contentFit="fill"
            cachePolicy="memory"
          />
          <View
            style={[
              StyleSheet.absoluteFill,
              { backgroundColor: selectedHold ? overlays.photoDimFocused : overlays.photoDim },
            ]}
          />
          <View style={[StyleSheet.absoluteFill, refineView ? styles.refineDimmed : null]}>
            <SprayHoldSvgLayer
              holds={allEditorHolds}
              showMaybes={showMaybes}
              selectedId={ghostedHoldId}
              maybeOpacitySV={maybeRevealSV}
              draftPointsSV={draftPointsSV}
              polygonSV={cornersSV}
              scaleSV={loupeMagnificationSV}
              geometryScaleSV={loupeFeed.zoomSV}
              boardWidth={wall.photoWidth}
              boardHeight={wall.photoHeight}
              renderWidth={boardRender.width}
              renderHeight={boardRender.height}
            />
          </View>
          <SelectedHoldOverlay
            hold={focusedHold}
            role={focusedHold ? holdRole(focusedHold) : 'on'}
            revision={moveRevision}
            selectedHoldSV={selectedHoldSV}
            dragOffsetXSV={dragOffsetXSV}
            dragOffsetYSV={dragOffsetYSV}
            dragHoldIdSV={dragHoldIdSV}
            resizeScaleSV={resizeScaleSV}
            resizeHoldIdSV={resizeHoldIdSV}
            scaleSV={loupeMagnificationSV}
            boardScale={boardScale}
            syncSharedValues={false}
          />
          <SprayPlacementPreview
            placeHoldSV={placeHoldSV}
            radius={medianRadius}
            scaleSV={loupeMagnificationSV}
            boardScale={boardScale}
          />
          {refineView ? (
            <SprayRefineLayer
              outlineBoardPx={refineView.outlineBoardPx}
              pointsSV={refinePointsSV}
              mode={refineMode}
              brushPtSV={refineBrushPtSV}
              strokeZoomSV={refineStrokeZoomSV}
              boardZoomSV={loupeFeed.zoomSV}
              boardPxPerPt={boardScale}
              limits={refineLimits ?? NO_REFINE_LIMITS}
              sizeRingOpacitySV={refineSizeRingSV}
              sizeRingX={refineView.frame.originX}
              sizeRingY={refineView.frame.originY}
              scaleSV={loupeMagnificationSV}
              boardWidth={wall.photoWidth}
              boardHeight={wall.photoHeight}
              renderWidth={boardRender.width}
              renderHeight={boardRender.height}
            />
          ) : null}
        </>
      ) : null,
    [
      wall,
      viewerCanEdit,
      refineView,
      refinePointsSV,
      refineMode,
      refineBrushPtSV,
      refineStrokeZoomSV,
      refineSizeRingSV,
      refineLimits,
      ghostedHoldId,
      loupeFeed.zoomSV,
      selectedHold,
      focusedHold,
      allEditorHolds,
      showMaybes,
      maybeRevealSV,
      draftPointsSV,
      cornersSV,
      loupeMagnificationSV,
      boardRender.width,
      boardRender.height,
      moveRevision,
      selectedHoldSV,
      dragOffsetXSV,
      dragOffsetYSV,
      dragHoldIdSV,
      resizeScaleSV,
      resizeHoldIdSV,
      boardScale,
      placeHoldSV,
      medianRadius,
    ],
  );

  const renderAboveBoard = useCallback(
    (context: FilterBoardTransformContext) => {
      // Read-only: zoom and pan, and nothing that could change the wall.
      if (!viewerCanEdit) return null;
      // On top of whichever surface the tool uses, so its own touch-down beats
      // both that surface and the zoomed board's pan.
      const resizeHandle =
        focusedHold && canEdit && (tool === 'edit' || tool === 'add') ? (
          <SprayResizeHandle
            key={gestureEpoch}
            scaleSV={context.scaleSV}
            translateXSV={context.translateXSV}
            translateYSV={context.translateYSV}
            containerWidthSV={context.containerWidthSV}
            containerHeightSV={context.containerHeightSV}
            isPinchingSV={context.isPinchingSV}
            pinchRef={context.pinchRef}
            boardScale={boardScale}
            holdId={focusedHold.id}
            reachRatio={focusedReachRatio}
            selectedHoldSV={selectedHoldSV}
            dragOffsetXSV={dragOffsetXSV}
            dragOffsetYSV={dragOffsetYSV}
            dragHoldIdSV={dragHoldIdSV}
            resizeScaleSV={resizeScaleSV}
            resizeHoldIdSV={resizeHoldIdSV}
            medianRadius={medianRadius}
            bounds={radiusBounds}
            avoidTopSV={avoidTopSV}
            onResizeEnd={handleResizeEnd}
          />
        ) : null;
      if (tool === 'add' && addShape === 'corners') {
        return (
          <>
            <PolygonTapOverlay
              key={gestureEpoch}
              verticesSV={cornersSV}
              scaleSV={context.scaleSV}
              translateXSV={context.translateXSV}
              translateYSV={context.translateYSV}
              containerWidthSV={context.containerWidthSV}
              containerHeightSV={context.containerHeightSV}
              boardScale={boardScale}
              pinchRef={context.pinchRef}
              maxVertices={POLYGON_MAX_VERTICES}
              onVertexAdded={handleCornerAdded}
              onVertexLimit={handleCornerLimit}
              onClose={closeCorners}
              loupe={loupeFeed}
              stylusOnlySV={tablet ? pencilOnlySV : undefined}
            />
            {resizeHandle}
          </>
        );
      }
      if (tool === 'add') {
        const { scaleSV } = context;
        return (
          <>
            <DrawStrokeOverlay
              key={gestureEpoch}
              pointsSV={draftPointsSV}
              acceptStationaryTaps
              fingerDrawSV={addDrawSV}
              scaleSV={scaleSV}
              translateXSV={context.translateXSV}
              translateYSV={context.translateYSV}
              containerWidthSV={context.containerWidthSV}
              containerHeightSV={context.containerHeightSV}
              boardScale={boardScale}
              pinchRef={context.pinchRef}
              onStrokeStart={handleAddStrokeStart}
              onStrokeEnd={(strokeBoardPoints) => handleAddStrokeEnd(strokeBoardPoints, scaleSV.value)}
              onStrokeCancel={handleStrokeCancel}
              loupe={loupeFeed}
              onStylusSeen={tablet ? handlePencilSeen : undefined}
            />
            {resizeHandle}
          </>
        );
      }
      if (tool === 'refine') {
        const { scaleSV } = context;
        // A dab paints too, so the overlay takes stationary taps. Fingers follow
        // "Pencil only" as Trace's do: with it on they pan and only the Pencil paints.
        return (
          <DrawStrokeOverlay
            key={gestureEpoch}
            pointsSV={refinePointsSV}
            acceptStationaryTaps
            fingerDrawSV={fingerDrawSV}
            scaleSV={scaleSV}
            translateXSV={context.translateXSV}
            translateYSV={context.translateYSV}
            containerWidthSV={context.containerWidthSV}
            containerHeightSV={context.containerHeightSV}
            boardScale={boardScale}
            pinchRef={context.pinchRef}
            onStrokeStart={handleRefineStrokeStart}
            onStrokeEnd={handleRefineStrokeEnd}
            strokeZoomSV={refineStrokeZoomSV}
            onStrokeCancel={IGNORE_STROKE_CANCEL}
            loupe={loupeFeed}
            onStylusSeen={tablet ? handlePencilSeen : undefined}
          />
        );
      }
      if (tool === 'trace') {
        return (
          <DrawStrokeOverlay
            key={gestureEpoch}
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
            loupe={loupeFeed}
          />
        );
      }
      // iPad: the Pencil always marks, through a Pencil-only draw surface nested
      // inside the edit overlay so every touch it declines lands on the overlay.
      // Keyed on the layout too, because the hover and the two-finger tap are
      // fixed at mount. Off that surface (the phone layout: iPad Split View,
      // Slide Over, Android) a stylus press and hold places like a finger.
      const pencilSurfaceShown = tablet && tool === 'edit' && canEdit;
      return (
        <>
          <SprayEditGestureOverlay
            key={`${gestureEpoch}-${layout}`}
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
            canAdd={canAddHold && !(tablet && pencil.pencilOnly)}
            medianRadiusSV={medianRadiusSV}
            placeHoldSV={placeHoldSV}
            loupe={loupeFeed}
            accessibility={wallAccessibility}
            onTap={handleTap}
            onPickUp={handlePickUp}
            onMoveEnd={handleMoveEnd}
            onPlaceStart={handlePlaceStart}
            onPlace={handlePlace}
            hoverSV={tablet ? hoverSV : undefined}
            hoverRadiusSV={tablet ? medianRadiusSV : undefined}
            onStylusSeen={tablet ? handlePencilSeen : undefined}
            onTwoFingerTap={tablet ? handleTwoFingerUndo : undefined}
            stylusAddsElsewhere={pencilSurfaceShown}
          >
            {pencilSurfaceShown ? (
              <SprayPencilSurface
                pointsSV={draftPointsSV}
                selectedHoldSV={selectedHoldSV}
                hitHoldsSV={hitHoldsSV}
                scaleSV={context.scaleSV}
                translateXSV={context.translateXSV}
                translateYSV={context.translateYSV}
                containerWidthSV={context.containerWidthSV}
                containerHeightSV={context.containerHeightSV}
                boardScale={boardScale}
                pinchRef={context.pinchRef}
                onStrokeStart={handleStrokeStart}
                onStrokeEnd={(strokeBoardPoints) => handlePencilStroke(strokeBoardPoints, context.scaleSV.value)}
                onStrokeCancel={handleStrokeCancel}
                onStylusSeen={handlePencilSeen}
              />
            ) : null}
          </SprayEditGestureOverlay>
          {resizeHandle}
        </>
      );
    },
    [
      viewerCanEdit,
      gestureEpoch,
      tool,
      addShape,
      canEdit,
      canAddHold,
      focusedHold,
      focusedReachRatio,
      medianRadius,
      radiusBounds,
      resizeScaleSV,
      resizeHoldIdSV,
      avoidTopSV,
      medianRadiusSV,
      placeHoldSV,
      loupeFeed,
      handleResizeEnd,
      handlePlaceStart,
      handlePlace,
      handleAddStrokeStart,
      draftPointsSV,
      cornersSV,
      addDrawSV,
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
      handleAddStrokeEnd,
      refinePointsSV,
      handleRefineStrokeStart,
      handleRefineStrokeEnd,
      handleCornerAdded,
      handleCornerLimit,
      closeCorners,
      handleTap,
      handlePickUp,
      handleMoveEnd,
      tablet,
      layout,
      pencilOnlySV,
      pencil.pencilOnly,
      hoverSV,
      handlePencilSeen,
      handlePencilStroke,
      handleTwoFingerUndo,
    ],
  );

  const wallIsEmpty = counts.on + counts.maybes + counts.off === 0;
  const addShapeOptions = useMemo(
    () => [
      { key: 'draw' as const, label: t('sprayEditor.addShape.draw') },
      { key: 'corners' as const, label: t('sprayEditor.addShape.corners') },
    ],
    [t],
  );
  const banner = bannerFor({
    tool,
    addShape,
    refineMode,
    refineNotice,
    pencilOnly: pencil.pencilOnly,
    errorText,
    viewerCanEdit,
    notice: wallIsEmpty ? notice : undefined,
    onCancel: handleCancelTool,
    onDone: leaveAddMode,
    t,
  });
  const refineModeOptions = useMemo(
    () => [
      { key: 'add' as const, label: t('sprayEditor.refine.add') },
      { key: 'erase' as const, label: t('sprayEditor.refine.erase') },
    ],
    [t],
  );
  const bannerAccessory =
    tool === 'add' ? (
      <SegmentedControl
        options={addShapeOptions}
        selectedKey={addShape}
        onSelect={handleAddShapeChange}
        accessibilityLabel={t('sprayEditor.addShape.label')}
      />
    ) : tool === 'refine' ? (
      <SegmentedControl
        options={refineModeOptions}
        selectedKey={refineMode}
        onSelect={handleRefineModeChange}
        accessibilityLabel={t('sprayEditor.refine.mode')}
      />
    ) : null;
  const boardShowing = !isLoading && wall != null && !isUnavailable && homography != null;
  // A hint only when nothing more urgent is on the line, the rings have finished
  // arriving, and the climber is free to act on it.
  const hint = boardShowing && hints.hint && revealDone && !banner && tool === 'edit' && canEdit ? hints.hint : null;
  const hintLine = hint ? hintText(hint, t) : null;

  // A tip slides in without taking focus, so a screen reader would never hear
  // it. Said once each time a different one appears.
  useEffect(() => {
    if (hintLine) AccessibilityInfo.announceForAccessibility(hintLine);
  }, [hintLine]);

  const refineBarNode =
    tool === 'refine' && canEdit ? (
      <SprayRefineBar
        brushPt={refineBrushPt}
        range={refineBrushRange}
        brushPtSV={refineBrushPtSV}
        boardZoomSV={refineBoardZoomSV}
        boardPxPerPt={boardScale}
        limits={refineLimits ?? NO_REFINE_LIMITS}
        onBrushPtLive={handleRefineBrushLive}
        onBrushPtCommit={handleRefineBrushCommit}
        onBrushPtCancel={handleRefineBrushCancel}
        onDone={handleRefineDone}
      />
    ) : null;
  const undoToastNode =
    undoToast && canEdit ? (
      <SprayUndoToast
        message={undoToast.message}
        nonce={undoToast.nonce}
        onUndo={undoWallEdit}
        onDismiss={dismissUndoToast}
      />
    ) : null;
  const cornersFinishNode =
    tool === 'add' && addShape === 'corners' && cornerCount >= MIN_CORNERS && canEdit ? (
      <SprayCornersChipBar onFinish={takeAndCloseCorners} />
    ) : null;
  // iPad: the reset-zoom control goes to the top corner away from the rail, and
  // the banner and hints keep a readable column in the middle.
  const resetZoomStyle =
    tablet && sprayTabletPlacement({ railSide, landscape }).oppositeEdge === 'right'
      ? RESET_ZOOM_STYLE_RIGHT
      : RESET_ZOOM_STYLE;
  // In landscape the inspector shares the top edge, so the column also keeps
  // clear of its width on both sides.
  const bannerSideInset = tablet
    ? Math.max(
        spacing[4],
        (area.width - SPRAY_TABLET_CONTENT_MAX_WIDTH) / 2,
        landscape ? SPRAY_RAIL_MARGIN + SPRAY_INSPECTOR_WIDTH + spacing[2] : 0,
      )
    : spacing[4];
  const bannerInsets = { left: bannerSideInset, right: bannerSideInset };

  // A read that stalled is said in the screen: this route is a modal, and the
  // toast and banner overlays draw behind it. Checked ahead of "unavailable",
  // which would call a dropped connection a wall with no photo.
  if (isLoading || isStalled) {
    return <SprayEditorLoading photo={loadingPhoto ?? null} stalled={isStalled} onRetry={retry} />;
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

  // The editor's root is the keyboard and Pencil scope itself: the native view
  // has to be an ancestor of every view a touch lands on (see
  // `SprayEditorKeyScope`). Read-only, it registers no shortcut.
  return (
    <SprayEditorKeyScope
      style={[styles.container, { backgroundColor: systemColors.background, marginTop: headerInset }]}
      onLayout={handleAreaLayout}
      commands={viewerCanEdit ? shortcutCommands : NO_SHORTCUT_COMMANDS}
      onShortcut={handleShortcut}
      onPencilGesture={handlePencilGesture}
    >
      {boardRender.width > 0 ? (
        <View style={[styles.boardSlot, { height: boardRender.slotHeight }]}>
          <InteractiveFilterBoard
            backgroundPhotoUrl={wall.photoUrl}
            fullResolutionPhoto={fullResolutionPhoto}
            onFullResolutionPhotoError={handleFullPhotoError}
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
            resetZoomStyle={resetZoomStyle}
            controlRef={boardControlRef}
            maxScale={SPRAY_EDITOR_MAX_SCALE}
            pinchPans
          />
        </View>
      ) : null}

      {banner ? (
        <View pointerEvents="box-none" style={[styles.bannerSlot, bannerInsets]}>
          <SprayEditorBanner {...banner} accessory={bannerAccessory} />
        </View>
      ) : null}

      {hint && hintLine ? (
        <View pointerEvents="box-none" style={[styles.bannerSlot, bannerInsets]}>
          <OnboardingTipBanner
            solid
            text={hintLine}
            dismissLabel={t('sprayEditor.hints.dismiss')}
            onDismiss={() => hints.dismiss(hint)}
          />
        </View>
      ) : null}

      {tablet ? (
        <SprayTabletChrome
          railSide={railSide}
          landscape={landscape}
          insets={insets}
          rail={
            <SprayToolRail
              side={railSide}
              onSideChange={setRailSide}
              windowWidth={area.width}
              leftInset={insets.left}
              rightInset={insets.right}
              locked={!canEdit}
              canUndo={canUndo}
              canRedo={canRedo}
              onUndo={handleUndo}
              onRedo={handleRedo}
              adding={tool === 'add'}
              onMark={handleMarkTool}
              onAdd={handleToggleAddMode}
              maybeControls={capabilities.canReviewCandidates && counts.maybes > 0}
              showMaybes={showMaybes}
              onToggleMaybes={handleToggleMaybes}
              onKeepMaybes={handleKeepMaybes}
              pencilToggleAvailable={pencil.toggleAvailable}
              pencilOnly={pencil.pencilOnly}
              onTogglePencilOnly={pencil.togglePencilOnly}
              onFit={handleFitWall}
              onMore={toggleMenu}
              moreExpanded={menuOpen && canEdit}
              onHelp={viewerCanEdit && !SCREENSHOT_MODE ? hints.replay : undefined}
            />
          }
          menu={
            menuOpen && canEdit ? (
              <SprayEditorMenu
                counts={counts}
                showMaybes={showMaybes}
                canReviewMaybes={capabilities.canReviewCandidates}
                includeMaybeRows={false}
                onKeepMaybes={handleKeepMaybes}
                onToggleMaybes={handleToggleMaybes}
                onStartOver={handleStartOver}
                onClose={closeMenu}
              />
            ) : null
          }
          inspector={
            selectedHold && selectedRole && tool === 'edit' && canEdit ? (
              <SprayHoldInspector
                role={selectedRole}
                source={selectedHold.source}
                confidence={selectedHold.confidence}
                canShrink={shrinkTo != null}
                canGrow={growTo != null}
                onShrink={handleShrink}
                onGrow={handleGrow}
                onTrace={handleStartTrace}
                onRefine={handleStartRefine}
                onJoin={handleStartJoin}
                onSwitchOff={handleSwitchSelectedOff}
                onSwitchOn={handleSwitchSelectedOn}
                onDelete={handleDelete}
                canStep={readingOrder.length > 1}
                onPrevious={handleSelectPrevious}
                onNext={handleSelectNext}
                onClose={handlePutDown}
              />
            ) : null
          }
          dock={
            <>
              {undoToastNode}
              {cornersFinishNode}
              {refineBarNode}
            </>
          }
          counts={counts}
          showMaybes={showMaybes}
          celebrating={celebrating}
          locked={!canEdit}
          primaryLabel={primaryLabel}
          primaryLoading={committing}
          primaryDisabled={!canEdit || cornerCount > 0 || tool === 'refine' || counts.on === 0}
          onPrimary={pressPrimary}
        />
      ) : (
        <>
          {viewerCanEdit && !SCREENSHOT_MODE ? (
            <View style={styles.helpSlot}>
              <GlassIconButton
                iconName="help"
                iconColor={systemColors.label}
                fallbackColor={systemColors.fill}
                size={glassSize.capsule}
                onPress={hints.replay}
                disabled={!canEdit}
                accessibilityLabel={t('sprayEditor.hints.replay')}
              />
            </View>
          ) : null}

          {/* One column docked just above the bottom bar: the undo toast on top,
              the chip bar for the picked hold (or Corners' Finish) under it, so the
              two stack instead of overlapping however many rows the chips wrap to. */}
          <View
            pointerEvents="box-none"
            onLayout={handleDockLayout}
            style={[styles.dock, { bottom: insets.bottom + SPRAY_BAR_GUTTER * 2 + SPRAY_BAR_TOTAL_HEIGHT }]}
          >
            {undoToastNode}

            {selectedHold && selectedRole && tool === 'edit' && canEdit ? (
              <SprayHoldChipBar
                role={selectedRole}
                canShrink={shrinkTo != null}
                canGrow={growTo != null}
                onShrink={handleShrink}
                onGrow={handleGrow}
                onTrace={handleStartTrace}
                onRefine={handleStartRefine}
                onJoin={handleStartJoin}
                onSwitchOff={handleSwitchSelectedOff}
                onSwitchOn={handleSwitchSelectedOn}
                onDelete={handleDelete}
              />
            ) : null}

            {cornersFinishNode}
            {refineBarNode}
          </View>

          <SprayEditorBottomBar
            counts={counts}
            showMaybes={showMaybes}
            canReviewMaybes={capabilities.canReviewCandidates}
            canUndo={canUndo}
            canRedo={canRedo}
            adding={tool === 'add'}
            primaryBlocked={cornerCount > 0 || tool === 'refine'}
            locked={!canEdit}
            primaryLabel={primaryLabel}
            primaryLoading={committing}
            celebrating={celebrating}
            bottomInset={insets.bottom}
            onUndo={handleUndo}
            onRedo={handleRedo}
            onAdd={handleToggleAddMode}
            onKeepMaybes={handleKeepMaybes}
            onToggleMaybes={handleToggleMaybes}
            onStartOver={handleStartOver}
            onPrimary={pressPrimary}
            menuOpen={menuOpen}
            onToggleMenu={toggleMenu}
            onCloseMenu={closeMenu}
          />
        </>
      )}

      {pencilPalette && tablet && canEdit ? (
        <SprayPencilPalette
          centre={pencilPaletteCentre({
            x: pencilPalette.x,
            y: pencilPalette.y,
            areaWidth: area.width,
            areaHeight: area.height,
          })}
          tool={tool}
          addShape={addShape}
          canUndo={canUndo}
          canRedo={canRedo}
          onMark={handleMarkTool}
          onDraw={handlePaletteDraw}
          onCorners={handlePaletteCorners}
          onUndo={handleUndo}
          onRedo={handleRedo}
          onClose={closePencilPalette}
        />
      ) : null}

      {/* Last, so it draws over the chrome as well as the board: it is only up
          while a finger is on the wall, and it takes no touches. */}
      {loupeContent && boardRender.width > 0 ? (
        <SprayLoupe
          feed={loupeFeed}
          magnificationSV={loupeMagnificationSV}
          clipOffsetX={(area.width - boardRender.width) / 2}
          clipOffsetY={boardTopInContainer}
          hostWidth={area.width}
          hostHeight={area.height}
          topSafe={LOUPE_TOP_SAFE}
          renderWidth={boardRender.width}
          renderHeight={boardRender.height}
        >
          {loupeContent}
        </SprayLoupe>
      ) : null}
    </SprayEditorKeyScope>
  );
}

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** The named screen-reader actions on the wall, mirroring the chip bar. */
const WALL_ACTION = {
  shrink: 'shrink',
  grow: 'grow',
  delete: 'delete',
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
  addShape,
  refineMode,
  refineNotice,
  pencilOnly,
  errorText,
  viewerCanEdit,
  notice,
  onCancel,
  onDone,
  t,
}: {
  tool: SprayEditorTool;
  addShape: SprayAddShape;
  refineMode: RefineMode;
  /** Refine's line about the last stroke that is not an error. */
  refineNotice: string | null;
  /** iPad "Pencil only": Trace and Refine draw with the Pencil, so the line says so. */
  pencilOnly: boolean;
  errorText: string | null;
  viewerCanEdit: boolean;
  notice: SprayEditorNotice | undefined;
  onCancel: () => void;
  onDone: () => void;
  t: Translate;
}): { message: string; actionLabel?: string; onAction?: () => void; tone?: 'info' | 'error' } | null {
  if (tool === 'add') {
    const done = t('sprayEditor.banner.done');
    if (errorText) return { message: errorText, actionLabel: done, onAction: onDone, tone: 'error' };
    const message = addShape === 'corners' ? t('sprayEditor.banner.addCorners') : t('sprayEditor.banner.addDraw');
    return { message, actionLabel: done, onAction: onDone };
  }
  if (tool === 'trace') {
    const message = pencilOnly ? t('sprayEditor.banner.tracePencil') : t('sprayEditor.banner.trace');
    return errorText
      ? { message: errorText, actionLabel: t('sprayEditor.banner.cancel'), onAction: onCancel, tone: 'error' }
      : { message, actionLabel: t('sprayEditor.banner.cancel'), onAction: onCancel };
  }
  if (tool === 'join') {
    return { message: t('sprayEditor.banner.join'), actionLabel: t('sprayEditor.banner.cancel'), onAction: onCancel };
  }
  if (tool === 'refine') {
    const cancel = t('sprayEditor.banner.cancel');
    if (errorText) return { message: errorText, actionLabel: cancel, onAction: onCancel, tone: 'error' };
    if (refineNotice) return { message: refineNotice, actionLabel: cancel, onAction: onCancel };
    return { message: refineBannerMessage(refineMode, pencilOnly, t), actionLabel: cancel, onAction: onCancel };
  }
  if (errorText) return { message: errorText, tone: 'error' };
  if (!viewerCanEdit) return { message: t('sprayEditor.readOnly') };
  if (notice) return notice;
  return null;
}

function hintText(id: SprayHintId, t: Translate): string {
  if (id === 'maybe') return t('sprayEditor.hints.maybe');
  if (id === 'longPress') return t('sprayEditor.hints.longPress');
  if (id === 'addHold') return t('sprayEditor.hints.addHold');
  if (id === 'pencil') return t('sprayEditor.hints.pencil');
  return t('sprayEditor.hints.tap');
}

/** Why a Corners outline would not close. Worded for tapped corners, not a drawn loop. */
function cornersRejectionMessage(reason: StrokeRejection, t: Translate): string {
  if (reason === 'self-overlap') return t('sprayEditor.errors.cornersCross');
  if (reason === 'centre-outside') return t('sprayEditor.errors.cornersHollow');
  if (reason === 'too-few-points') return t('sprayEditor.errors.cornersTooFew');
  return rejectionMessage(reason, t);
}

/** What Refine's brush does, as the banner says it. Literal keys, so the catalogue checks can see them. */
function refineBannerMessage(mode: RefineMode, pencilOnly: boolean, t: Translate): string {
  if (mode === 'add') {
    return pencilOnly ? t('sprayEditor.banner.refineAddPencil') : t('sprayEditor.banner.refineAdd');
  }
  return pencilOnly ? t('sprayEditor.banner.refineErasePencil') : t('sprayEditor.banner.refineErase');
}

/** Why a Refine stroke (or Done) was refused. Worded for a brush, not a drawn loop. */
function refineRejectionMessage(reason: RefineRejection, t: Translate): string {
  if (reason === 'nothing-left' || reason === 'too-few-points') return t('sprayEditor.errors.refineNothingLeft');
  if (reason === 'too-complex' || reason === 'self-intersecting' || reason === 'self-overlap') {
    return t('sprayEditor.errors.refineTooDetailed');
  }
  return t('sprayEditor.errors.refineCantStore');
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
  // Below the top-left reset-zoom control and the top-right "?", so none of
  // them overlap.
  bannerSlot: {
    position: 'absolute',
    top: spacing[2] * 2 + glassSize.capsule,
  },
  helpSlot: {
    position: 'absolute',
    top: spacing[2],
    right: spacing[2],
  },
  dock: {
    position: 'absolute',
    left: spacing[4],
    right: spacing[4],
    alignItems: 'center',
    gap: spacing[2],
  },
  // The ring layer while a hold is refined: still there for context, but behind the area.
  refineDimmed: {
    opacity: 0.35,
  },
  revealClip: {
    position: 'absolute',
    left: 0,
    top: 0,
    overflow: 'hidden',
  },
});
