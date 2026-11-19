import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  StyleSheet,
  useWindowDimensions,
  PixelRatio,
  Platform,
  type LayoutChangeEvent,
  type ViewProps,
  type ViewStyle,
} from 'react-native';
import Animated, {
  runOnUI,
  useAnimatedStyle,
  useSharedValue,
  type AnimatedStyle,
  type SharedValue,
} from 'react-native-reanimated';
import { Gesture, GestureDetector, type GestureType } from 'react-native-gesture-handler';
import type { BoardName } from '@boardsesh/shared-schema';
import { useBoardAccessibilitySummary } from '../../hooks/use-board-accessibility-summary';
import { useTranslation } from 'react-i18next';
import { BoardImageNative } from '../BoardImageNative';
import { StationaryBoardCarousel } from './StationaryBoardCarousel';
import { useBoardRenderSettings } from '../../lib/board-render-settings';
import { usePlayerGpuBoard } from './use-player-gpu-board';
import { useCarouselGesture, type CarouselVirtualFinger } from './use-carousel-gesture';
import type { BoardRenderDiagnostics, BoardTransition } from './board-transition';
import type { BoardSwapFrame } from './swap-look';
import { pageOffset, type SwipePager } from './use-swipe-pager';
import { usePngWallSwap } from './use-png-wall-swap';
import { pngSwapPageOpacity, type PngSwapLayers } from './png-swap-layers';
import { usePngWallFadeEnabled } from '../../providers/feature-flags-provider';
import { useZoomPanGesture } from './use-zoom-pan-gesture';
import { centeredZoomViewport } from './zoom-viewport-clamp';
import { computeContainedBoardSize, CAROUSEL_LAYER_Z } from './play-drawer-layout';
import { ResetZoomButton } from '../board-controls/ResetZoomButton';
import { UpcomingBoardPrefetch } from './UpcomingBoardPrefetch';
import { ContentRenderMarker } from '../ContentRenderObserver';
import { countLitHolds } from '../../lib/lit-hold-count';
import {
  clearPlayBoardPrewarm,
  getPlayOverlayWidth,
  rememberPlayOverlayWidth,
} from '../../lib/board-render/play-board-prewarm';

import type {
  BoardArtReadiness,
  ReadyBoardArtIdentity,
  ReadyBoardArtSnapshot,
} from '../../lib/board-render/ready-board-art';

type BoardRenderData = {
  boardWidth: number;
  boardHeight: number;
};

type SwipeBoardCarouselProps = {
  capturePaintedTestID?: string;
  captureLocalMirrorTestID?: string;
  /** Positive geometry from the player's shared layout owner or validated cache. */
  containerSize?: { width: number; height: number };
  /** Fit-to-screen gutter only; the zoom clip spans the entire container. */
  restingHorizontalInset?: number;
  fieldColorOverride?: string;
  readyBoardArt?: ReadyBoardArtSnapshot;
  onReadyArtDisplayed?: (art: ReadyBoardArtIdentity & { overlayUri: string; overlayLoadKey: string | null }) => void;
  boardName: BoardName;
  boardRenderData: BoardRenderData;
  layoutId: number;
  sizeId: number;
  setIds: string;
  currentFrames: string;
  /**
   * When playing a route, the per-frame BLE string to render for the ACTIVE
   * board only. Falls back to `currentFrames` when null/undefined (static climb
   * or idle). The neighbours and the zoom-reset identity stay keyed on
   * `currentFrames`, so per-frame ticks never disturb swipe navigation.
   */
  currentFrameOverride?: string | null;
  /** The neighbours' frames. Null at the end of the queue, and for a climb this board cannot draw. */
  nextFrames: string | null;
  prevFrames: string | null;
  /**
   * Which page is in the middle and the offset the swipe rides, shared with the
   * play-drawer header so both move as one. See use-swipe-pager.
   */
  pager: SwipePager;
  /** The page `currentFrames` is on; the neighbours are the pages either side. */
  centerPage: number;
  /**
   * Frames for the climbs a few swipes ahead, warmed while the renderer is idle
   * (see UpcomingBoardPrefetch). Nothing is drawn from these. Pass a stable
   * array identity across renders when the contents haven't changed.
   */
  prefetchFrames?: string[];
  mirrored: boolean;
  canSwipeNext: boolean;
  canSwipePrevious: boolean;
  onSwipeNext: () => void;
  onSwipePrevious: () => void;
  /**
   * The board's spoken value: the climb on screen and where it sits, "Yoshi's
   * Island, V5, 5 of 40", then Up next's stretch or the preview note. Used on
   * Android only; see `boardAccessibility`.
   */
  accessibilityValueText?: string;
  /** The adjust actions' names when a step crosses into the list ("Next in Projects"); the plain ones otherwise. */
  nextActionLabel?: string;
  previousActionLabel?: string;
  // Fires whenever the local resetZoom callback identity is established or
  // changes — lets the parent stash it for the tick-FAB flow that needs to
  // reset zoom before opening the tick bar.
  onResetZoomReady?: (resetZoom: () => void) => void;
  enabled?: boolean;
  /** RNGH ref to the play-drawer scroll, so the swipe + pinch run simultaneously
   *  with it instead of being starved by it (see use-carousel-gesture). */
  scrollRef?: React.RefObject<React.ComponentType | undefined | null>;
  /** RNGH ref to the drawer-dismiss Pan blocked by the zoomed-only board pan. */
  dismissRef?: React.MutableRefObject<GestureType | undefined>;
  /**
   * How the stationary GPU board changes climbs; absent, the shipped wall swap.
   * The board motion lab passes its own, and remounts the carousel to change it.
   */
  transition?: BoardTransition;
  /**
   * The board motion lab's scripted finger: handed UI-thread worklets that drive
   * this swipe through the same handlers as a touch, and null when they go.
   */
  onVirtualFinger?: (finger: CarouselVirtualFinger | null) => void;
  /** The board motion lab's status line; nothing in production passes one. */
  diagnostics?: BoardRenderDiagnostics;
  /**
   * Where the stationary board copies each wall-swap frame for the wall
   * button's frost to follow; null while it draws no swap (`StationaryBoardCarousel`).
   */
  swapFrameMirror?: SharedValue<BoardSwapFrame | null>;
};

