import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  runOnJS,
  useAnimatedProps,
  useAnimatedReaction,
  useDerivedValue,
  useSharedValue,
  type SharedValue,
} from 'react-native-reanimated';
import Svg, { G, Path, type PathProps } from 'react-native-svg';
import { overlays } from '../../theme/tokens';
import { useTheme } from '../../providers/theme-provider';
import type { SprayEditorHold } from './spray-hold-editor-reducer';
import { EMPTY_SPRAY_HOLD_PATH_CHUNKS, reconcileSprayHoldPathChunks } from './spray-hold-path-chunks';
import { useSprayLoupeVisibleHolds } from './spray-loupe-viewport';
import { CORNERS_CLOSE_EXTENT_FRACTION, CORNERS_CLOSE_TARGET_PT } from './spray-hold-tools';

const AnimatedPath = Animated.createAnimatedComponent(Path);
const AnimatedG = Animated.createAnimatedComponent(G);

/**
 * The zoom levels the ring strokes are re-thickened at.
 *
 * The rings live inside the board's zoom transform, and a reanimated `scale`
 * magnifies a stroke exactly as it magnifies the photo — `vectorEffect` cancels
 * the SVG's own viewBox scale, not a transform applied to the view around it. So
 * every stroke width is divided by the current zoom. Snapped to seven steps
 * rather than tracked live so a pinch across the editor's whole 1x–8x range
 * re-renders the layer at most six times instead of every frame; between steps
 * a ring runs at most 1.5x its intended weight, which is not something a thumb
 * on a photo can see.
 */
export const ZOOM_STROKE_STEPS = [1, 1.5, 2, 3, 4, 6, 8] as const;

/** The step a live zoom scale snaps to. Worklet-callable. */
export function zoomStrokeStep(scale: number): number {
  'worklet';
  let step: number = ZOOM_STROKE_STEPS[0];
  for (const candidate of ZOOM_STROKE_STEPS) {
    if (scale >= candidate) step = candidate;
  }
  return step;
}

/**
 * Ring styles, in SCREEN points at 1x zoom (`vectorEffect="non-scaling-stroke"`
 * strokes and dashes in the SVG's client space, so these are points, not photo
 * pixels, on both platforms).
 *
 * Hue backs the state up; the line pattern carries it, because the wall behind
 * is a photograph of multicoloured plastic and any single hue disappears on
 * some of it. ON is solid white over a dark halo, a MAYBE is a dashed accent
 * over the same halo, OFF is a faint dotted white ghost with no halo at all.
 */
export const RING = {
  onWidth: 2,
  maybeWidth: 2,
  /** How much wider the dark halo is than the line it sits under. */
  haloExtra: 2,
  offWidth: 1.5,
  offOpacity: 0.4,
  draftWidth: 2.5,
  maybeDash: [5, 4],
  offDash: [1, 4],
  /** The Corners tool's placed-corner dots, as a radius. */
  cornerDotRadius: 3.5,
  /** The ring round the first corner once the polygon can close, as a radius. */
  closeTargetRadius: CORNERS_CLOSE_TARGET_PT,
  /** The not-yet-committed closing edge, last corner back to the first. */
  closingDash: [6, 4],
} as const;

type SprayHoldSvgLayerProps = {
  /** Every hold in the editor, in id order. */
  holds: readonly SprayEditorHold[];
  /** Draw the maybes at all. Off while the climber has hidden them. */
  showMaybes: boolean;
  /**
   * The hold `SelectedHoldOverlay` is drawing, or null. Drawn here only as the
   * faint OFF ghost, so the ring the overlay moves is the one ring at full
   * strength: at rest the overlay's ring sits over the ghost, and during a drag
   * the ghost marks where the hold came from.
   */
  selectedId: number | null;
  /**
   * The maybes' opacity, 0–1. The reveal fades them in after the ON rings have
   * swept in; one group's opacity on the UI thread, never a re-render.
   */
  maybeOpacitySV: SharedValue<number>;
  /** The live stroke in board px, written by `DrawStrokeOverlay` during Trace. */
  draftPointsSV: SharedValue<number[]>;
  /**
   * The Corners tool's placed corners in board px, flat `[x0, y0, ...]`, written
   * by `PolygonTapOverlay`. Omitted, the corners preview is not mounted at all.
   */
  polygonSV?: SharedValue<number[]>;
  /** The board's live zoom, from `FilterBoardTransformContext`. Strokes are drawn thinner by it. */
  scaleSV: SharedValue<number>;
  /**
   * The zoom the Corners dots and close target are sized by, when it is not
   * `scaleSV`. The loupe draws its copy at its own magnification (`scaleSV`, so
   * its strokes stay hairlines) but the close target must cover what
   * `PolygonTapOverlay` tests on the board, which is set by the BOARD's zoom.
   */
  geometryScaleSV?: SharedValue<number>;
  boardWidth: number;
  boardHeight: number;
  renderWidth: number;
  renderHeight: number;
};

