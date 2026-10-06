import React, { useMemo } from 'react';
import { StyleSheet } from 'react-native';
import Animated, { useAnimatedProps, useAnimatedReaction, type SharedValue } from 'react-native-reanimated';
import Svg, { Circle, Path } from 'react-native-svg';
import { overlays } from '../../theme/tokens';
import { useTheme } from '../../providers/theme-provider';
import { RING, useZoomStrokeStep } from './SprayHoldSvgLayer';
import { ringToPathData } from './stroke';
import { refineBrushRadiusAtZoom, type RefineBrushLimits, type RefineMode } from './spray-refine';

const AnimatedPath = Animated.createAnimatedComponent(Path);
const AnimatedCircle = Animated.createAnimatedComponent(Circle);

/** The area's fill, over the dimmed photo: strong enough to read as "this is the hold", thin enough to see the edge under it. */
const AREA_FILL_OPACITY = 0.35;
/** An Add stroke paints in the area's own colour, a touch stronger, so it reads as the area growing. */
const ADD_STROKE_OPACITY = 0.5;
/** An Erase stroke paints dark, so it reads as the area being cut away. */
const ERASE_STROKE_OPACITY = 0.7;

/** The brush-size ring's fill while the slider moves: enough to read the disc against the area's own fill. */
const SIZE_RING_FILL_OPACITY = 0.25;

/**
 * Nudge, in board px, that gives a single-sample dab a segment to cap. A path
 * of one `M` has no length and draws nothing even with round caps.
 */
const DAB_NUDGE_BOARD_PX = 0.01;

type SprayRefineLayerProps = {
  /** The area being refined, flat board px, implicitly closed. */
  outlineBoardPx: readonly number[];
  /** The live stroke in board px, written by `DrawStrokeOverlay`. */
  pointsSV: SharedValue<number[]>;
  mode: RefineMode;
  /** The picked brush size, in screen points: the slider's live value. */
  brushPtSV: SharedValue<number>;
  /** The board's zoom when the live stroke started (`DrawStrokeOverlay`'s `strokeZoomSV`). */
  strokeZoomSV: SharedValue<number>;
  /** The board's live zoom, for the size ring. */
  boardZoomSV: SharedValue<number>;
  /**
   * Gets a copy of `boardZoomSV` on the UI thread, for chrome outside the board
   * (the size dot by the slider), which cannot reach the board's own zoom.
   * Passed to the board's copy only, never the loupe's.
   */
  zoomMirrorSV?: SharedValue<number>;
  /** Board px per screen point at zoom 1 (`renderToBoardScale`). */
  boardPxPerPt: number;
  /** The hold's brush clamp (`refineBrushLimits`). */
  limits: RefineBrushLimits;
  /** The size ring's opacity: up while the slider moves, faded out after. */
  sizeRingOpacitySV: SharedValue<number>;
  /** Where the size ring sits, in board px: the hold's centre. */
  sizeRingX: number;
  sizeRingY: number;
  /** The zoom whose edge strokes this copy draws at — the board's, or the loupe's magnification. */
  scaleSV: SharedValue<number>;
  boardWidth: number;
  boardHeight: number;
  renderWidth: number;
  renderHeight: number;
};

/**
 * Refine's view of one hold, drawn inside the zoom transform: the hold as a
 * filled AREA with its edge, the live brush stroke over it, and — while the
 * size slider moves — a disc the size of the brush on the hold's centre, so the
 * size reads against the hold's real edge.
 *
 * The area is React state from the refine session and changes once per kept
 * stroke. The stroke is a shared value the draw overlay writes on the UI thread,
 * drawn as one round-capped path whose width is the brush DIAMETER in board px —
 * geometry, not a hairline, so it scales with the zoom and with the loupe exactly
 * like the photo under it, and covers exactly what the engine will paint. Its
 * radius is the picked size at the zoom the stroke STARTED at, clamped to the
 * hold (`refineBrushRadiusAtZoom`), the same number the commit uses. The size
 * disc uses the live zoom instead, so it shrinks on the hold as the board zooms
 * in. Nothing crosses to JS while a stroke is drawn.
 */