/** Hoisted so an omitted `prefetchFrames` doesn't remount the prefetch every render. */
const NO_PREFETCH_FRAMES: string[] = [];

/**
 * No board slot is an accessibility element or a touch target. A screen reader
 * lands on one fixed stand-in for the board (see `boardStandIn` below): the
 * boards themselves change places on every swipe, and focus that sat on one of
 * them would be left on a hidden view. Touches pass through the boards to that
 * stand-in or to the container, which owns the gestures, so a board being
 * inserted or removed can never be the view a touch began on.
 */
const NOT_AN_ELEMENT: ViewProps = {
  accessibilityElementsHidden: true,
  importantForAccessibility: 'no-hide-descendants',
  pointerEvents: 'none',
};

type CarouselBoardSlotProps = {
  /** The page this board is on. Fixed for the life of the mount: it is the React key. */
  page: number;
  /** The JS thread shows this climb as current. The UI thread may already have moved on. */
  isCurrent: boolean;
  frames: string | null;
  /** Per-frame playback override. Passed for the current climb only. */
  frameOverride: string | null;
  anchorPage: SharedValue<number>;
  translateX: SharedValue<number>;
  pageArt: SharedValue<Readonly<Record<number, BoardArtReadiness>>>;
  /** How far the incoming board travels to reach the middle: the contained board width. */
  slideWidth: number;
  /** How far a board travels to leave the carousel's frame, letterbox margins included. */
  exitWidth: number;
  boardBox: ViewStyle;
  readyBoardArt?: ReadyBoardArtSnapshot;
  onReadyArtDisplayed?: SwipeBoardCarouselProps['onReadyArtDisplayed'];
  boardName: BoardName;
  layoutId: number;
  sizeId: number;
  setIds: string;
  boardWidth: number;
  boardHeight: number;
  mirrored: boolean;
  overlayRenderWidth: number;
  fieldColorOverride?: string;
  zoomStyle: AnimatedStyle<ViewStyle>;
  onCurrentArtReadinessChange?: (readiness: BoardArtReadiness) => void;
  /**
   * The still-wall swap's layers (`png-swap-layers.ts`): the board stays where it
   * is and only fades. Null on the slide.
   */
  fadeLayers: SharedValue<PngSwapLayers> | null;
};

/**
 * One of the carousel's three boards: the current climb or a neighbour.
 *
 * All three are the same component with the same view structure, keyed by page.
 * That is the point: when a swipe lands, the neighbour BECOMES the current board
 * by a prop change. Nothing is remounted, so its photo and its holds, already on
 * the layer, stay there. Where the board sits is worked out on the UI thread
 * from the pager's anchor (`pageOffset`), which does not wait for that prop.
 */