/**
 * Separate native SVG roots keep live-point invalidation away from committed
 * rings. Each committed path covers at most 32 holds, so a completed edit does
 * not send one wall-sized string back through RNSVGPathParser.
 */
export const SprayHoldSvgLayer = React.memo(function SprayHoldSvgLayer(props: SprayHoldSvgLayerProps) {
  if (props.renderWidth <= 0 || props.renderHeight <= 0) return null;
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <SprayCommittedHoldSvgLayer
        holds={props.holds}
        showMaybes={props.showMaybes}
        selectedId={props.selectedId}
        maybeOpacitySV={props.maybeOpacitySV}
        scaleSV={props.scaleSV}
        boardWidth={props.boardWidth}
        boardHeight={props.boardHeight}
        renderWidth={props.renderWidth}
        renderHeight={props.renderHeight}
      />
      <SprayLiveHoldSvgLayer
        draftPointsSV={props.draftPointsSV}
        polygonSV={props.polygonSV}
        scaleSV={props.scaleSV}
        geometryScaleSV={props.geometryScaleSV}
        boardWidth={props.boardWidth}
        boardHeight={props.boardHeight}
        renderWidth={props.renderWidth}
        renderHeight={props.renderHeight}
      />
    </View>
  );
});

/** Unchanged strings/styles must not enter native updateProps (which reparses d). */
const CommittedPath = React.memo(function CommittedPath(props: PathProps) {
  return <Path {...props} />;
});

type CommittedProps = Pick<
  SprayHoldSvgLayerProps,
  | 'holds'
  | 'showMaybes'
  | 'selectedId'
  | 'maybeOpacitySV'
  | 'scaleSV'
  | 'boardWidth'
  | 'boardHeight'
  | 'renderWidth'
  | 'renderHeight'
>;

const SprayCommittedHoldSvgLayer = React.memo(function SprayCommittedHoldSvgLayer({
  holds,
  showMaybes,
  selectedId,
  maybeOpacitySV,
  scaleSV,
  boardWidth,
  boardHeight,
  renderWidth,
  renderHeight,
}: CommittedProps) {
  const { brandColors } = useTheme();
  const zoomStep = useZoomStrokeStep(scaleSV);
  const visibleHolds = useSprayLoupeVisibleHolds(holds, boardWidth, boardHeight);
  const committedChunksRef = useRef(EMPTY_SPRAY_HOLD_PATH_CHUNKS);
  const pathChunks = useMemo(
    () => reconcileSprayHoldPathChunks(committedChunksRef.current, visibleHolds, selectedId),
    [visibleHolds, selectedId],
  );
  useLayoutEffect(() => {
    committedChunksRef.current = pathChunks;
  }, [pathChunks]);
  const stroke = useMemo(
    () => ({
      on: RING.onWidth / zoomStep,
      onHalo: (RING.onWidth + RING.haloExtra) / zoomStep,
      maybe: RING.maybeWidth / zoomStep,
      maybeHalo: (RING.maybeWidth + RING.haloExtra) / zoomStep,
      off: RING.offWidth / zoomStep,
      maybeDash: RING.maybeDash.map((points) => points / zoomStep),
      offDash: RING.offDash.map((points) => points / zoomStep),
    }),
    [zoomStep],
  );
  const maybeGroupProps = useAnimatedProps(() => ({ opacity: maybeOpacitySV.value }));
  const chunks = pathChunks.chunks;
  return (
    <Svg
      pointerEvents="none"
      style={StyleSheet.absoluteFill}
      width={renderWidth}
      height={renderHeight}
      viewBox={`0 0 ${boardWidth} ${boardHeight}`}
    >
      {chunks.map((chunk) =>
        chunk.off ? (
          <CommittedPath
            key={`off-${chunk.key}`}
            d={chunk.off}
            fill="none"
            stroke={overlays.onScrim}
            strokeOpacity={RING.offOpacity}
            strokeWidth={stroke.off}
            strokeDasharray={stroke.offDash}
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        ) : null,
      )}
      <AnimatedG animatedProps={maybeGroupProps}>
        {showMaybes
          ? chunks.map((chunk) =>
              chunk.maybe ? (
                <CommittedPath
                  key={`maybe-halo-${chunk.key}`}
                  d={chunk.maybe}
                  fill="none"
                  stroke={overlays.scrim}
                  strokeWidth={stroke.maybeHalo}
                  strokeDasharray={stroke.maybeDash}
                  vectorEffect="non-scaling-stroke"
                />
              ) : null,
            )
          : null}
        {showMaybes
          ? chunks.map((chunk) =>
              chunk.maybe ? (
                <CommittedPath
                  key={`maybe-line-${chunk.key}`}
                  d={chunk.maybe}
                  fill="none"
                  stroke={brandColors.accent}
                  strokeWidth={stroke.maybe}
                  strokeDasharray={stroke.maybeDash}
                  vectorEffect="non-scaling-stroke"
                />
              ) : null,
            )
          : null}
      </AnimatedG>
      {chunks.map((chunk) =>
        chunk.on ? (
          <CommittedPath
            key={`on-halo-${chunk.key}`}
            d={chunk.on}
            fill="none"
            stroke={overlays.scrim}
            strokeWidth={stroke.onHalo}
            vectorEffect="non-scaling-stroke"
          />
        ) : null,
      )}
      {chunks.map((chunk) =>
        chunk.on ? (
          <CommittedPath
            key={`on-line-${chunk.key}`}
            d={chunk.on}
            fill="none"
            stroke={overlays.onScrim}
            strokeWidth={stroke.on}
            vectorEffect="non-scaling-stroke"
          />
        ) : null,
      )}
    </Svg>
  );
});

