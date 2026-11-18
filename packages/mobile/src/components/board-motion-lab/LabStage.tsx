/**
 * The lab's stage: the player's own board carousel (real swipe, real trio and
 * carry-over, real native view over the bundled board photo) walking a ring of
 * fixture climbs, with the variant's transition and the scripted finger. Owns
 * no controls; see LabStageProps.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { NativeMotionClimbOverlayGPU } from '../../../modules/climb-overlay-gpu/src';
import type { ClimbOverlayGPUReady } from '../../../modules/climb-overlay-gpu/src';
import type { BoardRenderDiagnostics, BoardTransition } from '../play-drawer/board-transition';
import { SWAP_LOOK_NATIVE_VERSION, type SwapLookStatus } from '../play-drawer/swap-look';
import { SwipeBoardCarousel } from '../play-drawer/SwipeBoardCarousel';
import { usePlayerGpuBoard } from '../play-drawer/use-player-gpu-board';
import { useSwipeNavigation, useSwipePager, useSwipePages } from '../play-drawer/use-swipe-pager';
import { getBoardRenderData } from '../../lib/board-details';
import {
  climbOverlayGpuApiVersion,
  climbOverlaySwapLookProbe,
  climbOverlaySwapLookVersion,
} from '../../lib/board-render/gpu-native-capability';
import { AURA_GPU_FAMILIES, AURA_GPU_FLAG } from '../../lib/board-render/gpu-rollout';
import { FeatureFlagsProvider, useGpuClimbOverlayEnabled } from '../../providers/feature-flags-provider';
import { useSetting } from '../../settings/hooks';
import { swapLookProbeText } from './controls/status-text';
import { stageStatus } from './stage-status';
import type { LabClimb, LabLookStatus, LabStageProps } from './types';
import { useVirtualFinger } from './use-virtual-finger';

/**
 * The GPU board on for every family, so a local Release build with no PostHog
 * key draws GPU on every board. A remote kill switch, or the climber's own
 * GPU acceleration setting, still turns it off.
 */
const LAB_FLAGS = { [AURA_GPU_FLAG]: true };
const LAB_PAYLOADS = {
  [AURA_GPU_FLAG]: { version: 1, enabledFamilies: [...AURA_GPU_FAMILIES], disabledFamilies: [] },
};

export function LabStage(props: LabStageProps) {
  return (
    <FeatureFlagsProvider flags={LAB_FLAGS} payloads={LAB_PAYLOADS}>
      <LabBoardStage {...props} />
    </FeatureFlagsProvider>
  );
}

/** The climb at `position` on the ring: the fixture list repeats both ways, so the swipe never ends. */
function climbAt(climbs: readonly LabClimb[], position: number): LabClimb {
  const count = climbs.length;
  return climbs[((position % count) + count) % count];
}

/** A presentation's timings, or a failure's reason, and the carousel and board they came from. */
type GpuTimings = { renderKey: string; prepareMs: number; uploadMs: number };
type GpuError = { renderKey: string; reason: string };
type LookReport = { renderKey: string; status: SwapLookStatus };