const CarouselBoardSlot = React.memo(function CarouselBoardSlot({
  page,
  isCurrent,
  frames,
  frameOverride,
  anchorPage,
  translateX,
  pageArt,
  slideWidth,
  exitWidth,
  boardBox,
  readyBoardArt,
  onReadyArtDisplayed,
  boardName,
  layoutId,
  sizeId,
  setIds,
  boardWidth,
  boardHeight,
  mirrored,
  overlayRenderWidth,
  fieldColorOverride,
  zoomStyle,
  onCurrentArtReadinessChange,
  fadeLayers,
}: CarouselBoardSlotProps) {
  const mountedRef = useRef(true);
  const artIdentity = JSON.stringify([
    frames,
    frameOverride,
    boardName,
    layoutId,
    sizeId,
    setIds,
    boardWidth,
    boardHeight,
    mirrored,
    overlayRenderWidth,
    fieldColorOverride,
  ]);
  const lastArtReadinessRef = useRef<BoardArtReadiness | undefined>(undefined);
  const reportedArtRef = useRef<{ identity: string; readiness: BoardArtReadiness } | undefined>(undefined);
  const handleArtReadinessChange = useCallback(
    (readiness: BoardArtReadiness) => {
      lastArtReadinessRef.current = readiness;
      if (!mountedRef.current) return;
      // JS shared-value getters can lag queued writes from another slot. Merge
      // on the UI thread so one image cannot overwrite its neighbour's readiness.
      runOnUI((nextReadiness: BoardArtReadiness) => {
        'worklet';
        if (pageArt.value[page] === nextReadiness) return;
        pageArt.value = { ...pageArt.value, [page]: nextReadiness };
      })(readiness);
    },
    [page, pageArt],
  );
  useLayoutEffect(() => {
    mountedRef.current = true;
    // Effect replay can report from the child before this setup runs, while
    // ownership is still suspended by the previous cleanup.
    if (lastArtReadinessRef.current !== undefined) handleArtReadinessChange(lastArtReadinessRef.current);
    return () => {
      mountedRef.current = false;
      runOnUI(() => {
        'worklet';
        const remainingPages = { ...pageArt.value };
        delete remainingPages[page];
        pageArt.value = remainingPages;
      })();
    };
  }, [handleArtReadinessChange, page, pageArt]);
  useLayoutEffect(() => {
    // A climb on another board deliberately has no peek; navigation swaps the
    // board on commit. There is no pending image for this slot to wait for.
    // Keep this separate from mount ownership: descendant image layout effects
    // report before this slot's setup when a retained page changes frames.
    if (!frames) handleArtReadinessChange('ready');
  }, [frames, handleArtReadinessChange]);
  const reportArtReadiness = useCallback(
    (readiness: BoardArtReadiness) => {
      handleArtReadinessChange(readiness);
      if (!mountedRef.current) return;
      reportedArtRef.current = { identity: artIdentity, readiness };
      onCurrentArtReadinessChange?.(readiness);
    },
    [handleArtReadinessChange, artIdentity, onCurrentArtReadinessChange],
  );
  useLayoutEffect(() => {
    // A retained neighbour can become current without repainting its image.
    if (reportedArtRef.current?.identity === artIdentity) {
      onCurrentArtReadinessChange?.(reportedArtRef.current.readiness);
    }
  }, [artIdentity, onCurrentArtReadinessChange]);
  const slotStyle = useAnimatedStyle(() => {
    // The still wall: every board stays in the middle and only its opacity
    // changes, so the photo never moves. The offset is pinned to 0 rather than
    // left out, so a board that was sliding when the kill switch changed does
    // not keep its last offset.
    if (fadeLayers) return { opacity: pngSwapPageOpacity(fadeLayers.value, page), transform: [{ translateX: 0 }] };
    const { visible, offset, opacity } = pageOffset(page, anchorPage.value, translateX.value, slideWidth, exitWidth);
    // Opacity and transform only, and never zIndex. On the slide, two pages
    // that are both drawn never overlap (the incoming one lands in the middle as
    // the outgoing one leaves the frame), so there is no order to keep; the
    // still wall's fade works out its opacities from the fixed page order
    // instead. And a zIndex that changes is not a paint-order tweak in Fabric:
    // it re-inserts the native view among its siblings, which cancels a touch
    // that began on it. A swipe that took over a fling was cut off that way, 3
    // ms after it started, until this stopped animating zIndex.
    return { opacity: visible ? opacity : 0, transform: [{ translateX: offset }] };
  }, [page, slideWidth, exitWidth, fadeLayers]);

  return (
    <Animated.View
      style={[styles.slot, slotStyle]}
      // Android: a fading board fades as one picture. Without its own layer the
      // photo and the holds would each go see-through, and the photo would
      // show through the veil.
      needsOffscreenAlphaCompositing={fadeLayers !== null}
      {...NOT_AN_ELEMENT}
    >
      {/* The zoom rides every board, not just the current one. Only the board
          in the middle is drawn while zoomed (the swipe is off), and a style
          taken away from a board that is zoomed leaves its last transform
          behind: the board would come back zoomed on the next swipe. */}
      <Animated.View style={[boardBox, zoomStyle]}>
        {frames ? (
          <BoardImageNative
            accessible={false}
            readyBoardArt={readyBoardArt}
            onReadyArtDisplayed={onReadyArtDisplayed}
            onArtReadinessChange={reportArtReadiness}
            frames={frameOverride ?? frames}
            boardName={boardName}
            layoutId={layoutId}
            sizeId={sizeId}
            setIds={setIds}
            boardWidth={boardWidth}
            boardHeight={boardHeight}
            mirrored={mirrored}
            renderWidth={overlayRenderWidth}
            backgroundVariant="full"
            fieldColorOverride={fieldColorOverride}
            // Climb identity (not the per-frame override) so the overlay
            // recycles on a change of climb, not on every playback frame.
            recyclingKey={frames}
            style={boardBox}
            // Every board in the strip, neighbours too, so the labels are
            // already there when a swipe brings the next climb in.
            showGridLabels
            // A board whose play-size overlay is not rendered yet shows the wall
            // and its holds together, a few frames later, rather than the bare
            // wall first. Only the first paint of this mount. No placeholder
            // colour on purpose: the drawer behind is a blur material, and no
            // solid block matches it, so the wait shows the drawer itself.
            revealWithOverlay="first-paint"
            retainDisplayedOverlay
            // A neighbour has nothing to fade from: it is out of sight until a
            // swipe brings it in, and holds fading up on a board that is already
            // sliding is the flicker this carousel exists to avoid.
            suppressOverlayTransition={!isCurrent}
            // The one board a climber is actually looking at: `surface: 'play'`
            // on render-failure telemetry, and the only surface that watches
            // for an overlay that never paints. Never a neighbour.
            playSurface={isCurrent}
          />
        ) : null}
      </Animated.View>
    </Animated.View>
  );
});

