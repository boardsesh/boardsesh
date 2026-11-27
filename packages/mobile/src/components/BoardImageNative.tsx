import { climbOverlayGpuApiVersion, type ClimbOverlayGPUFailureScope } from '../lib/board-render/gpu-native-capability';
import type { BoardRenderStyle } from '../lib/board-render-style';
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { View, type ViewStyle } from 'react-native';
import { NativeFrameClimbOverlayGPU, NativeMotionClimbOverlayGPU } from '../../modules/climb-overlay-gpu/src';
import {
  recordGpuConfigFailure,
  recordGpuPresentationTimeout,
  recordGpuPresented,
} from '../lib/board-render/gpu-failure-store';
import { reportGpuFirstHolds, type GpuFallbackReason } from '../lib/board-render/gpu-telemetry';
import { markGpuConfigWarm } from '../lib/board-render/gpu-warm-configs';
import { useIsAppBackgrounded } from '../lib/app-visibility';
import { useBoardArtVisible } from './board-art-visibility-context';
import { useGpuClimbOverlayEnabled } from '../providers/feature-flags-provider';
import { GpuClimbOverlay, type GpuClimbTransition } from './GpuClimbOverlay';
import { isMoonboardBoardName } from '@boardsesh/board-config';
import { supportsAuraGpu } from '@boardsesh/board-look';
import type { BoardName } from '@boardsesh/shared-schema';
import { toFlatFrames } from '@boardsesh/board-constants/hold-states';
import { useNativeClimbRender } from '../hooks/use-native-climb-render';
import type { BackgroundVariant } from '../lib/background-image-cache';
import type { BoardRenderSettings } from '../lib/board-render-settings';
import type { HoldColorOverrides } from '../lib/hold-color-overrides';
import { LayeredClimbImage } from './LayeredClimbImage';
import { MoonBoardGridLabels } from './board/MoonBoardGridLabels';
import { useBoardAccessibilitySummary } from '../hooks/use-board-accessibility-summary';
import { overlayRetainIdentity } from '../lib/overlay-retain-identity';
import { isBoardArtInMemory } from '../lib/board-render/warm-board-art-memory';
import { getCredentialGeneration, subscribeToCredentialChanges } from '../lib/privacy/privacy-cache';
import {
  isReadyBoardArtCurrent,
  type ReadyBoardArtIdentity,
  type ReadyBoardArtSnapshot,
  type BoardArtReadiness,
} from '../lib/board-render/ready-board-art';