type LiveProps = Pick<
  SprayHoldSvgLayerProps,
  | 'draftPointsSV'
  | 'polygonSV'
  | 'scaleSV'
  | 'geometryScaleSV'
  | 'boardWidth'
  | 'boardHeight'
  | 'renderWidth'
  | 'renderHeight'
>;

const SprayLiveHoldSvgLayer = React.memo(function SprayLiveHoldSvgLayer({
  draftPointsSV,
  polygonSV,
  scaleSV,
  geometryScaleSV,
  boardWidth,
  boardHeight,
  renderWidth,
  renderHeight,
}: LiveProps) {
  const { brandColors } = useTheme();
  const zoomStep = useZoomStrokeStep(scaleSV);
  const geometryZoomStep = useZoomStrokeStep(geometryScaleSV ?? scaleSV);

  // Arrays and widths memoised on the step, so a render that did not move the
  // zoom hands react-native-svg the same prop identities to diff.
  const stroke = useMemo(() => {
    const scaled = (points: number) => points / zoomStep;
    return {
      on: scaled(RING.onWidth),
      onHalo: scaled(RING.onWidth + RING.haloExtra),
      maybe: scaled(RING.maybeWidth),
      maybeHalo: scaled(RING.maybeWidth + RING.haloExtra),
      off: scaled(RING.offWidth),
      draft: scaled(RING.draftWidth),
      draftHalo: scaled(RING.draftWidth + RING.haloExtra),
      maybeDash: RING.maybeDash.map(scaled),
      offDash: RING.offDash.map(scaled),
      closingDash: RING.closingDash.map(scaled),
    };
  }, [zoomStep]);

  // Plain numbers for the worklet to capture, rather than the RING object.
  const { dotRadius, targetRadius } = cornerMarkRadii(boardWidth, renderWidth, geometryZoomStep);
  const closeExtentFraction = CORNERS_CLOSE_EXTENT_FRACTION;
  const fallbackPolygonSV = useSharedValue<number[]>([]);
  const cornersSV = polygonSV ?? fallbackPolygonSV;
  // Every Corners sub-path in one worklet pass per change, on the UI thread —
  // the four animated props below only read their own string out of it.
  const cornerPaths = useDerivedValue(() => {
    'worklet';
    const corners = cornersSV.value;
    const count = Math.floor(corners.length / 2);
    if (count === 0) return { edges: '', closing: '', dots: '', target: '' };
    let edges = '';
    if (count >= 2) {
      edges = `M${corners[0]} ${corners[1]}`;
      for (let index = 2; index < count * 2; index += 2) {
        edges += `L${corners[index]} ${corners[index + 1]}`;
      }
    }
    let dots = '';
    for (let index = 0; index < count * 2; index += 2) {
      const left = corners[index] - dotRadius;
      dots += `M${left} ${corners[index + 1]}a${dotRadius} ${dotRadius} 0 1 0 ${dotRadius * 2} 0a${dotRadius} ${dotRadius} 0 1 0 ${-dotRadius * 2} 0Z`;
    }
    let closing = '';
    let target = '';
    if (count >= 3) {
      closing = `M${corners[count * 2 - 2]} ${corners[count * 2 - 1]}L${corners[0]} ${corners[1]}`;
      // Drawn exactly as big as PolygonTapOverlay's close radius — see there.
      let farthestSquared = 0;
      for (let index = 2; index < count * 2; index += 2) {
        const spanX = corners[index] - corners[0];
        const spanY = corners[index + 1] - corners[1];
        farthestSquared = Math.max(farthestSquared, spanX * spanX + spanY * spanY);
      }
      const radius = Math.min(targetRadius, closeExtentFraction * Math.sqrt(farthestSquared));
      target = `M${corners[0] - radius} ${corners[1]}a${radius} ${radius} 0 1 0 ${radius * 2} 0a${radius} ${radius} 0 1 0 ${-radius * 2} 0Z`;
    }
    return { edges, closing, dots, target };
  }, [cornersSV, dotRadius, targetRadius, closeExtentFraction]);
  const cornerEdgesProps = useAnimatedProps(() => ({ d: cornerPaths.value.edges }));
  const cornerClosingProps = useAnimatedProps(() => ({ d: cornerPaths.value.closing }));
  const cornerDotsProps = useAnimatedProps(() => ({ d: cornerPaths.value.dots }));
  const cornerTargetProps = useAnimatedProps(() => ({ d: cornerPaths.value.target }));

  const draftProps = useAnimatedProps(() => {
    'worklet';
    const points = draftPointsSV.value;
    if (points.length < 4) return { d: '' };
    let path = `M${points[0]} ${points[1]}`;
    for (let index = 2; index < points.length; index += 2) {
      path += `L${points[index]} ${points[index + 1]}`;
    }
    return { d: path };
  });

  if (renderWidth <= 0 || renderHeight <= 0) return null;

  return (
    <Svg
      pointerEvents="none"
      style={StyleSheet.absoluteFill}
      width={renderWidth}
      height={renderHeight}
      viewBox={`0 0 ${boardWidth} ${boardHeight}`}
    >
      <AnimatedPath
        animatedProps={draftProps}
        fill="none"
        stroke={overlays.scrim}
        strokeWidth={stroke.draftHalo}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
      <AnimatedPath
        animatedProps={draftProps}
        fill="none"
        stroke={overlays.onScrim}
        strokeWidth={stroke.draft}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
      {polygonSV ? (
        <>
          <AnimatedPath
            animatedProps={cornerEdgesProps}
            fill="none"
            stroke={overlays.scrim}
            strokeWidth={stroke.draftHalo}
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
          <AnimatedPath
            animatedProps={cornerEdgesProps}
            fill="none"
            stroke={overlays.onScrim}
            strokeWidth={stroke.draft}
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
          <AnimatedPath
            animatedProps={cornerClosingProps}
            fill="none"
            stroke={overlays.scrim}
            strokeWidth={stroke.draftHalo}
            strokeDasharray={stroke.closingDash}
            vectorEffect="non-scaling-stroke"
          />
          <AnimatedPath
            animatedProps={cornerClosingProps}
            fill="none"
            stroke={overlays.onScrim}
            strokeWidth={stroke.draft}
            strokeDasharray={stroke.closingDash}
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
          <AnimatedPath
            animatedProps={cornerTargetProps}
            fill="none"
            stroke={overlays.scrim}
            strokeWidth={stroke.onHalo}
            vectorEffect="non-scaling-stroke"
          />
          <AnimatedPath
            animatedProps={cornerTargetProps}
            fill="none"
            stroke={brandColors.accent}
            strokeWidth={stroke.on}
            vectorEffect="non-scaling-stroke"
          />
          <AnimatedPath
            animatedProps={cornerDotsProps}
            fill={overlays.onScrim}
            stroke={overlays.scrim}
            strokeWidth={stroke.off}
            vectorEffect="non-scaling-stroke"
          />
        </>
      ) : null}
    </Svg>
  );
});