type BareWallLayerProps = {
  layers: SharedValue<PngSwapLayers>;
  /** Written true while the bare wall has painted its veil, false otherwise. */
  ready: SharedValue<boolean>;
  boardBox: ViewStyle;
  zoomStyle: AnimatedStyle<ViewStyle>;
  boardName: BoardName;
  layoutId: number;
  sizeId: number;
  setIds: string;
  boardWidth: number;
  boardHeight: number;
  mirrored: boolean;
  overlayRenderWidth: number;
  fieldColorOverride?: string;
};

/**
 * The bare wall under the boards on the still wall: the same photo, veil, LED
 * covers and grid labels with no climb lit. Wherever a fading board is
 * see-through it shows the unlit wall the board itself draws, so the wall never
 * brightens. Drawn only while a board above it is see-through, and never a
 * page: the swipe does not wait for it and it reports nothing to `pageArt`.
 */
const BareWallLayer = React.memo(function BareWallLayer({
  layers,
  ready,
  boardBox,
  zoomStyle,
  boardName,
  layoutId,
  sizeId,
  setIds,
  boardWidth,
  boardHeight,
  mirrored,
  overlayRenderWidth,
  fieldColorOverride,
}: BareWallLayerProps) {
  const layerStyle = useAnimatedStyle(() => ({ opacity: layers.value.bareWallOpacity }));
  const handleArtReadinessChange = useCallback(
    (readiness: BoardArtReadiness) => {
      ready.value = readiness === 'ready';
    },
    [ready],
  );
  useLayoutEffect(
    () => () => {
      ready.value = false;
    },
    [ready],
  );
  return (
    <Animated.View style={[styles.slot, layerStyle]} {...NOT_AN_ELEMENT}>
      {/* Rides the zoom like the boards, so it never comes back zoomed. */}
      <Animated.View style={[boardBox, zoomStyle]}>
        <BoardImageNative
          accessible={false}
          bareWall
          frames=""
          // onDisplay reports readiness when an image's transition starts.
          // The veil must already be whole before the climbs dim over it.
          suppressOverlayTransition
          onArtReadinessChange={handleArtReadinessChange}
          boardName={boardName}
          layoutId={layoutId}
          sizeId={sizeId}
          setIds={setIds}
          boardWidth={boardWidth}
          boardHeight={boardHeight}
          mirrored={mirrored}
          renderWidth={overlayRenderWidth}
          backgroundVariant="full"
          fieldColorOverride={fieldColorOverride}
          style={boardBox}
          showGridLabels
        />
      </Animated.View>
    </Animated.View>
  );
});