type BoardImageNativeProps = {
  readyBoardArt?: ReadyBoardArtSnapshot;
  onReadyArtDisplayed?: (art: ReadyBoardArtIdentity & { overlayUri: string; overlayLoadKey: string | null }) => void;
  onArtReadinessChange?: (readiness: BoardArtReadiness) => void;
  accessible?: boolean;
  frames: string;
  boardName: BoardName;
  layoutId: number;
  sizeId: number;
  setIds: string;
  boardWidth: number;
  boardHeight: number;
  mirrored?: boolean;
  /**
   * Render lit holds as filled dots (filled style) instead of the default
   * stroke-only outlines. The full-size play view leaves this false — thin
   * strokes stay legible when large — but small surfaces like the 40×40
   * accessory thumbnail pass true so holds read as solid dots once scaled
   * down. Threaded into the render cache key, so the two styles cache as
   * separate PNGs (see useNativeClimbRender).
   */
  filledStyle?: boolean;
  /**
   * This is THE board the climber is looking at — the play drawer's current
   * card. Sets `surface: 'play'` on render-failure telemetry and turns on the
   * overlay paint watchdog. Every other call site (preview cards and rails, the
   * preview sheet, the wall kiosk hero, the carousel's
   * off-screen peek) leaves it off: pooling those into one rate would describe
   * nothing anybody experienced.
   */
  playSurface?: boolean;
  /** Explicit interactive editor surface; thumbnails and previews never opt in. */
  editorSurface?: boolean;
  /** Stationary board: the neighboring hold sets blend while the photo stays still. */
  gpuTransition?: GpuClimbTransition;
  /**
   * The bare wall: pass empty `frames` and get the photo with the veil and LED
   * covers but no climb, the wall a PNG player board fades its climbs over
   * (`play-drawer/png-swap-layers.ts`). Art readiness waits for that overlay:
   * the photo alone is a brighter wall than the one the climbs sit on.
   */
  bareWall?: boolean;
  onGpuTransitionStateChange?: (state: 'unavailable' | 'loading' | 'ready') => void;
  /**
   * Target overlay/background width in px for small surfaces (e.g. the
   * 40×40 accessory thumbnail). Forwarded to useNativeClimbRender so the
   * Rust renderer + bundled background resolve at a small size instead of
   * the board's native ~1080px — avoiding a main-thread downscale. Omit
   * for the full-size play view (renders at native board width).
   */
  renderWidth?: number;
  /**
   * Force the bundled board-photo resolution independently of `renderWidth`.
   * The play-drawer carousel passes `renderWidth` (display-sized overlay) +
   * `backgroundVariant="full"` (crisp shared photo). See useNativeClimbRender.
   */
  backgroundVariant?: BackgroundVariant;
  /**
   * Forwarded to the holds-overlay <Image> so expo-image recycles the view and
   * releases the previous climb's decoded overlay when this stays mounted but
   * the climb changes (the play-drawer carousel swapping climbs). Key it on the
   * per-climb `frames`.
   */
  recyclingKey?: string;
  style?: ViewStyle;
  /**
   * Hold the board photo back until the holds have painted, so a board that
   * opens onto a climb nobody has rendered yet appears whole instead of as a bare
   * wall the holds then fade onto. Ignored when the overlay is already rendered
   * or cannot come at all. See `LayeredClimbImage`.
   */
  revealWithOverlay?: 'each-climb' | 'first-paint';
  /**
   * Drop the holds overlay's cross-fade for this render — forwarded to
   * LayeredClimbImage. The play-drawer carousel sets it on the current board while
   * committing a swipe so the new climb's (already-cached) holds swap instantly
   * instead of fading up, which removed the Android end-of-swipe flash.
   */
  suppressOverlayTransition?: boolean;
  /**
   * testID forwarded to the holds-overlay layer, which only mounts once the async
   * overlay render is ready — lets screenshot/e2e flows wait for the lit board to
   * appear. The full-size play-drawer board sets this; thumbnails leave it unset.
   */
  overlayTestID?: string;
  paintedTestID?: string;
  paintedExtraTestID?: string;
  /**
   * Ceiling for the veil — the wash over the unlit wall. Editing surfaces pass
   * `EDITING_VEIL_OPACITY` (none), so the holds a climber still has to find and
   * tap keep the wall they sit on. Only ever lowers; see `useNativeClimbRender`.
   */
  maxVeilOpacity?: number;
  /** Explicit host ground for the veil; omitted surfaces retain their shared drawing. */
  fieldColorOverride?: string;
  /**
   * Hold the last painted overlay while the next one renders — for surfaces
   * whose frames change on every tap. The board identity the retained frame is
   * scoped to is derived here. See `LayeredClimbImage`.
   */
  retainPreviousOverlay?: boolean;
  /** Preserve this climb's displayed holds during a same-climb size refinement. */
  retainDisplayedOverlay?: boolean;
  /**
   * Drawn above the board photo and below the holds overlay — for marks that
   * belong on the wall rather than on the climb. See `LayeredClimbImage`.
   */
  underOverlay?: ReactNode;
  /**
   * Drawn while no overlay has ever painted, i.e. when the native renderer is
   * unavailable and none is coming. Lets a surface that must show its holds
   * degrade to a JS-drawn layer instead of showing none.
   */
  emptyOverlayFallback?: ReactNode;
  /**
   * Draw the MoonBoard's A-K / row-number labels above the holds, when the
   * climber has them on (Settings › Board). For full-size boards only: at
   * thumbnail size the labels are 1-2 px specks. No effect on other boards.
   */
  showGridLabels?: boolean;
  /**
   * Draw under a different board-render settings bundle than the climber's
   * stored one — the board-look carousel's preview cards. Only the board-render
   * half is substituted: hold colours and marker shapes still come from the
   * global override store, so picking a preset can never be a back door into the
   * accessibility store. To vary the COLOURS of a preview instead, pass
   * `holdColorOverride` below — the two props are the board half and the colour
   * half of the same "draw this card differently" seam, and either can be used
   * without the other. Must be referentially stable; see `useNativeClimbRender`.
   */
  renderSettingsOverride?: BoardRenderSettings;
  renderStyleOverride?: BoardRenderStyle;
  /**
   * Draw this preview's four hold roles in a different set of colours than the
   * climber's stored ones — the colour-vision palette rail, whose cards each
   * show the same board under a different palette. Never writes the override
   * store, so previewing a palette cannot reach the physical board's LEDs.
   *
   * `{}` draws the board's own shipped palette; `undefined` reads the store.
   * Must be referentially stable; see `useNativeClimbRender`.
   */
  holdColorOverride?: HoldColorOverrides;
};

