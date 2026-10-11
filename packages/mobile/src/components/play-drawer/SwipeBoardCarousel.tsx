import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  StyleSheet,
  useWindowDimensions,
  PixelRatio,
  type LayoutChangeEvent,
  type ViewProps,
  type ViewStyle,
} from 'react-native';
import Animated, { useAnimatedStyle, type AnimatedStyle, type SharedValue } from 'react-native-reanimated';
import { Gesture, GestureDetector, type GestureType } from 'react-native-gesture-handler';
import type { BoardName } from '@boardsesh/shared-schema';
import { useBoardAccessibilitySummary } from '../../hooks/use-board-accessibility-summary';
import { useTranslation } from 'react-i18next';
import { BoardImageNative } from '../BoardImageNative';
import { useCarouselGesture } from './use-carousel-gesture';
import { pageOffset, type SwipePager } from './use-swipe-pager';
import { useZoomPanGesture } from './use-zoom-pan-gesture';
import { computeContainedBoardSize, CAROUSEL_LAYER_Z } from './play-drawer-layout';
import { ResetZoomButton } from '../board-controls/ResetZoomButton';
import { UpcomingBoardPrefetch } from './UpcomingBoardPrefetch';
import { useShowcaseAnchor } from '../../lib/showcase-anchor';
import { ScreenshotSmokeMarker } from '../ScreenshotSmokeMarker';
import { countLitHolds } from '../../lib/screenshot-smoke';
import { clearPlayBoardPrewarm, rememberPlayOverlayWidth } from '../../lib/board-render/play-board-prewarm';

type BoardRenderData = {
  boardWidth: number;
  boardHeight: number;
};