export const SwipeBoardCarousel = React.memo(function SwipeBoardCarousel({
  containerSize: suppliedContainerSize,
  restingHorizontalInset = 0,
  fieldColorOverride,
  readyBoardArt,
  onReadyArtDisplayed,
  boardName,
  boardRenderData,
  layoutId,
  sizeId,
  setIds,
  currentFrames,
  currentFrameOverride,
  nextFrames,
  prevFrames,
  pager,
  centerPage,
  prefetchFrames = NO_PREFETCH_FRAMES,
  mirrored,
  canSwipeNext,
  canSwipePrevious,
  onSwipeNext,
  onSwipePrevious,
  accessibilityValueText,
  nextActionLabel,
  previousActionLabel,
  onResetZoomReady,
  enabled = true,
  scrollRef,
  dismissRef,
  transition,
  onVirtualFinger,
  diagnostics,
  swapFrameMirror,
}: SwipeBoardCarouselProps) {
  const { width: screenWidth } = useWindowDimensions();
  const { settings: renderSettings } = useBoardRenderSettings();
  // Frame/context failures affect this window; another climb can use the atlas.
  // Static failures are independently latched by binary and configuration.
  const stationaryIdentity = JSON.stringify([
    boardName,
    layoutId,
    sizeId,
    setIds,
    renderSettings,
    currentFrames,
    prevFrames,
    nextFrames,
    mirrored,
  ]);
  const [failedStationaryIdentity, setFailedStationaryIdentity] = useState<string | null>(null);
  const handleStationaryUnavailable = useCallback(() => {
    setFailedStationaryIdentity(stationaryIdentity);
  }, [stationaryIdentity]);
  const playerGpuBoard = usePlayerGpuBoard(boardName, layoutId);
  const gpuLookahead = useMemo(() => {
    const knownFrames = new Set([currentFrames, prevFrames, nextFrames]);
    const lookahead: string[] = [];
    for (const frame of prefetchFrames.slice(0, 8)) {
      if (!frame || frame.length > 16_384 || knownFrames.has(frame)) continue;
      knownFrames.add(frame);
      lookahead.push(frame);
      if (lookahead.length === 2) break;
    }
    return lookahead.length > 0 ? lookahead : NO_PREFETCH_FRAMES;
  }, [prefetchFrames, currentFrames, prevFrames, nextFrames]);
  const stationary = playerGpuBoard && !currentFrameOverride && failedStationaryIdentity !== stationaryIdentity;
  // The PNG board keeps its wall still too, unless the kill switch is on or the
  // board motion lab asks for the wipe, which slides.
  const pngWallFadeEnabled = usePngWallFadeEnabled();
  const pngFade = !stationary && pngWallFadeEnabled && (transition?.revealMode ?? 'swap') === 'swap';
  const bareWallReady = useSharedValue(false);
  const pngLayers = usePngWallSwap(pager, centerPage, pngFade, transition, bareWallReady);
  const onRenderPath = diagnostics?.onRenderPath;
  useEffect(() => {
    onRenderPath?.(stationary ? 'gpu' : 'png');
  }, [onRenderPath, stationary]);
  const pageArt = useSharedValue<Readonly<Record<number, BoardArtReadiness>>>({});
  const { t } = useTranslation('climbs');
  const accessibilitySummary = useBoardAccessibilitySummary(boardName, currentFrameOverride ?? currentFrames);
  const handleAccessibilityAction = useCallback(
    (event: { nativeEvent: { actionName: string } }) => {
      if (!enabled) return;
      if (event.nativeEvent.actionName === 'increment' && canSwipeNext) onSwipeNext();
      if (event.nativeEvent.actionName === 'decrement' && canSwipePrevious) onSwipePrevious();
    },
    [enabled, canSwipeNext, canSwipePrevious, onSwipeNext, onSwipePrevious],
  );
  const boardAccessibility = useMemo(
    () => ({
      accessible: true,
      accessibilityRole: 'adjustable' as const,
      accessibilityLabel: accessibilitySummary,
      accessibilityHint: t('mobile.boardAccessibility.adjustHint'),
      accessibilityState: { disabled: !enabled },
      // Not on iOS. VoiceOver reads an adjustable element's value the moment its
      // increment returns, before the JS thread has changed the climb, and
      // Fabric tells it nothing when the value changes after: it would say the
      // climb that left, then the player's announcement of the new one. There
      // the announcement alone says where a step went.
      ...(accessibilityValueText && Platform.OS !== 'ios'
        ? { accessibilityValue: { text: accessibilityValueText } }
        : null),
      accessibilityActions: [
        ...(enabled && canSwipeNext
          ? [{ name: 'increment', label: nextActionLabel ?? t('mobile.boardAccessibility.next') }]
          : []),
        ...(enabled && canSwipePrevious
          ? [{ name: 'decrement', label: previousActionLabel ?? t('mobile.boardAccessibility.previous') }]
          : []),
      ],
      onAccessibilityAction: handleAccessibilityAction,
    }),
    [
      accessibilitySummary,
      accessibilityValueText,
      enabled,
      canSwipeNext,
      canSwipePrevious,
      nextActionLabel,
      previousActionLabel,
      handleAccessibilityAction,
      t,
    ],
  );
  // Measured box the board is laid out into. The board is sized to *fit* this
  // box (contain) so the play drawer's full-screen first view can keep the
  // action bar and a Beta-videos teaser on screen instead of the tall board
  // pushing them below the fold. Starts at 0; populated by onLayout. The zoom
  // hook mirrors these into shared values. Artwork already mounts with native
  // contain-fit; JS geometry enables gestures and refines the overlay width.
  const [localContainerSize, setLocalContainerSize] = useState({ width: 0, height: 0 });
  const hasSuppliedContainerSize =
    !!suppliedContainerSize &&
    Number.isFinite(suppliedContainerSize.width) &&
    Number.isFinite(suppliedContainerSize.height) &&
    suppliedContainerSize.width > 0 &&
    suppliedContainerSize.height > 0;
  const suppliedSizeRef = useRef(hasSuppliedContainerSize);
  suppliedSizeRef.current = hasSuppliedContainerSize;
  const containerSize = hasSuppliedContainerSize && suppliedContainerSize ? suppliedContainerSize : localContainerSize;

  const { boardWidth, boardHeight } = boardRenderData;
  const aspectRatio = boardWidth / boardHeight;
  // Contain the board within the measured box, preserving aspect ratio and
  // centering. Letterboxes (horizontally on tall boards, vertically on wide
  // ones) so the whole climb stays visible while the box drives the height.
  const boardBox = useMemo(
    () =>
      Number.isFinite(containerSize.width) && Number.isFinite(containerSize.height) && Number.isFinite(aspectRatio)
        ? computeContainedBoardSize(containerSize.width - restingHorizontalInset * 2, containerSize.height, aspectRatio)
        : null,
    [containerSize, aspectRatio, restingHorizontalInset],
  );
  const imageBox = useMemo<ViewStyle>(
    () => ({ ...(boardBox ?? { width: '100%', height: '100%' }), aspectRatio: undefined }),
    [boardBox],
  );
  const gesturesEnabled = enabled && boardBox !== null;
  // The carousel works in board-width units: the swipe settles when the
  // incoming board has travelled its own width to the middle, and the header's
  // fade is measured against the same width. The outgoing board has further to
  // go: half the frame plus half the board, past its letterbox margins, so
  // `pageOffset` stretches its path to leave the frame in the same swipe.
  const boardWidthForSwipe = boardBox?.width ?? screenWidth;
  const exitWidthForSwipe = boardBox ? (containerSize.width + boardBox.width) / 2 : boardWidthForSwipe;
  const zoomViewport = useMemo(
    () =>
      boardBox
        ? centeredZoomViewport(containerSize.width, containerSize.height, boardBox.width, boardBox.height)
        : undefined,
    [containerSize, boardBox],
  );

  const { pinchGesture, zoomPanGesture, isZoomed, isZoomedSV, resetZoom, animatedZoomStyle } = useZoomPanGesture({
    enabled: gesturesEnabled,
    containerWidth: boardBox?.width ?? screenWidth,
    containerHeight: boardBox?.height ?? containerSize.height,
    viewport: zoomViewport,
    scrollRef,
    dismissRef,
  });

  const onResetZoomReadyRef = useRef(onResetZoomReady);
  onResetZoomReadyRef.current = onResetZoomReady;

  useEffect(() => {
    onResetZoomReadyRef.current?.(resetZoom);
  }, [resetZoom, onResetZoomReadyRef]);

  // Reset zoom on climb change, but only if actually zoomed — otherwise it's
  // just a no-op withTiming(1→1) and a setState(false→false).
  const prevFramesRef = useRef(currentFrames);
  useEffect(() => {
    if (prevFramesRef.current !== currentFrames) {
      prevFramesRef.current = currentFrames;
      if (isZoomed) resetZoom();
    }
  }, [currentFrames, isZoomed, resetZoom]);

  const { gesture: swipeGesture, virtualFinger } = useCarouselGesture({
    pager,
    boardWidth: boardWidthForSwipe,
    enabled: gesturesEnabled,
    isZoomedSV,
    // The static capture board cannot share readiness owned by retained slots.
    // Its capture markers still wait for actual image display.
    pageArt,
    scrollRef,
  });
  useEffect(() => {
    if (!onVirtualFinger) return;
    onVirtualFinger(virtualFinger);
    return () => onVirtualFinger(null);
  }, [onVirtualFinger, virtualFinger]);

  // Outer composition: pinch + swipe always. zoomPan is rendered separately
  // as a conditional overlay when zoomed (see below) so it doesn't claim
  // 1-finger touches in the idle state. That keeps swipe navigation working
  // and lets vertical drags fall through to BottomSheetScrollView.
  const composedGesture = React.useMemo(
    () => Gesture.Simultaneous(pinchGesture, swipeGesture),
    [pinchGesture, swipeGesture],
  );

  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    // The parent already owns this geometry. Avoid a second measuring commit.
    if (suppliedSizeRef.current) return;
    const { width, height } = event.nativeEvent.layout;
    setLocalContainerSize((prev) =>
      Math.abs(prev.width - width) > 1 || Math.abs(prev.height - height) > 1 ? { width, height } : prev,
    );
  }, []);

  // The neighbours mount one frame after the current board, so opening the
  // drawer does no more work before its first paint than it did with one board.
  // A swipe cannot outrun this in practice: the frame passes long before a
  // finger has landed and moved 10 points.
  const [neighboursMounted, setNeighboursMounted] = useState(false);
  const boardMeasured = boardBox != null;
  useEffect(() => {
    if (!boardMeasured) return;
    const handle = requestAnimationFrame(() => setNeighboursMounted(true));
    return () => cancelAnimationFrame(handle);
  }, [boardMeasured]);
  // The still wall's bare wall a frame after that: a first render of it (once
  // per board look; it is cached after) queues behind the neighbours', which a
  // swipe waits for, rather than ahead of them.
  const [bareWallMounted, setBareWallMounted] = useState(false);
  useEffect(() => {
    if (!neighboursMounted) return;
    const handle = requestAnimationFrame(() => setBareWallMounted(true));
    return () => cancelAnimationFrame(handle);
  }, [neighboursMounted]);

  const litHoldCount = useMemo(() => countLitHolds(currentFrames), [currentFrames]);
  // Remembered so the climbs list can start the next climb's play-size render at
  // the tap, before this carousel has mounted and measured again.
  const measuredOverlayWidth = boardBox ? Math.round(boardBox.width * PixelRatio.get()) : null;
  useEffect(() => {
    if (measuredOverlayWidth === null) return;
    rememberPlayOverlayWidth({ boardName, layoutId, sizeId, setIds }, measuredOverlayWidth);
    // The board below now holds the render the tap started.
    clearPlayBoardPrewarm();
  }, [measuredOverlayWidth, boardName, layoutId, sizeId, setIds]);
  // The lit climb anchors layout observation for the visible board.

  // Native contain-fit draws cached artwork before JS geometry is available.
  // Match the prewarmed overlay key where possible; only gesture readiness waits
  // for a positive contained box. Updating the fit preserves the current image.
  const overlayRenderWidth =
    measuredOverlayWidth ??
    getPlayOverlayWidth({ boardName, layoutId, sizeId, setIds }) ??
    (Number.isFinite(boardWidth) && boardWidth > 0 ? Math.max(1, Math.round(boardWidth)) : 1);

  const currentArtIdentity = JSON.stringify([
    centerPage,
    currentFrames,
    currentFrameOverride,
    boardName,
    layoutId,
    sizeId,
    setIds,
    boardWidth,
    boardHeight,
    mirrored,
    overlayRenderWidth,
    fieldColorOverride,
  ]);
  const [displayedArt, setDisplayedArt] = useState<{ identity: string; readiness: BoardArtReadiness } | null>(null);
  const onCurrentArtReadinessChange = useCallback(
    (readiness: BoardArtReadiness) => {
      setDisplayedArt((previous) =>
        previous?.identity === currentArtIdentity && previous.readiness === readiness
          ? previous
          : { identity: currentArtIdentity, readiness },
      );
    },
    [currentArtIdentity],
  );
  const currentArtDisplayed = displayedArt?.identity === currentArtIdentity && displayedArt.readiness === 'ready';

  const renderSlot = (page: number, frames: string | null, isCurrent: boolean) => (
    <CarouselBoardSlot
      // The page, never the climb: a neighbour that becomes current keeps its
      // page, and with it its mounted images.
      key={page}
      page={page}
      isCurrent={isCurrent}
      frames={frames}
      frameOverride={isCurrent ? (currentFrameOverride ?? null) : null}
      anchorPage={pager.anchorPage}
      translateX={pager.translateX}
      pageArt={pageArt}
      slideWidth={boardWidthForSwipe}
      exitWidth={exitWidthForSwipe}
      boardBox={imageBox}
      readyBoardArt={isCurrent ? readyBoardArt : undefined}
      onReadyArtDisplayed={isCurrent ? onReadyArtDisplayed : undefined}
      boardName={boardName}
      layoutId={layoutId}
      sizeId={sizeId}
      setIds={setIds}
      boardWidth={boardWidth}
      boardHeight={boardHeight}
      mirrored={mirrored}
      overlayRenderWidth={overlayRenderWidth}
      fieldColorOverride={fieldColorOverride}
      zoomStyle={animatedZoomStyle}
      onCurrentArtReadinessChange={isCurrent ? onCurrentArtReadinessChange : undefined}
      fadeLayers={pngFade ? pngLayers : null}
    />
  );

  const currentBoard = renderSlot(centerPage, currentFrames, true);

  return (
    <GestureDetector gesture={composedGesture}>
      <View style={styles.container} onLayout={handleLayout} testID="play-drawer-board-container">
        {currentArtDisplayed && litHoldCount > 0 && (
          <View testID="play-drawer-board-overlay" pointerEvents="none" style={styles.paintMarker} collapsable={false}>
            <ContentRenderMarker route="play-drawer" count={litHoldCount} />
          </View>
        )}
        {/* What a screen reader lands on: one view the size of the board that
            never moves, is never remounted, and describes the current climb.
            It takes touches, so exploring by touch finds it. That is also why
            it is the first child: the boards come and go after it, and the
            view a touch began on must never be one that is put back into its
            parent, which cancels the touch. */}
        {
          <View
            style={[styles.boardStandIn, imageBox]}
            testID="play-drawer-board-accessibility"
            {...boardAccessibility}
          />
        }
        {/* One keyed list, so the board that was a neighbour stays mounted when it
            becomes the current one. In page order, which lets a step add a board
            at one end and drop one at the other without moving the two that
            stay. */}
        {stationary ? (
          <StationaryBoardCarousel
            boardProps={{
              accessible: false,
              readyBoardArt,
              onReadyArtDisplayed,
              frames: currentFrames,
              boardName,
              layoutId,
              sizeId,
              setIds,
              boardWidth,
              boardHeight,
              mirrored,
              renderWidth: overlayRenderWidth,
              backgroundVariant: 'full',
              fieldColorOverride,
              recyclingKey: currentFrames,
              style: imageBox,
              showGridLabels: true,
              revealWithOverlay: 'first-paint',
              retainDisplayedOverlay: true,
              suppressOverlayTransition: true,
              playSurface: true,
            }}
            previousFrames={prevFrames}
            nextFrames={nextFrames}
            prefetchFrames={gpuLookahead}
            centerPage={centerPage}
            pager={pager}
            pageArt={pageArt}
            boardBox={imageBox}
            zoomStyle={animatedZoomStyle}
            onUnavailable={handleStationaryUnavailable}
            onCurrentArtReadinessChange={onCurrentArtReadinessChange}
            transition={transition}
            diagnostics={diagnostics}
            swapFrameMirror={swapFrameMirror}
          />
        ) : (
          [
            // Under every board, so first in the list; mounted after the
            // neighbours, so the first paint does no more work than one board.
            bareWallMounted && pngFade ? (
              <BareWallLayer
                key="bare-wall"
                layers={pngLayers}
                ready={bareWallReady}
                boardBox={imageBox}
                zoomStyle={animatedZoomStyle}
                boardName={boardName}
                layoutId={layoutId}
                sizeId={sizeId}
                setIds={setIds}
                boardWidth={boardWidth}
                boardHeight={boardHeight}
                mirrored={mirrored}
                overlayRenderWidth={overlayRenderWidth}
                fieldColorOverride={fieldColorOverride}
              />
            ) : null,
            neighboursMounted ? renderSlot(centerPage - 1, prevFrames, false) : null,
            currentBoard,
            neighboursMounted ? renderSlot(centerPage + 1, nextFrames, false) : null,
          ]
        )}

        {/* Draws nothing: warms the renders for the climbs a few swipes ahead
            while the renderer is idle, so those swipes are cache hits. Not on
            the stationary GPU board: its swipes never show a PNG, and the GPU
            prepares its own two climbs ahead (`gpuLookahead`). */}
        {!boardMeasured || stationary ? null : (
          <UpcomingBoardPrefetch
            frames={prefetchFrames}
            boardName={boardName}
            layoutId={layoutId}
            sizeId={sizeId}
            setIds={setIds}
            renderWidth={overlayRenderWidth}
            fieldColorOverride={fieldColorOverride}
          />
        )}

        {/* Pan-while-zoomed overlay: only mounted when zoomed so it doesn't
            claim 1-finger touches in the idle state (which would block
            BottomSheetScrollView scroll on the climb image). 2-finger pinches
            fall through to the outer GestureDetector via maxPointers(1). */}
        {isZoomed && boardMeasured && (
          <GestureDetector gesture={zoomPanGesture}>
            <View style={styles.zoomPanOverlay} />
          </GestureDetector>
        )}

        {/* Bottom-right, matching the create and hold-filter boards so the
            control is in one learned place across every board in the app. Kept
            board art. Nothing is selectable on this board, so it costs
            legibility, not taps. */}
        <ResetZoomButton visible={isZoomed} onPress={resetZoom} style={styles.resetZoomWrapper} />
      </View>
    </GestureDetector>
  );
});