/**
 * The Corners dots and close target as radii in board px, at a zoom already
 * snapped to a {@link ZOOM_STROKE_STEPS} step.
 *
 * They are GEOMETRY, not stroke, so vectorEffect does nothing for them: points
 * go to board px through the viewBox (board px per render px) and the zoom.
 * At a step zoom the target is exactly `PolygonTapOverlay`'s close radius
 * (`CORNERS_CLOSE_TARGET_PT * boardScale / zoom`).
 */
export function cornerMarkRadii(
  boardWidth: number,
  renderWidth: number,
  zoomStep: number,
): { dotRadius: number; targetRadius: number } {
  const boardPxPerPoint = renderWidth > 0 ? boardWidth / renderWidth / zoomStep : 0;
  return {
    dotRadius: RING.cornerDotRadius * boardPxPerPoint,
    targetRadius: RING.closeTargetRadius * boardPxPerPoint,
  };
}

/**
 * The live zoom, snapped to {@link ZOOM_STROKE_STEPS}, as React state.
 *
 * `runOnJS` fires only when the snapped step changes — at most six times per
 * pinch — never per frame.
 */
export function useZoomStrokeStep(scaleSV: SharedValue<number>): number {
  const [step, setStep] = useState(1);
  useAnimatedReaction(
    () => zoomStrokeStep(scaleSV.value),
    (current, previous) => {
      if (current !== previous) runOnJS(setStep)(current);
    },
    [scaleSV],
  );
  return step;
}