type SwipeBoardCarouselProps = {
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
  /** How far the incoming board travels to reach the middle: the contained board width. */
  slideWidth: number;
  boardBox: { width: number; height: number };
  boardName: BoardName;
  layoutId: number;
  sizeId: number;
  setIds: string;
  boardWidth: number;
  boardHeight: number;
  mirrored: boolean;
  overlayRenderWidth: number;
  zoomStyle: AnimatedStyle<ViewStyle>;
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
  slideWidth,
  boardBox,
  boardName,
  layoutId,
  sizeId,
  setIds,
  boardWidth,
  boardHeight,
  mirrored,
  overlayRenderWidth,
  zoomStyle,
}: CarouselBoardSlotProps) {
  const slotStyle = useAnimatedStyle(() => {
    const { visible, offset } = pageOffset(page, anchorPage.value, translateX.value, slideWidth);
    // Opacity and transform only, and never zIndex. Two pages that are both
    // drawn never overlap (the incoming one stops in the middle as the outgoing
    // one's trailing edge leaves it), so there is no order to keep. And a
    // zIndex that changes is not a paint-order tweak in Fabric: it re-inserts
    // the native view among its siblings, which cancels a touch that began on
    // it. A swipe that took over a fling was cut off that way, 3 ms after it
    // started, until this stopped animating zIndex.
    return { opacity: visible ? 1 : 0, transform: [{ translateX: offset }] };
  }, [page, slideWidth]);

  return (
    <Animated.View style={[styles.slot, slotStyle]} {...NOT_AN_ELEMENT}>
      {/* The zoom rides every board, not just the current one. Only the board
          in the middle is drawn while zoomed (the swipe is off), and a style
          taken away from a board that is zoomed leaves its last transform
          behind: the board would come back zoomed on the next swipe. */}
      <Animated.View style={[boardBox, zoomStyle]}>
        {frames ? (
          <BoardImageNative
            accessible={false}
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
            // Climb identity (not the per-frame override) so the overlay
            // recycles on a change of climb, not on every playback frame.
            recyclingKey={frames}
            style={boardBox}
            // A board whose play-size overlay is not rendered yet shows the wall
            // and its holds together, a few frames later, rather than the bare
            // wall first. Only the first paint of this mount. No placeholder
            // colour on purpose: the drawer behind is a blur material, and no
            // solid block matches it, so the wait shows the drawer itself.
            revealWithOverlay="first-paint"
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

export const SwipeBoardCarousel = React.memo(function SwipeBoardCarousel({
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
  onResetZoomReady,
  enabled = true,
  scrollRef,
  dismissRef,
}: SwipeBoardCarouselProps) {
  const { width: screenWidth } = useWindowDimensions();
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
      accessibilityActions: [
        ...(enabled && canSwipeNext ? [{ name: 'increment', label: t('mobile.boardAccessibility.next') }] : []),
        ...(enabled && canSwipePrevious ? [{ name: 'decrement', label: t('mobile.boardAccessibility.previous') }] : []),
      ],
      onAccessibilityAction: handleAccessibilityAction,
    }),
    [accessibilitySummary, enabled, canSwipeNext, canSwipePrevious, handleAccessibilityAction, t],
  );
  // Measured box the board is laid out into. The board is sized to *fit* this
  // box (contain) so the play drawer's full-screen first view can keep the
  // action bar and a Beta-videos teaser on screen instead of the tall board
  // pushing them below the fold. Starts at 0; populated by onLayout. The zoom
  // hook mirrors these into shared values, so updating after first layout
  // doesn't rebuild the gestures.
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });

  const { boardWidth, boardHeight } = boardRenderData;
  const aspectRatio = boardWidth / boardHeight;
  // Contain the board within the measured box, preserving aspect ratio and
  // centering. Letterboxes (horizontally on tall boards, vertically on wide
  // ones) so the whole climb stays visible while the box drives the height.
  const boardBox = useMemo(
    () => computeContainedBoardSize(containerSize.width, containerSize.height, aspectRatio),
    [containerSize, aspectRatio],
  );
  // The carousel works in board-width units: a letterboxed (narrower) board
  // must slide off by its own width and the incoming board must enter
  // edge-adjacent. Using screenWidth instead leaves a gap equal to the letterbox
  // margins.
  const boardWidthForSwipe = boardBox?.width ?? screenWidth;

  const { pinchGesture, zoomPanGesture, isZoomed, isZoomedSV, resetZoom, animatedZoomStyle } = useZoomPanGesture({
    enabled,
    containerWidth: boardBox?.width ?? screenWidth,
    containerHeight: boardBox?.height ?? containerSize.height,
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

  const { gesture: swipeGesture } = useCarouselGesture({
    pager,
    boardWidth: boardWidthForSwipe,
    screenWidth,
    enabled,
    isZoomedSV,
    scrollRef,
  });

  // Outer composition: pinch + swipe always. zoomPan is rendered separately
  // as a conditional overlay when zoomed (see below) so it doesn't claim
  // 1-finger touches in the idle state. That keeps swipe navigation working
  // and lets vertical drags fall through to BottomSheetScrollView.
  const composedGesture = React.useMemo(
    () => Gesture.Simultaneous(pinchGesture, swipeGesture),
    [pinchGesture, swipeGesture],
  );

  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setContainerSize((prev) =>
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

  const smokeLitHoldCount = useMemo(
    () => (process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1' ? countLitHolds(currentFrames) : 0),
    [currentFrames],
  );
  const isScreenshotMode = process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1';
  // Remembered so the climbs list can start the next climb's play-size render at
  // the tap, before this carousel has mounted and measured again.
  const measuredOverlayWidth = boardBox ? Math.round(boardBox.width * PixelRatio.get()) : null;
  useEffect(() => {
    if (measuredOverlayWidth === null) return;
    rememberPlayOverlayWidth({ boardName, layoutId, sizeId, setIds }, measuredOverlayWidth);
    // The board below now holds the render the tap started.
    clearPlayBoardPrewarm();
  }, [measuredOverlayWidth, boardName, layoutId, sizeId, setIds]);
  // The lit climb, for the showcase video's callouts (screenshot mode only, like the plain board below).
  const boardSurfaceAnchor = useShowcaseAnchor('board-surface');

  // Keep measuring the flex box, but never mount images at an implicit/full-width
  // size. Cached photos can paint before onLayout reaches JS, making the later
  // contain-fit correction look like a zoom during the native opening animation.
  if (!boardBox) {
    return (
      <GestureDetector gesture={composedGesture}>
        <View style={styles.container} onLayout={handleLayout} testID="play-drawer-board-container" />
      </GestureDetector>
    );
  }

  // Only request display-sized overlays once layout is known. The shared photo
  // stays full-res; useNativeClimbRender clamps the overlay to native resolution.
  const overlayRenderWidth = Math.round(boardBox.width * PixelRatio.get());

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
      slideWidth={boardWidthForSwipe}
      boardBox={boardBox}
      boardName={boardName}
      layoutId={layoutId}
      sizeId={sizeId}
      setIds={setIds}
      boardWidth={boardWidth}
      boardHeight={boardHeight}
      mirrored={mirrored}
      overlayRenderWidth={overlayRenderWidth}
      zoomStyle={animatedZoomStyle}
    />
  );

  // Screenshot mode renders the current board in PLAIN (non-reanimated) Views.
  // The swipe/zoom `Animated.View` wrappers promote the board to a render layer
  // that Android's `adb screencap` (Maestro's capture) intermittently misses
  // inside the play-drawer modal — the board-view shot came out blank ~half the
  // time even with a redraw swipe. The transforms are identity at rest, so the
  // static board is pixel-identical without them; the simpler board-presence
  // sheet (no carousel) already captures reliably, confirming the carousel layer
  // is the culprit. overlayTestID anchors on the painted holds overlay.
  const currentBoard = isScreenshotMode ? (
    <View
      // One key for every climb, unlike the pages: this board changes climb by
      // a prop, so the wall photo stays mounted across a swipe and only the
      // holds are loaded again.
      key="plain-current"
      style={[styles.boardWrapper, boardBox]}
      {...boardSurfaceAnchor}
      {...boardAccessibility}
      // Android groups an accessible board and hides its nested test IDs.
      // In captures, expose the actual onLoad-gated overlay anchor instead.
      accessible={false}
      importantForAccessibility="no"
    >
      {/* Inlined, not `isScreenshotMode`: the strip must not lean on constant propagation. */}
      {process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1' ? (
        <ScreenshotSmokeMarker route="play-drawer" count={smokeLitHoldCount} />
      ) : null}
      <BoardImageNative
        accessible={false}
        frames={currentFrameOverride ?? currentFrames}
        boardName={boardName}
        layoutId={layoutId}
        sizeId={sizeId}
        setIds={setIds}
        boardWidth={boardWidth}
        boardHeight={boardHeight}
        mirrored={mirrored}
        renderWidth={overlayRenderWidth}
        backgroundVariant="full"
        recyclingKey={currentFrames}
        style={boardBox}
        overlayTestID="play-drawer-board-overlay"
        // The one board a climber is actually looking at: `surface: 'play'`
        // on render-failure telemetry, and the only surface that watches
        // for an overlay that never paints. Never a neighbour.
        playSurface
      />
    </View>
  ) : (
    renderSlot(centerPage, currentFrames, true)
  );

  return (
    <GestureDetector gesture={composedGesture}>
      <View style={styles.container} onLayout={handleLayout} testID="play-drawer-board-container">
        {/* What a screen reader lands on: one view the size of the board that
            never moves, is never remounted, and describes the current climb.
            It takes touches, so exploring by touch finds it. That is also why
            it is the first child: the boards come and go after it, and the
            view a touch began on must never be one that is put back into its
            parent, which cancels the touch. Screenshot mode has its own, on
            the plain board. */}
        {isScreenshotMode ? null : (
          <View
            style={[styles.boardStandIn, boardBox]}
            testID="play-drawer-board-accessibility"
            {...boardAccessibility}
          />
        )}
        {/* One keyed list, so the board that was a neighbour stays mounted when it
            becomes the current one. In page order, which lets a step add a board
            at one end and drop one at the other without moving the two that
            stay. Screenshot mode's plain board is not on a layer the neighbours
            can slide under, so there it goes first and they draw over it. */}
        {isScreenshotMode
          ? [
              currentBoard,
              neighboursMounted ? renderSlot(centerPage - 1, prevFrames, false) : null,
              neighboursMounted ? renderSlot(centerPage + 1, nextFrames, false) : null,
            ]
          : [
              neighboursMounted ? renderSlot(centerPage - 1, prevFrames, false) : null,
              currentBoard,
              neighboursMounted ? renderSlot(centerPage + 1, nextFrames, false) : null,
            ]}

        {/* Draws nothing: warms the renders for the climbs a few swipes ahead
            while the renderer is idle, so those swipes are cache hits. Skipped
            in screenshot mode, where the only render that matters is the one
            board the capture is waiting on. */}
        {isScreenshotMode ? null : (
          <UpcomingBoardPrefetch
            frames={prefetchFrames}
            boardName={boardName}
            layoutId={layoutId}
            sizeId={sizeId}
            setIds={setIds}
            renderWidth={overlayRenderWidth}
          />
        )}

        {/* Pan-while-zoomed overlay: only mounted when zoomed so it doesn't
            claim 1-finger touches in the idle state (which would block
            BottomSheetScrollView scroll on the climb image). 2-finger pinches
            fall through to the outer GestureDetector via maxPointers(1). */}
        {isZoomed && (
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
  // on the same spot and only their transform tells them apart. One zIndex for
  // all of them, fixed: see CarouselBoardSlot for why it must never change.
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