const styles = StyleSheet.create({
  paintMarker: { position: 'absolute', width: 1, height: 1 },
  container: {
    flex: 1,
    width: '100%',
    overflow: 'hidden',
    justifyContent: 'center',
    alignItems: 'center',
  },
  // Screenshot mode's plain current board. In flow, above the neighbours.
  boardWrapper: {
    width: '100%',
    alignItems: 'center',
    zIndex: CAROUSEL_LAYER_Z.board,
  },
  // Every board fills the container and centres itself in it, so all three sit
  // on the same spot: their transform tells them apart on the slide, their
  // opacity on the still wall, where the bare wall shares the spot too. One
  // zIndex for all of them, fixed: see CarouselBoardSlot for why it must never
  // change.
  slot: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: CAROUSEL_LAYER_Z.board,
  },
  // In flow, so the container centres it exactly where it centres the boards.
  // Their level, and ahead of them in the tree: it draws nothing, and sits
  // under boards that let every touch through.
  boardStandIn: {
    zIndex: CAROUSEL_LAYER_Z.board,
  },
  zoomPanOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    // Must out-rank every board slot: this overlay is the boards' SIBLING, so a drag that
    // starts on the board only reaches its pan when the overlay hit-tests first (#4191).
    zIndex: CAROUSEL_LAYER_Z.zoomPan,
  },
  resetZoomWrapper: {
    bottom: 12,
    right: 12,
    zIndex: CAROUSEL_LAYER_Z.resetZoom,
  },
});