export const SprayRefineLayer = React.memo(function SprayRefineLayer({
  outlineBoardPx,
  pointsSV,
  mode,
  brushPtSV,
  strokeZoomSV,
  boardZoomSV,
  zoomMirrorSV,
  boardPxPerPt,
  limits,
  sizeRingOpacitySV,
  sizeRingX,
  sizeRingY,
  scaleSV,
  boardWidth,
  boardHeight,
  renderWidth,
  renderHeight,
}: SprayRefineLayerProps) {
  const { brandColors } = useTheme();
  const zoomStep = useZoomStrokeStep(scaleSV);
  const areaPath = useMemo(() => ringToPathData([...outlineBoardPx]), [outlineBoardPx]);
  const edgeWidth = RING.onWidth / zoomStep;
  const edgeHaloWidth = (RING.onWidth + RING.haloExtra) / zoomStep;

  useAnimatedReaction(
    () => boardZoomSV.value,
    (zoom) => {
      if (zoomMirrorSV) zoomMirrorSV.value = zoom;
    },
    [boardZoomSV, zoomMirrorSV],
  );

  const { floorBoardPx, capBoardPx } = limits;
  const strokeProps = useAnimatedProps(() => {
    'worklet';
    const points = pointsSV.value;
    const strokeWidth =
      refineBrushRadiusAtZoom(brushPtSV.value, boardPxPerPt, strokeZoomSV.value, floorBoardPx, capBoardPx) * 2;
    if (points.length < 2) return { d: '', strokeWidth };
    let path = `M${points[0]} ${points[1]}`;
    if (points.length < 4) {
      path += `L${points[0] + DAB_NUDGE_BOARD_PX} ${points[1]}`;
    } else {
      for (let index = 2; index < points.length; index += 2) {
        path += `L${points[index]} ${points[index + 1]}`;
      }
    }
    return { d: path, strokeWidth };
  });

  const sizeRingProps = useAnimatedProps(() => {
    'worklet';
    return {
      r: refineBrushRadiusAtZoom(brushPtSV.value, boardPxPerPt, boardZoomSV.value, floorBoardPx, capBoardPx),
      opacity: sizeRingOpacitySV.value,
    };
  });

  if (renderWidth <= 0 || renderHeight <= 0) return null;

  const strokeColor = mode === 'add' ? brandColors.primary : overlays.scrim;
  const strokeOpacity = mode === 'add' ? ADD_STROKE_OPACITY : ERASE_STROKE_OPACITY;

  return (
    <Svg
      pointerEvents="none"
      style={StyleSheet.absoluteFill}
      width={renderWidth}
      height={renderHeight}
      viewBox={`0 0 ${boardWidth} ${boardHeight}`}
    >
      <Path d={areaPath} fill={brandColors.primary} fillOpacity={AREA_FILL_OPACITY} stroke="none" />
      <Path
        d={areaPath}
        fill="none"
        stroke={overlays.scrim}
        strokeWidth={edgeHaloWidth}
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
      <Path
        d={areaPath}
        fill="none"
        stroke={overlays.onScrim}
        strokeWidth={edgeWidth}
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
      <AnimatedPath
        animatedProps={strokeProps}
        fill="none"
        stroke={strokeColor}
        strokeOpacity={strokeOpacity}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <AnimatedCircle
        animatedProps={sizeRingProps}
        cx={sizeRingX}
        cy={sizeRingY}
        fill={strokeColor}
        fillOpacity={SIZE_RING_FILL_OPACITY}
        stroke={overlays.onScrim}
        strokeWidth={edgeWidth}
        vectorEffect="non-scaling-stroke"
      />
    </Svg>
  );
});
