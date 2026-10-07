import React, {
  useImperativeHandle,
  useMemo,
  useRef,
  type MutableRefObject,
  type ReactNode,
  type RefObject,
} from 'react';
import { View, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { Image } from 'expo-image';
import Animated, { useDerivedValue, type DerivedValue, type SharedValue } from 'react-native-reanimated';
import { GestureDetector, type GestureType } from 'react-native-gesture-handler';
import type { BoardName, HoldsFilter } from '@boardsesh/shared-schema';
import { BoardImageNative } from '../BoardImageNative';
import { ResetZoomButton } from '../board-controls/ResetZoomButton';
import { useZoomPanGesture } from '../play-drawer/use-zoom-pan-gesture';
import type { ZoomViewport } from '../play-drawer/zoom-viewport-clamp';
import { holdGeometry, buildHoldHitTargets } from '../create-climb/holdLayout';
import { useRestHoldTapGesture } from '../create-climb/use-rest-hold-tap-gesture';
import { useZoomedHoldTapGesture, PAN_ACTIVATION_OFFSET } from '../create-climb/use-zoomed-hold-tap-gesture';
import { spacing } from '../../theme/tokens';
import type { BoardHoldTarget } from '../../lib/create-board-holds';
import { SearchHoldFilterRings } from './SearchHoldFilterRings';
import { FullResolutionPhotoLayer, type FullResolutionPhoto } from './FullResolutionPhotoLayer';

/** Context handed to an overlay rendered inside the board's zoom transform. */
export type FilterBoardTransformContext = {
  /**
   * The board's pinch gesture.
   *
   * NOTE for new overlays: do NOT compose this instance into your own
   * `GestureDetector`. RNGH assigns one handler tag per Gesture object and
   * `createGestureHandler` throws "Handler with tag N already exists" the moment
   * a second detector mounts it (RNGestureHandlerModule.kt /
   * RNGestureHandlerManager.mm). Declare the relation instead:
   * `yourGesture.simultaneousWithExternalGesture(pinchRef)`.
   */
  pinchGesture: GestureType;
  /**
   * Ref handle on that same pinch, for
   * `simultaneousWithExternalGesture(pinchRef)` — the safe way to let a
   * two-finger zoom recognise while a finger sits on your overlay. See the
   * warning on `pinchGesture`.
   */
  pinchRef: MutableRefObject<GestureType | undefined>;
  /** Live zoom scale, so an overlay can convert screen-pixel deltas to board px. */
  scaleSV: SharedValue<number>;
  /**
   * True while a two-finger pinch is in progress (see `useZoomPanGesture`). An
   * overlay whose own gestures are `simultaneousWithExternalGesture(pinchRef)`
   * is not failed by the pinch, so it bails on this instead of editing under a
   * zooming hand.
   */
  isPinchingSV: SharedValue<boolean>;
  /**
   * The rest of the live zoom transform. Together with `scaleSV` and the
   * container size these are everything needed to invert the board's transform
   * on the UI thread — what an overlay drawn ABOVE the transform (see
   * `renderAboveBoard`) needs to map a screen point back to board-local px:
   *
   *     screen = (local − c) · scale + c + translate,  c = containerSize / 2
   *
   * in the coordinates of the clip view an above-board overlay fills. With a
   * `viewport` that clip is the viewport and the board sits at its offset, so
   * the translate handed out here already includes the offset (it is derived,
   * hence read-only): the formula stays exact without every overlay knowing
   * about the viewport. The container size stays the RENDER box, the basis of
   * the transform's centre.
   */
  translateXSV: DerivedValue<number>;
  translateYSV: DerivedValue<number>;
  containerWidthSV: SharedValue<number>;
  containerHeightSV: SharedValue<number>;
  /**
   * The size of the clip view an above-board overlay fills: the viewport when
   * there is one, the render box otherwise. What a screen-space element (a
   * handle, a pill) keeps itself inside.
   */
  viewportWidthSV: SharedValue<number>;
  viewportHeightSV: SharedValue<number>;
  renderWidth: number;
  renderHeight: number;
};

type InteractiveFilterBoardProps = {
  /** Explicit draft photograph; avoids published registry geometry. */
  backgroundPhotoUrl?: string;
  /**
   * A sharper copy of `backgroundPhotoUrl`, fetched once the zoom passes its
   * `minScale` and drawn over it (#5911). Only the spray hold editor passes one;
   * ignored without `backgroundPhotoUrl`.
   */
  fullResolutionPhoto?: FullResolutionPhoto | null;
  /** `fullResolutionPhoto` would not load. The base photo stays on screen. */
  onFullResolutionPhotoError?: () => void;
  boardName: BoardName;
  layoutId: number;
  sizeId: number;
  setIds: string;
  boardWidth: number;
  boardHeight: number;
  holdTargets: BoardHoldTarget[];
  /** Hold-type filter rings, when this board edits hold types. Omit for zone mode. */
  holdsFilter?: HoldsFilter;
  /** The hold the picker is currently editing — drawn with a bright ring. */
  activeHoldId?: number | null;
  /** Tap handler that opens the hold picker. Omit to disable hold taps (zone mode). */
  onHoldTap?: (holdId: number) => void;
  mirrored?: boolean;
  renderWidth: number;
  renderHeight: number;
  /**
   * Drawn between the board photo and the holds (the hold heatmap), inside the
   * zoom transform so it tracks the board. Pass a memoised element: a fresh one
   * per render defeats BoardImageNative's memo.
   */
  underOverlay?: ReactNode;
  /**
   * Overlay rendered INSIDE the zoom transform (like the hold filter rings) so it
   * tracks the board at any zoom — used by the zone editor for the draggable
   * rectangle. Receives the board pinch + live scale so its pans compose cleanly.
   */
  renderInTransform?: (context: FilterBoardTransformContext) => ReactNode;
  /**
   * Overlay rendered ABOVE the zoom transform, in plain container coordinates —
   * used by the outline editor for the stylus draw surface, which has to see raw
   * screen points and invert the transform itself.
   *
   * While zoomed it is rendered as a CHILD of the pan overlay's view, not as a
   * sibling above it. That nesting is what makes a gesture the overlay declines
   * (`manager.fail()` on a finger when only a stylus draws) fall through to the
   * board's own pan and hold taps: RNGH offers a touch to the handlers on the
   * touched view and its ANCESTORS, so a sibling that merely sits underneath
   * would never see it and one-finger panning would be dead.
   *
   * At rest there is no pan overlay to nest inside, so it renders as a sibling —
   * and an at-rest tap the overlay declines reaches the ancestor pinch but not
   * the hold-tap layer inside the transform. Callers that need tap-to-select at
   * rest must offer their own affordance (the outline editor's "Pick another
   * hold").
   */
  renderAboveBoard?: (context: FilterBoardTransformContext) => ReactNode;
  /**
   * Imperative handle on the board's zoom, for chrome that lives OUTSIDE this
   * component and still has to drive it — the outline editor's Next/Prev
   * buttons, which sit in its toolbar and have to frame the hold they select.
   *
   * A ref rather than a prop-driven target, because "frame this hold" is an
   * event, not state: re-selecting the hold you are already on should re-frame
   * it, and a declarative prop equal to its previous value would not.
   */
  controlRef?: RefObject<FilterBoardControls | null>;
  /**
   * Where the zoomed-in reset control sits. Defaults to bottom-right, the corner
   * every other board uses; a screen with its own floating chrome along the
   * bottom edge moves it out of the way.
   */
  resetZoomStyle?: StyleProp<ViewStyle>;
  /**
   * Deepest pinch zoom. Defaults to the 4× every board uses; the spray hold
   * editor passes `SPRAY_EDITOR_MAX_SCALE` so small holds beside big ones can be
   * framed. Changing it does not rebuild the board's gestures.
   */
  maxScale?: number;
  /** Two fingers pan as well as zoom. See `useZoomPanGesture`'s `pinchPans`. */
  pinchPans?: boolean;
  /**
   * OPT-IN: a viewport bigger than the render box that the zoomed board fills
   * (the spray hold editor's whole screen). The clip view takes the viewport's
   * size, the board sits at its offset, and pans clamp to its visible band (see
   * `ZoomViewport`). At 1× the board looks exactly as it does without one; the
   * area round it is empty but still takes the pinch and the overlays'
   * touches. Left out, the clip is the render box and nothing changes.
   */
  viewport?: ZoomViewport;
};

/** What {@link InteractiveFilterBoard} exposes through `controlRef`. */
export type FilterBoardControls = {
  /** Animate to an explicit, already-clamped board transform. */
  zoomTo: (target: { scale: number; translateX: number; translateY: number }) => void;
  /** Animate back to the unzoomed board. */
  resetZoom: () => void;
};

/**
 * Full-bleed interactive board for the search hold filter, built on the same
 * no-SVG gesture model as `InteractiveCreateBoard`: the board PNG plus one
 * full-bleed tap overlay and the filter rings INSIDE the zoom-transformed view,
 * so taps and rings track holds at any zoom with no manual coordinate math. The
 * overlay resolves a touch to the nearest hold centre (#4496). No per-hold dots
 * are drawn: the board photo is the target. Pinch is always live; the 1-finger
 * pan only mounts while zoomed.
 *
 * Unlike the create board this lives on a full-screen route (not a bottom
 * sheet), so the pan overlay can stay simpler — there's no parent scroll to
 * yield idle drags to.
 */
export const InteractiveFilterBoard = React.memo(function InteractiveFilterBoard({
  backgroundPhotoUrl,
  fullResolutionPhoto,
  onFullResolutionPhotoError,
  boardName,
  layoutId,
  sizeId,
  setIds,
  boardWidth,
  boardHeight,
  holdTargets,
  holdsFilter,
  activeHoldId = null,
  onHoldTap,
  mirrored = false,
  renderWidth,
  renderHeight,
  underOverlay,
  renderInTransform,
  renderAboveBoard,
  controlRef,
  resetZoomStyle,
  maxScale,
  pinchPans,
  viewport,
}: InteractiveFilterBoardProps) {
  // Shared with the rest/zoom tap overlays so they mark themselves simultaneous
  // with the pinch — same Android pinch-stall fix as the create board (a finger
  // resting on an overlay must not block pinch).
  const pinchRef = useRef<GestureType | undefined>(undefined);
  const {
    pinchGesture,
    zoomPanGesture,
    isZoomed,
    isPinchingSV,
    scaleSV,
    translateXSV,
    translateYSV,
    containerWidthSV,
    containerHeightSV,
    viewportWidthSV,
    viewportHeightSV,
    viewportOffsetXSV,
    viewportOffsetYSV,
    resetZoom,
    zoomTo,
    animatedZoomStyle,
  } = useZoomPanGesture({
    enabled: true,
    containerWidth: renderWidth,
    containerHeight: renderHeight,
    panActivationOffset: PAN_ACTIVATION_OFFSET,
    pinchRef,
    maxScale,
    pinchPans,
    viewport,
  });

  // With a viewport the overlays above the board are laid out over the whole
  // viewport, where the board sits at an offset: they read the translate WITH
  // the offset folded in, so their `(p − c)·s + c + t` maths stays exact.
  // Without one the hook's own values go straight through, as they always have.
  const viewportTranslateXSV = useDerivedValue(
    () => translateXSV.value + viewportOffsetXSV.value,
    [translateXSV, viewportOffsetXSV],
  );
  const viewportTranslateYSV = useDerivedValue(
    () => translateYSV.value + viewportOffsetYSV.value,
    [translateYSV, viewportOffsetYSV],
  );
  const hasViewport = viewport != null;
  const overlayTranslateXSV: DerivedValue<number> = hasViewport ? viewportTranslateXSV : translateXSV;
  const overlayTranslateYSV: DerivedValue<number> = hasViewport ? viewportTranslateYSV : translateYSV;

  const transformContext = useMemo<FilterBoardTransformContext>(
    () => ({
      pinchGesture,
      pinchRef,
      scaleSV,
      isPinchingSV,
      translateXSV: overlayTranslateXSV,
      translateYSV: overlayTranslateYSV,
      containerWidthSV,
      containerHeightSV,
      viewportWidthSV,
      viewportHeightSV,
      renderWidth,
      renderHeight,
    }),
    [
      pinchGesture,
      scaleSV,
      isPinchingSV,
      overlayTranslateXSV,
      overlayTranslateYSV,
      containerWidthSV,
      containerHeightSV,
      viewportWidthSV,
      viewportHeightSV,
      renderWidth,
      renderHeight,
    ],
  );

  useImperativeHandle(controlRef, () => ({ zoomTo, resetZoom }), [zoomTo, resetZoom]);

  // Hit circles both tap overlays resolve a point against. Zone mode passes no
  // onHoldTap, so the rest overlay is null and the zoomed hook returns the bare
  // pan.
  const hitTargets = useMemo(
    () => buildHoldHitTargets(holdTargets, boardWidth, boardHeight, renderWidth, renderHeight, mirrored),
    [holdTargets, boardWidth, boardHeight, renderWidth, renderHeight, mirrored],
  );
  // At rest, one full-bleed overlay resolves the tap to the nearest hold centre
  // (#4496). Nothing is drawn per hold, so nothing competes for the touch.
  const restHoldTapGesture = useRestHoldTapGesture({
    hitTargets,
    // The picker opens on a single tap, so a long press routes to the same
    // handler (the hook falls back to onTap when onLongPress is omitted).
    onTap: onHoldTap,
    pinchRef,
    isPinchingSV,
  });

  const overlayGesture = useZoomedHoldTapGesture({
    zoomPanGesture,
    scaleSV,
    // Inverted in the pan overlay's coordinates, which are the viewport's.
    translateXSV: overlayTranslateXSV,
    translateYSV: overlayTranslateYSV,
    containerWidthSV,
    containerHeightSV,
    hitTargets,
    // The picker opens on a single tap, so a long press routes to the same
    // handler (the hook falls back to onTap when onLongPress is omitted).
    onTap: onHoldTap,
    pinchRef,
    isPinchingSV,
  });

  const holdById = useMemo(() => {
    const map = new Map<number, BoardHoldTarget>();
    for (const hold of holdTargets) map.set(hold.id, hold);
    return map;
  }, [holdTargets]);

  const activeHighlight = useMemo(() => {
    if (activeHoldId == null || renderWidth <= 0) return null;
    const hold = holdById.get(activeHoldId);
    if (!hold) return null;
    const geometry = holdGeometry(hold, boardWidth, boardHeight, renderWidth, mirrored);
    const diameter = geometry.ringDiameter * 1.5;
    const radius = diameter / 2;
    return (
      <View
        pointerEvents="none"
        style={[
          styles.activeRing,
          {
            left: `${geometry.leftPct}%`,
            top: `${geometry.topPct}%`,
            width: diameter,
            height: diameter,
            marginLeft: -radius,
            marginTop: -radius,
            borderRadius: radius,
            borderWidth: Math.max(2.5, geometry.ringDiameter * 0.18),
          },
        ]}
      />
    );
  }, [activeHoldId, holdById, boardWidth, boardHeight, renderWidth, mirrored]);

  // With a viewport the clip is the viewport and the board is placed in it at
  // the offset, render-box sized, so the transform still scales about the
  // board's own centre. Without one the board fills the render-box clip.
  const clipWidth = viewport ? viewport.width : renderWidth;
  const clipHeight = viewport ? viewport.height : renderHeight;
  const boardBoxStyle: ViewStyle | null = viewport
    ? {
        position: 'absolute',
        left: viewport.offsetX,
        top: viewport.offsetY,
        width: renderWidth,
        height: renderHeight,
      }
    : null;

  return (
    <View style={styles.root}>
      <GestureDetector gesture={pinchGesture}>
        <View style={[styles.clip, { width: clipWidth, height: clipHeight }]}>
          <Animated.View style={[boardBoxStyle ?? styles.board, animatedZoomStyle]}>
            {backgroundPhotoUrl ? (
              <>
                <Image
                  source={{ uri: backgroundPhotoUrl }}
                  style={StyleSheet.absoluteFill}
                  contentFit="fill"
                  cachePolicy="memory"
                />
                {fullResolutionPhoto ? (
                  <FullResolutionPhotoLayer
                    photo={fullResolutionPhoto}
                    scaleSV={scaleSV}
                    onError={onFullResolutionPhotoError}
                  />
                ) : null}
              </>
            ) : (
              <BoardImageNative
                frames=""
                boardName={boardName}
                layoutId={layoutId}
                sizeId={sizeId}
                setIds={setIds}
                boardWidth={boardWidth}
                boardHeight={boardHeight}
                mirrored={mirrored}
                underOverlay={underOverlay}
              />
            )}
            {holdsFilter ? (
              <SearchHoldFilterRings
                boardName={boardName}
                holdsFilter={holdsFilter}
                holdTargets={holdTargets}
                boardWidth={boardWidth}
                boardHeight={boardHeight}
                measuredWidth={renderWidth}
                mirrored={mirrored}
              />
            ) : null}
            {activeHighlight}
            {!isZoomed && restHoldTapGesture ? (
              <GestureDetector gesture={restHoldTapGesture}>
                <View collapsable={false} style={StyleSheet.absoluteFill} />
              </GestureDetector>
            ) : null}
          </Animated.View>

          {/* 1-finger pan-to-reposition the zoomed board. Sits ABOVE the board
              layer (so a drag over the bare board pans it) but BELOW the
              `renderInTransform` overlay layer (so the zone rectangle + corner
              handles still win their touches while zoomed). In hold mode the
              gesture also resolves taps/long-presses to holds (Race with the
              pan) so the picker opens while zoomed (#2687); in zone mode
              `overlayGesture` is the bare pan (no onHoldTap). */}
          {isZoomed ? (
            <GestureDetector gesture={overlayGesture}>
              <View style={StyleSheet.absoluteFill}>
                {/* renderAboveBoard nests HERE, inside the pan's own view, so
                    this gesture is its ancestor and a declined touch falls
                    through to the pan / zoomed hold taps. See the prop's doc. */}
                {renderAboveBoard ? renderAboveBoard(transformContext) : null}
                {/* Nested for the same reason, and rendered after so it wins its
                    own taps: it sits in the corner the panning thumb rests in,
                    and as a sibling above the overlay it would be a dead zone
                    for panning. */}
                <ResetZoomButton visible onPress={resetZoom} style={resetZoomStyle ?? styles.resetZoom} />
              </View>
            </GestureDetector>
          ) : null}

          {/* Overlay rendered INSIDE the same zoom transform but ABOVE the
              pan-reset layer, so its gestures (e.g. the zone rectangle) receive
              touches even when zoomed. Its root is `pointerEvents="box-none"`,
              so taps on empty space fall through to the pan-reset layer below. */}
          {renderInTransform ? (
            <Animated.View
              pointerEvents="box-none"
              style={[boardBoxStyle ?? StyleSheet.absoluteFill, animatedZoomStyle]}
            >
              {renderInTransform(transformContext)}
            </Animated.View>
          ) : null}

          {/* At rest there is no pan overlay to nest inside, so the above-board
              overlay renders as a sibling here. The reset-zoom control is no
              longer one of its neighbours — it moved off the board entirely
              (#5113); the route renders it below the board via `controlRef`. */}
          {!isZoomed && renderAboveBoard ? renderAboveBoard(transformContext) : null}
        </View>
      </GestureDetector>
    </View>
  );
});

const styles = StyleSheet.create({
  root: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  clip: {
    overflow: 'hidden',
  },
  board: {
    width: '100%',
    height: '100%',
  },
  activeRing: {
    position: 'absolute',
    borderColor: '#FFFFFF',
  },
  // Bottom-right, matching every other board. See ResetZoomButton.
  resetZoom: {
    right: spacing[2],
    bottom: spacing[2],
  },
});