/**
 * How long a cold live-GPU request may go without presenting before the board
 * starts an ordinary PNG render as well (the hedge). Above every warm request
 * measured on the reference phones (swipe callbacks 62–80 ms on an iPhone 13 Pro
 * and a Pixel 8 Pro, edits 28–53 ms) and below every first open of a fresh
 * process (680–1080 ms to the ready callback; field `prepare_ms` alone runs
 * 280–310 ms on iPhones). See docs/rendering/gpu-climb-overlay-experiment.md.
 */
export const GPU_PNG_HEDGE_DELAY_MS = 300;

/**
 * Full-size layered board image, suited for the PlayView drawer and the
 * climb detail page. Wraps the shared LayeredClimbImage stack in an
 * aspect-ratio-locked container so the bundled board background and
 * holds-only overlay line up perfectly regardless of native source
 * dimensions.
 *
 * Mirrors via CSS to match the SVG renderer's behavior (background +
 * holds flipped together) — the Rust `mirrored` flag is intentionally
 * not used here, so a single cached PNG serves both orientations.
 */
const BoardImageNative = React.memo(function BoardImageNative({
  readyBoardArt,
  onReadyArtDisplayed,
  onArtReadinessChange,
  accessible = true,
  frames,
  boardName,
  layoutId,
  sizeId,
  setIds,
  boardWidth,
  boardHeight,
  mirrored,
  filledStyle = false,
  playSurface = false,
  editorSurface = false,
  gpuTransition,
  onGpuTransitionStateChange,
  bareWall = false,
  renderWidth,
  backgroundVariant,
  recyclingKey,
  style,
  revealWithOverlay,
  suppressOverlayTransition,
  overlayTestID,
  paintedTestID,
  paintedExtraTestID,
  renderSettingsOverride,
  renderStyleOverride,
  holdColorOverride,
  maxVeilOpacity,
  fieldColorOverride,
  retainPreviousOverlay,
  retainDisplayedOverlay,
  underOverlay,
  emptyOverlayFallback,
  showGridLabels = false,
}: BoardImageNativeProps) {
  // Whether the live stack is held invisible under the opening-art bridge, for
  // the play board's paint-timeout telemetry. Written after each commit below.
  const paintBridgingRef = useRef(false);
  const gpuFlag = useGpuClimbOverlayEnabled(boardName, layoutId);
  const [gpuFailure, setGpuFailure] = useState<{ configJson: string; frames: string | null } | null>(null);
  const [gpuPaintedConfig, setGpuPaintedConfig] = useState<string | null>(null);
  // The one PNG cache key this board may render while its GPU request is still
  // pending: set when that request missed `GPU_PNG_HEDGE_DELAY_MS`.
  const [gpuHedgeCacheKey, setGpuHedgeCacheKey] = useState<string | null>(null);
  const gpuFallbackConfigJson =
    gpuFailure && (gpuFailure.frames === null || gpuFailure.frames === frames) ? gpuFailure.configJson : null;
  const gpuSurface =
    gpuFlag &&
    NativeFrameClimbOverlayGPU !== null &&
    (!gpuTransition || NativeMotionClimbOverlayGPU !== null) &&
    !filledStyle &&
    (playSurface || editorSurface) &&
    supportsAuraGpu({ boardName, layoutId, catalogueNative: climbOverlayGpuApiVersion >= 5 });
  const {
    overlayUri,
    overlayCacheKey,
    overlayLoadKey,
    overlayImmediate,
    overlayUnavailable,
    overlayFailed,
    onOverlayLoad,
    onOverlayError,
    onOverlayMounted,
    backgroundPaths,
    missingBackgroundCount,
    backgroundsLoading,
    backgroundBaseColor,
    rendererUnavailable,
    artworkIdentity,
    gpuConfigJson = null,
    gpuStatus = gpuConfigJson ? 'ready' : 'unavailable',
    gpuFrames = frames,
    gpuWarmKey = null,
    gpuProcessCold = false,
  } = useNativeClimbRender({
    frames,
    boardName,
    layoutId,
    sizeId,
    setIds,
    filledStyle,
    playSurface,
    gpuSurface,
    gpuCatalogueNative: climbOverlayGpuApiVersion >= 5,
    gpuApiVersion: climbOverlayGpuApiVersion,
    gpuAllowEmpty: editorSurface && NativeMotionClimbOverlayGPU !== null,
    bareWall,
    gpuFallbackConfigJson,
    gpuPresentedConfigJson: gpuPaintedConfig,
    gpuHedgeCacheKey,
    paintBridgingRef,
    renderWidth,
    backgroundVariant,
    renderSettingsOverride,
    renderStyleOverride,
    holdColorOverride,
    maxVeilOpacity,
    fieldColorOverride,
  });

  const normalizedGpuTransition = useMemo(
    () =>
      gpuTransition
        ? {
            ...gpuTransition,
            previousFrames:
              gpuTransition.previousFrames === null ? null : toFlatFrames(gpuTransition.previousFrames, boardName),
            nextFrames: gpuTransition.nextFrames === null ? null : toFlatFrames(gpuTransition.nextFrames, boardName),
            prefetchFrames: gpuTransition.prefetchFrames
              ?.slice(0, 2)
              .map((prefetch) => toFlatFrames(prefetch, boardName)),
          }
        : undefined,
    [gpuTransition, boardName],
  );
  const gpuInstanceId = React.useId();
  const transitionIdentity = normalizedGpuTransition
    ? JSON.stringify([
        normalizedGpuTransition.previousFrames,
        normalizedGpuTransition.nextFrames,
        normalizedGpuTransition.centerPage,
      ])
    : null;
  const [gpuAttempt, setGpuAttempt] = useState({
    configJson: gpuConfigJson,
    frames: gpuFrames,
    transitionIdentity,
    generation: 0,
  });
  let currentGpuAttempt = gpuAttempt;
  if (
    gpuAttempt.configJson !== gpuConfigJson ||
    gpuAttempt.frames !== gpuFrames ||
    gpuAttempt.transitionIdentity !== transitionIdentity
  ) {
    currentGpuAttempt = {
      configJson: gpuConfigJson,
      frames: gpuFrames,
      transitionIdentity,
      generation: gpuAttempt.generation + 1,
    };
    setGpuAttempt(currentGpuAttempt);
  }
  const gpuRequestId = `${gpuInstanceId}:${currentGpuAttempt.generation}`;
  const currentGpuRequest = useRef<string | null>(null);
  const [gpuPresented, setGpuPresented] = useState<string | null>(null);
  useLayoutEffect(() => {
    currentGpuRequest.current = gpuConfigJson ? gpuRequestId : null;
    return () => {
      currentGpuRequest.current = null;
    };
  }, [gpuConfigJson, gpuRequestId]);
  // The cold GPU request waiting for its first holds, for `Aura GPU First Holds`:
  // which layer showed them first and how long after the board asked. Refs only,
  // written on a few transitions per climb; nothing here runs per frame.
  const firstHoldsWaitRef = useRef<{
    cacheKey: string;
    requestId: string;
    startedAtMs: number;
    /** The drawing was not yet warm in this process: its PNG rendered at once. */
    cold: boolean;
    /** This climb's PNG was already cached when the wait began. */
    cachedAtStart: boolean;
    reported: boolean;
  } | null>(null);
  const firstHoldsSerialRef = useRef(0);
  const firstHoldsContextRef = useRef({ boardName, editorSurface, gpuWarmKey });
  firstHoldsContextRef.current = { boardName, editorSurface, gpuWarmKey };
  const reportFirstHolds = useCallback((shownBy: 'gpu' | 'png') => {
    const wait = firstHoldsWaitRef.current;
    if (!wait || wait.reported) return;
    wait.reported = true;
    const context = firstHoldsContextRef.current;
    reportGpuFirstHolds(
      {
        boardName: context.boardName,
        apiVersion: climbOverlayGpuApiVersion,
        surface: context.editorSurface ? 'editor' : 'player',
      },
      wait.requestId,
      shownBy === 'gpu' ? 'gpu' : wait.cachedAtStart ? 'cached-png-bridge' : 'hedged-png',
      Date.now() - wait.startedAtMs,
      wait.cold,
    );
  }, []);
  const handleGpuPresented = useCallback(
    (requestId: string, configJson: string) => {
      if (currentGpuRequest.current !== requestId) return;
      reportFirstHolds('gpu');
      // From here this drawing is warm for every board in this process.
      const { gpuWarmKey: presentedWarmKey } = firstHoldsContextRef.current;
      if (presentedWarmKey !== null) markGpuConfigWarm(presentedWarmKey);
      setGpuPresented(requestId);
      recordGpuPresented(configJson);
    },
    [reportFirstHolds],
  );
  const handleGpuRelease = useCallback(() => setGpuPaintedConfig(null), []);
  const handleGpuFailure = useCallback(
    (requestId: string, configJson: string, reason: GpuFallbackReason, failureScope: ClimbOverlayGPUFailureScope) => {
      if (currentGpuRequest.current !== requestId) return;
      if (reason === 'cancelled') return;
      const frameOnly = failureScope !== 'static';
      setGpuFailure({ configJson, frames: frameOnly ? frames : null });
      if (!frameOnly) recordGpuConfigFailure(configJson, climbOverlayGpuApiVersion);
      else if (reason === 'presentation-timeout') recordGpuPresentationTimeout(configJson);
    },
    [frames],
  );
  const handleGpuReset = useCallback((requestId: string) => {
    setGpuPresented((previous) => (previous === requestId ? null : previous));
  }, []);
  const liveOverlay = useMemo(
    () =>
      gpuConfigJson
        ? {
            identity: gpuRequestId,
            displayed: gpuPresented === gpuRequestId,
            node: (
              <GpuClimbOverlay
                configJson={gpuConfigJson}
                frames={gpuFrames}
                requestId={gpuRequestId}
                boardName={boardName}
                transition={normalizedGpuTransition}
                animateEdits={editorSurface}
                displayMirrored={mirrored ?? false}
                onPresented={handleGpuPresented}
                onFailure={handleGpuFailure}
                onReset={handleGpuReset}
                onRelease={handleGpuRelease}
              />
            ),
          }
        : undefined,
    [
      gpuConfigJson,
      gpuFrames,
      gpuRequestId,
      boardName,
      gpuPresented,
      normalizedGpuTransition,
      editorSurface,
      mirrored,
      handleGpuPresented,
      handleGpuFailure,
      handleGpuReset,
      handleGpuRelease,
    ],
  );

  const hasGpuTransition = gpuTransition !== undefined;
  useEffect(() => {
    if (!hasGpuTransition) return;
    onGpuTransitionStateChange?.(
      !gpuSurface || gpuStatus === 'unavailable'
        ? 'unavailable'
        : gpuPresented === gpuRequestId && gpuConfigJson
          ? 'ready'
          : 'loading',
    );
  }, [hasGpuTransition, gpuSurface, gpuConfigJson, gpuStatus, gpuPresented, gpuRequestId, onGpuTransitionStateChange]);

  // GPU first, once the drawing is warm in this process (`gpu-warm-configs`). A
  // GPU request with nothing of its configuration on this board yet renders no
  // PNG (a board that shows a frame keeps that drawable instead). One already
  // in the cache still shows for free. Past the grace period the board hedges:
  // the PNG for exactly this climb renders through the normal scheduler and
  // shows until the GPU presents. While the drawing is process-cold the hook
  // renders the PNG at once and no timer is needed. The native 10-second
  // deadline still decides a failure; neither PNG counts as one.
  const appForeground = !useIsAppBackgrounded();
  const boardArtVisible = useBoardArtVisible();
  const gpuFirstFramePending =
    gpuSurface &&
    frames !== '' &&
    (gpuConfigJson !== null
      ? gpuPaintedConfig !== gpuConfigJson && gpuPresented !== gpuRequestId
      : gpuStatus === 'loading');
  const gpuHedgeArmed =
    gpuFirstFramePending &&
    !gpuProcessCold &&
    appForeground &&
    boardArtVisible &&
    overlayUri === null &&
    !overlayUnavailable &&
    gpuHedgeCacheKey !== overlayCacheKey;
  // Keyed on the climb's cache key alone, so swipe re-requests of the same climb
  // keep one timer running; a new climb, a GPU frame, a cached PNG, the app
  // leaving the foreground or an unmount cancels it.
  useEffect(() => {
    if (!gpuHedgeArmed) return;
    const timer = setTimeout(() => setGpuHedgeCacheKey(overlayCacheKey), GPU_PNG_HEDGE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [gpuHedgeArmed, overlayCacheKey]);
  const firstHoldsWaitKey = gpuFirstFramePending && appForeground && boardArtVisible ? overlayCacheKey : null;
  useLayoutEffect(() => {
    if (firstHoldsWaitKey === null) {
      firstHoldsWaitRef.current = null;
      return;
    }
    if (firstHoldsWaitRef.current?.cacheKey === firstHoldsWaitKey) return;
    // A new wait (another climb, or this one again after the GPU drawable was
    // released) earns its own grace period.
    setGpuHedgeCacheKey((hedgedKey) => (hedgedKey === null ? hedgedKey : null));
    firstHoldsSerialRef.current += 1;
    firstHoldsWaitRef.current = {
      cacheKey: firstHoldsWaitKey,
      requestId: `${gpuInstanceId}:first-holds:${firstHoldsSerialRef.current}`,
      startedAtMs: Date.now(),
      cold: gpuProcessCold,
      cachedAtStart: overlayUri !== null,
      reported: false,
    };
    // `gpuProcessCold` and `overlayUri` are read as they stand when this wait
    // begins; a later change to either is not a new wait.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstHoldsWaitKey, gpuInstanceId]);
  const handlePngBridgeDisplayed = useCallback(() => reportFirstHolds('png'), [reportFirstHolds]);

  // Already rendered when the board took this climb AND decoded into memory, so
  // it is on the layer the frame the board mounts. Rendered alone is not enough:
  // the view would show the bare wall for the frames its own decode takes.
  const overlayPaintsWithBoard = overlayImmediate && isBoardArtInMemory(overlayUri);
  // A row thumbnail may use glow-fill even when the full board uses glow.
  // Its signature describes the same preferences, not the same surface style.
  // Never flash those filled marks over an incoming GPU board, even while its
  // geometry is loading. Exact full-board snapshots remain a valid bridge.
  const openingArt =
    (!gpuSurface || readyBoardArt?.quality === 'full') &&
    isReadyBoardArtCurrent(readyBoardArt, { ...artworkIdentity, mirrored: mirrored ?? false })
      ? readyBoardArt
      : undefined;
  const currentArtIdentity = JSON.stringify(
    paintedTestID === undefined
      ? [artworkIdentity, overlayUri, overlayLoadKey, backgroundPaths, liveOverlay?.identity]
      : [
          artworkIdentity,
          overlayUri,
          overlayLoadKey,
          backgroundPaths,
          liveOverlay?.identity,
          paintedTestID,
          mirrored ?? false,
        ],
  );
  const [displayedArtIdentity, setDisplayedArtIdentity] = useState<string | null>(null);
  const openingArtIsCurrent =
    !liveOverlay &&
    openingArt?.quality === 'full' &&
    openingArt.overlayUri === overlayUri &&
    openingArt.overlayLoadKey === overlayLoadKey;
  const bridging =
    openingArt !== undefined &&
    !(liveOverlay && gpuPaintedConfig === gpuConfigJson) &&
    !openingArtIsCurrent &&
    !overlayUnavailable &&
    displayedArtIdentity !== currentArtIdentity;
  useLayoutEffect(() => {
    paintBridgingRef.current = bridging;
  }, [bridging]);
  // What each stack last said: the live board, and the exact PNG held above an
  // incoming GPU surface (a free cached one, or the hedge). Either one showing
  // this climb's holds over its photo is a board the climber can read. The
  // stationary carousel still waits for the GPU itself (its neighbours have no
  // PNG), through `onGpuTransitionStateChange`.
  //
  // The bridge's word is scoped to the art identity it was given for (climb,
  // overlay, photos and GPU request). A new identity starts from "loading"
  // whatever the previous request's bridge said.
  const liveArtReadyRef = useRef(false);
  const pngBridgeReadyForRef = useRef<string | null>(null);
  const shownArtIdentityRef = useRef(currentArtIdentity);
  shownArtIdentityRef.current = currentArtIdentity;
  const gpuDisplayedRef = useRef(false);
  gpuDisplayedRef.current = liveOverlay?.displayed ?? false;
  const publishArtReadiness = useCallback(() => {
    onArtReadinessChange?.(
      (missingBackgroundCount > 0 && !backgroundsLoading) ||
        (!liveOverlay && (overlayFailed || (frames.length > 0 && rendererUnavailable)))
        ? 'failed'
        : (liveArtReadyRef.current || pngBridgeReadyForRef.current === shownArtIdentityRef.current) &&
            !bridging &&
            !backgroundsLoading
          ? 'ready'
          : 'loading',
    );
  }, [
    onArtReadinessChange,
    overlayFailed,
    missingBackgroundCount,
    backgroundsLoading,
    frames,
    rendererUnavailable,
    bridging,
    liveOverlay,
  ]);
  const handlePngBridgeReadiness = useCallback(
    (ready: boolean) => {
      // The bridge leaves in the commit the GPU frame arrives, and the live
      // stack reports that frame a commit or two later (its reveal settles in a
      // passive effect). The bridge's last word stands until then, so the board
      // never blips to "loading" in between.
      if (!ready && gpuDisplayedRef.current) return;
      pngBridgeReadyForRef.current = ready ? currentArtIdentity : null;
      publishArtReadiness();
    },
    [publishArtReadiness, currentArtIdentity],
  );
  const handleArtReadinessChange = useCallback(
    (ready: boolean) => {
      liveArtReadyRef.current = ready;
      // A live board that is ready has taken over from any bridge.
      if (ready) pngBridgeReadyForRef.current = null;
      if (liveOverlay && ready) {
        setGpuPaintedConfig(gpuConfigJson);
        if (bridging) setDisplayedArtIdentity(currentArtIdentity);
      }
      publishArtReadiness();
    },
    [publishArtReadiness, bridging, liveOverlay, currentArtIdentity, gpuConfigJson],
  );
  const handleArtError = useCallback(() => onArtReadinessChange?.('failed'), [onArtReadinessChange]);
  const liveArtRef = useRef({ identity: currentArtIdentity, bridging, onReadyArtDisplayed });
  liveArtRef.current = { identity: currentArtIdentity, bridging, onReadyArtDisplayed };
  const pendingVisibleArtRef = useRef<{
    identity: string;
    art: ReadyBoardArtIdentity & { overlayUri: string; overlayLoadKey: string | null };
  } | null>(null);
  useEffect(() => {
    const pending = pendingVisibleArtRef.current;
    if (bridging || !pending || pending.identity !== currentArtIdentity) return;
    // onDisplay beneath an opacity-zero bridge means the replacement is ready,
    // not yet visible. Report after the visibility commit reaches a frame.
    const frame = requestAnimationFrame(() => {
      if (liveArtRef.current.identity !== pending.identity || liveArtRef.current.bridging) return;
      pendingVisibleArtRef.current = null;
      liveArtRef.current.onReadyArtDisplayed?.(pending.art);
    });
    return () => cancelAnimationFrame(frame);
  }, [bridging, currentArtIdentity]);

  const containerStyle: ViewStyle = {
    width: '100%',
    aspectRatio: boardWidth / boardHeight,
    ...style,
  };

  const accessibilitySummary = useBoardAccessibilitySummary(boardName, frames);

  // Reading the credential generation through the store keeps the value stable
  // for the whole render and re-renders this board when it moves, which is
  // what drops a displayed overlay that belonged to the previous account.
  const credentialGeneration = useSyncExternalStore(subscribeToCredentialChanges, getCredentialGeneration);
  const retainedOverlayIdentity = useMemo(
    () =>
      retainDisplayedOverlay && frames
        ? JSON.stringify([overlayRetainIdentity(boardName, layoutId, sizeId, setIds), frames, credentialGeneration])
        : undefined,
    [retainDisplayedOverlay, frames, boardName, layoutId, sizeId, setIds, credentialGeneration],
  );

  // One element for both stacks (the bridge and the live board), memoised so
  // `LayeredClimbImage`'s memo still holds across this component's renders.
  // Never on a mirrored board: the art's letters would read backwards.
  // `ReadyBoardArtIdentity` keeps the scheme as a plain string.
  const artColorScheme = artworkIdentity.colorScheme === 'dark' ? 'dark' : 'light';
  const gridLabels = useMemo(
    () =>
      showGridLabels && isMoonboardBoardName(boardName) && !mirrored ? (
        <MoonBoardGridLabels
          layoutId={layoutId}
          colorScheme={artColorScheme}
          visible={renderStyleOverride?.gridLabels}
        />
      ) : null,
    [showGridLabels, boardName, layoutId, mirrored, artColorScheme, renderStyleOverride?.gridLabels],
  );

  return (
    <View
      accessible={accessible}
      accessibilityRole="image"
      accessibilityLabel={accessibilitySummary}
      style={containerStyle}
    >
      {bridging && (
        <View style={{ position: 'absolute', inset: 0, zIndex: 1 }} pointerEvents="none">
          <LayeredClimbImage
            overlayUri={openingArt.overlayUri}
            overlayLoadKey={openingArt.overlayLoadKey}
            backgroundPaths={[...openingArt.backgroundPaths]}
            baseColor={openingArt.backgroundBaseColor}
            mirrored={openingArt.mirrored}
            suppressOverlayTransition
            aboveOverlay={gridLabels}
            onArtDisplayed={handlePngBridgeDisplayed}
          />
        </View>
      )}
      {/* The exact PNG for this climb, held over a GPU surface that has not
          presented yet: one that was already cached (free), or the hedge the
          board started after the grace period. Never a PNG handoff. */}
      {liveOverlay && !liveOverlay.displayed && gpuPaintedConfig !== gpuConfigJson && overlayUri && !bridging ? (
        <View style={{ position: 'absolute', inset: 0, zIndex: 1 }} pointerEvents="none">
          <LayeredClimbImage
            overlayUri={overlayUri}
            overlayLoadKey={overlayLoadKey}
            backgroundPaths={backgroundPaths}
            baseColor={backgroundBaseColor}
            mirrored={mirrored}
            suppressOverlayTransition
            underOverlay={underOverlay}
            aboveOverlay={gridLabels}
            onArtReadinessChange={handlePngBridgeReadiness}
            onArtDisplayed={handlePngBridgeDisplayed}
          />
        </View>
      ) : null}
      <View
        style={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          left: 0,
          right: 0,
          opacity: bridging && !liveOverlay ? 0 : 1,
        }}
      >
        <LayeredClimbImage
          overlayUri={liveOverlay ? null : overlayUri}
          liveOverlay={liveOverlay}
          overlayLoadKey={overlayLoadKey}
          onOverlayLoad={onOverlayLoad}
          onOverlayError={onOverlayError}
          onOverlayMounted={onOverlayMounted}
          displayIdentity={currentArtIdentity}
          onArtReadinessChange={handleArtReadinessChange}
          onArtError={handleArtError}
          // The bare wall is only ready with its veil: never on the photo alone.
          overlayRequired={liveOverlay !== undefined || bareWall || (!!frames && !overlayUnavailable)}
          onArtDisplayed={(loadKey) => {
            if (liveOverlay || !overlayUri || loadKey !== overlayLoadKey) return;
            // A GPU board whose config is still loading shows its PNG here.
            reportFirstHolds('png');
            const displayedArt = { ...artworkIdentity, overlayUri, overlayLoadKey: loadKey };
            if (bridging) pendingVisibleArtRef.current = { identity: currentArtIdentity, art: displayedArt };
            if (openingArt) setDisplayedArtIdentity(currentArtIdentity);
            if (!bridging) onReadyArtDisplayed?.(displayedArt);
          }}
          backgroundPaths={backgroundPaths}
          baseColor={backgroundBaseColor}
          missingBackgroundCount={missingBackgroundCount}
          mirrored={mirrored}
          recyclingKey={recyclingKey}
          // Nothing to wait for when the holds are already rendered and decoded,
          // when there are none to draw, or when no overlay is coming.
          revealWithOverlay={
            frames &&
            !bridging &&
            !overlayPaintsWithBoard &&
            !overlayUnavailable &&
            (!liveOverlay || gpuPaintedConfig !== gpuConfigJson)
              ? revealWithOverlay
              : undefined
          }
          // An overlay that paints with the board has nothing to fade from.
          suppressOverlayTransition={suppressOverlayTransition || overlayPaintsWithBoard || bridging}
          overlayTestID={overlayTestID}
          paintedTestID={bridging ? undefined : paintedTestID}
          paintedExtraTestID={bridging ? undefined : paintedExtraTestID}
          // A bridge only makes sense while a replacement is on its way. Empty
          // frames render nothing at all — `useNativeClimbRender` returns before
          // it draws — so retaining there would leave the holds the climber just
          // cleared painted on the board with nothing ever coming to replace them.
          //
          // `overlayRetainIdentity` folds the spray wall version in, so a reset is a
          // different board as far as bridging goes.
          retainPreviousOverlayFor={
            retainPreviousOverlay && frames ? overlayRetainIdentity(boardName, layoutId, sizeId, setIds) : undefined
          }
          retainDisplayedOverlayFor={retainedOverlayIdentity}
          underOverlay={underOverlay}
          aboveOverlay={gridLabels}
          // Only once the loader has given up: a null overlay during an ordinary
          // cold render is "not yet", and showing the fallback there would flash
          // JS-drawn holds before the real ones on every capable device.
          emptyOverlayFallback={rendererUnavailable ? emptyOverlayFallback : undefined}
        />
      </View>
    </View>
  );
});

export { BoardImageNative };
