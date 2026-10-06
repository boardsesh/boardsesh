import React, { useMemo } from 'react';
import { StyleSheet } from 'react-native';
import Animated, { useAnimatedProps, type SharedValue } from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';
import { overlays } from '../../theme/tokens';
import { useTheme } from '../../providers/theme-provider';
import { RING, useZoomStrokeStep } from './SprayHoldSvgLayer';
import { ringToPathData } from './stroke';
import type { RefineMode } from './spray-refine';

const AnimatedPath = Animated.createAnimatedComponent(Path);

/** The area's fill, over the dimmed photo: strong enough to read as "this is the hold", thin enough to see the edge under it. */
const AREA_FILL_OPACITY = 0.35;
/** An Add stroke paints in the area's own colour, a touch stronger, so it reads as the area growing. */
const ADD_STROKE_OPACITY = 0.5;
/** An Erase stroke paints dark, so it reads as the area being cut away. */
const ERASE_STROKE_OPACITY = 0.7;

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
  /** The brush radius in screen points. */
  brushPt: number;
  /** The smallest radius the brush paints with, in board px (`refineBrushRadiusBoardPx`'s floor). */
  minBrushRadiusBoardPx: number;
  /** Board px per render px. */
  boardScale: number;
  /** The zoom whose ring strokes this copy draws at — the board's, or the loupe's magnification. */
  scaleSV: SharedValue<number>;
  /**
   * The BOARD's zoom, which sets the brush's size in board px. The same as
   * `scaleSV` on the board; the loupe's copy passes the board zoom its feed
   * recorded, so the brush it shows is the one the stroke paints with.
   */
  brushZoomSV: SharedValue<number>;
  boardWidth: number;
  boardHeight: number;
  renderWidth: number;
  renderHeight: number;
};

/**
 * Refine's view of one hold, drawn inside the zoom transform: the hold as a
 * filled AREA with its edge, and the live brush stroke over it.
 *
 * The area is React state from the refine session and changes once per kept
 * stroke. The stroke is a shared value the draw overlay writes on the UI thread,
 * drawn as one round-capped path whose width is the brush DIAMETER in board px —
 * geometry, not a hairline, so it scales with the zoom and with the loupe exactly
 * like the photo under it, and covers what the engine will paint. Its width is
 * worked out in the same worklet from the board's live zoom, so nothing crosses
 * to JS while a stroke is drawn.
 */
export const SprayRefineLayer = React.memo(function SprayRefineLayer({
  outlineBoardPx,
  pointsSV,
  mode,
  brushPt,
  minBrushRadiusBoardPx,
  boardScale,
  scaleSV,
  brushZoomSV,
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

  const strokeProps = useAnimatedProps(() => {
    'worklet';
    const points = pointsSV.value;
    const zoom = Math.max(brushZoomSV.value, 1e-6);
    const radius = Math.max((brushPt * boardScale) / zoom, minBrushRadiusBoardPx);
    if (points.length < 2) return { d: '', strokeWidth: radius * 2 };
    let path = `M${points[0]} ${points[1]}`;
    if (points.length < 4) {
      path += `L${points[0] + DAB_NUDGE_BOARD_PX} ${points[1]}`;
    } else {
      for (let index = 2; index < points.length; index += 2) {
        path += `L${points[index]} ${points[index + 1]}`;
      }
    }
    return { d: path, strokeWidth: radius * 2 };
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
    </Svg>
  );
});