function LabBoardStage({
  board,
  climbs,
  variant,
  params,
  slowdown,
  reduceMotion,
  script,
  onScriptDone,
  onStatus,
  onClimbChange,
  resetKey,
}: LabStageProps) {
  const { pager, stepSignal } = useSwipePager();
  // An unbounded ring position. Pages are named by position, never by climb, so
  // a neighbour that becomes current keeps its page, and a short list (or one
  // climb) can still be swiped through, as the player's queue is.
  //
  // A new `resetKey`, climb set or board puts the ring back on its first climb,
  // so every Play-all segment starts on the same climbs. The epoch renames every
  // page, so the pager takes it as a jump elsewhere, never as a swipe.
  const [ring, setRing] = useState({ epoch: 0, position: 0, resetKey, climbs, board });
  if (ring.resetKey !== resetKey || ring.climbs !== climbs || ring.board !== board) {
    setRing({ epoch: ring.epoch + 1, position: 0, resetKey, climbs, board });
  }
  const { epoch, position } = ring;
  const goNext = useCallback(() => setRing((current) => ({ ...current, position: current.position + 1 })), []);
  const goPrevious = useCallback(() => setRing((current) => ({ ...current, position: current.position - 1 })), []);
  useSwipeNavigation(pager, goNext, goPrevious);
  const centerPage = useSwipePages(
    pager,
    stepSignal,
    `${epoch}:${position - 1}`,
    `${epoch}:${position}`,
    `${epoch}:${position + 1}`,
  );

  const hasClimbs = climbs.length > 0;
  const current = hasClimbs ? climbAt(climbs, position) : null;
  const previous = hasClimbs ? climbAt(climbs, position - 1) : null;
  const next = hasClimbs ? climbAt(climbs, position + 1) : null;
  // What the player warms a few swipes ahead; the GPU board prepares two of them.
  const prefetchFrames = useMemo(
    () => (hasClimbs ? [2, 3, -2].map((ahead) => climbAt(climbs, position + ahead).frames) : []),
    [climbs, hasClimbs, position],
  );
  const climbCount = climbs.length;
  useEffect(() => {
    if (climbCount > 0) onClimbChange?.(((position % climbCount) + climbCount) % climbCount);
  }, [position, climbCount, onClimbChange]);

  const boardRenderData = useMemo(
    () =>
      getBoardRenderData({
        boardName: board.boardName,
        layoutId: board.layoutId,
        sizeId: board.sizeId,
        setIds: board.setIds.split(',').map(Number),
      }),
    [board],
  );

  const transition = useMemo<BoardTransition>(
    () => ({
      ...variant.createTransition(params),
      slowdown,
      ...(reduceMotion === 'system' ? null : { reduceMotion: reduceMotion === 'on' }),
    }),
    [variant, params, slowdown, reduceMotion],
  );
  // A new transition is a new carousel: the swap's reaction and clocks are set up once.
  const carouselKey = JSON.stringify([variant.id, params, slowdown, reduceMotion]);

  // --- What the status line says --------------------------------------------
  // Timings and failures count only for the carousel and board they came from:
  // after a remount the status is loading until the new board presents.
  const renderKey = JSON.stringify([carouselKey, board.id]);
  const [renderPath, setRenderPath] = useState<'gpu' | 'png' | null>(null);
  const [timings, setTimings] = useState<GpuTimings | null>(null);
  const [gpuError, setGpuError] = useState<GpuError | null>(null);
  const [lookReport, setLookReport] = useState<LookReport | null>(null);
  const diagnostics = useMemo<BoardRenderDiagnostics>(
    () => ({
      onRenderPath: setRenderPath,
      onGpuReady: (ready: ClimbOverlayGPUReady) => {
        setTimings((before) =>
          before?.renderKey === renderKey && before.prepareMs === ready.prepareMs && before.uploadMs === ready.uploadMs
            ? before
            : { renderKey, prepareMs: ready.prepareMs, uploadMs: ready.uploadMs },
        );
        setGpuError(null);
      },
      onGpuError: (reason: string) => setGpuError({ renderKey, reason }),
      onSwapLook: (status: SwapLookStatus) => setLookReport({ renderKey, status }),
    }),
    [renderKey],
  );
  // Look variants only: what the native view last said about the look on this carousel.
  const hasLook = transition.look !== undefined && transition.revealMode === 'swap';
  const currentLook = lookReport?.renderKey === renderKey ? lookReport.status : null;
  const look = useMemo<LabLookStatus | undefined>(() => {
    if (climbOverlaySwapLookVersion < SWAP_LOOK_NATIVE_VERSION) {
      // Android, where the probe turned the look off: say why on every variant,
      // since the look variants are greyed out and cannot be picked to ask.
      if (climbOverlaySwapLookProbe && swapLookProbeText(climbOverlaySwapLookProbe) !== null) {
        return { state: 'unsupported', swapLookVersion: climbOverlaySwapLookVersion, probe: climbOverlaySwapLookProbe };
      }
      return hasLook ? { state: 'unsupported', swapLookVersion: climbOverlaySwapLookVersion } : undefined;
    }
    if (!hasLook) return undefined;
    return currentLook ?? { state: 'waiting' };
  }, [hasLook, currentLook]);
  const currentTimings = timings?.renderKey === renderKey ? timings : null;
  const currentError = gpuError?.renderKey === renderKey ? gpuError.reason : null;
  const [gpuSettingOn] = useSetting('gpuAcceleration');
  const gpuAllowed = useGpuClimbOverlayEnabled(board.boardName, board.layoutId);
  const gpuBoard = usePlayerGpuBoard(board.boardName, board.layoutId);
  const hasRenderData = boardRenderData !== null;
  const status = useMemo(
    () =>
      stageStatus({
        hasRenderData,
        hasClimbs,
        apiVersion: climbOverlayGpuApiVersion,
        hasMotionView: NativeMotionClimbOverlayGPU !== null,
        gpuSettingOn,
        gpuAllowed,
        gpuBoard,
        renderPath,
        timings: currentTimings,
        gpuError: currentError,
        look,
      }),
    [hasRenderData, hasClimbs, gpuSettingOn, gpuAllowed, gpuBoard, renderPath, currentTimings, currentError, look],
  );
  // Sent again for every new carousel or board, unchanged or not: the screen
  // shows "Loading…" when it switches variant and waits for this.
  useEffect(() => {
    onStatus(status);
  }, [status, renderKey, onStatus]);
  // Once per change of path or reason, never per frame or per swipe.
  const pathSummary = status.path === 'png' ? `png: ${status.reason}` : status.path;
  useEffect(() => {
    if (!__DEV__) return;
    console.info('[motion-lab] stage', JSON.stringify({ variant: variant.id, board: board.id, path: pathSummary }));
  }, [pathSummary, variant.id, board.id]);

  // --- The scripted finger ----------------------------------------------------
  // A zoomed board refuses the finger (`useCarouselGesture`), so each run starts
  // on the whole board. Declared before the finger's own effects, so the zoom is
  // reset before the run starts.
  const hasCarousel = hasRenderData && hasClimbs;
  const resetZoomRef = useRef<(() => void) | null>(null);
  const handleResetZoomReady = useCallback((resetZoom: () => void) => {
    resetZoomRef.current = resetZoom;
  }, []);
  const scriptRunId = script?.runId ?? null;
  useEffect(() => {
    if (scriptRunId !== null && hasCarousel) resetZoomRef.current?.();
  }, [scriptRunId, hasCarousel]);
  // Above the keyed carousel, so a remount never replays a run. With no
  // carousel a run is reported done at once: no finger will ever come.
  const onVirtualFinger = useVirtualFinger(script, { slowdown, hasCarousel, onDone: onScriptDone });

  if (!boardRenderData || !current || !previous || !next) return <View style={styles.root} />;
  return (
    // A real touch would fight the scripted finger: the board takes none while a script plays.
    <View style={styles.root} pointerEvents={script ? 'none' : 'auto'}>
      <SwipeBoardCarousel
        key={carouselKey}
        boardName={board.boardName}
        boardRenderData={boardRenderData}
        layoutId={board.layoutId}
        sizeId={board.sizeId}
        setIds={board.setIds}
        currentFrames={current.frames}
        nextFrames={next.frames}
        prevFrames={previous.frames}
        prefetchFrames={prefetchFrames}
        pager={pager}
        centerPage={centerPage}
        mirrored={false}
        canSwipeNext
        canSwipePrevious
        onSwipeNext={goNext}
        onSwipePrevious={goPrevious}
        transition={transition}
        onVirtualFinger={onVirtualFinger}
        onResetZoomReady={handleResetZoomReady}
        diagnostics={diagnostics}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});
