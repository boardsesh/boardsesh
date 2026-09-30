import React, { useMemo, useState } from 'react';
import { StyleSheet } from 'react-native';
import Animated, { runOnJS, useAnimatedProps, useAnimatedReaction, type SharedValue } from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';
import { overlays } from '../../theme/tokens';
import { useTheme } from '../../providers/theme-provider';
import { holdRole, type SprayEditorHold } from './spray-hold-editor-reducer';
import { holdPathData } from './spray-hold-path';

const AnimatedPath = Animated.createAnimatedComponent(Path);

/**
 * The zoom levels the ring strokes are re-thickened at.
 *
 * The rings live inside the board's zoom transform, and a reanimated `scale`
 * magnifies a stroke exactly as it magnifies the photo — `vectorEffect` cancels
 * the SVG's own viewBox scale, not a transform applied to the view around it. So
 * every stroke width is divided by the current zoom. Snapped to five steps
 * rather than tracked live so a pinch re-renders the layer at most four times
 * instead of every frame; between steps a ring runs at most 1.5x its intended
 * weight, which is not something a thumb on a photo can see.
 */
export const ZOOM_STROKE_STEPS = [1, 1.5, 2, 3, 4] as const;

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
const RING = {
  onWidth: 2,
  maybeWidth: 2,
  /** How much wider the dark halo is than the line it sits under. */
  haloExtra: 2,
  offWidth: 1.5,
  offOpacity: 0.4,
  draftWidth: 2.5,
  maybeDash: [5, 4],
  offDash: [1, 4],
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
  /** The live stroke in board px, written by `DrawStrokeOverlay` during Trace. */
  draftPointsSV: SharedValue<number[]>;
  /** The board's live zoom, from `FilterBoardTransformContext`. */
  scaleSV: SharedValue<number>;
  boardWidth: number;
  boardHeight: number;
  renderWidth: number;
  renderHeight: number;
};

/**
 * Every hold on the wall, in one SVG.
 *
 * Concatenated by ROLE rather than per hold, exactly as `OutlineSvgLayer` does
 * and for the same reason: a wall may carry 1500 holds, and one `<Path>` each
 * would be 1500 native views to mount and diff on a phone. Three roles, two of
 * them doubled for the halo, plus the live Trace stroke is six nodes however big
 * the wall is. Each hold's path string is built only when the holds change; a
 * selection only re-joins the buckets, moving the selected hold into the OFF
 * bucket as a ghost while `SelectedHoldOverlay` draws its ring.
 *
 * Coordinates are BOARD px — which on a wall are the photograph's own pixels —
 * mapped to the rendered box by the `viewBox`.
 */
export const SprayHoldSvgLayer = React.memo(function SprayHoldSvgLayer({
  holds,
  showMaybes,
  selectedId,
  draftPointsSV,
  scaleSV,
  boardWidth,
  boardHeight,
  renderWidth,
  renderHeight,
}: SprayHoldSvgLayerProps) {
  const { brandColors } = useTheme();
  const zoomStep = useZoomStrokeStep(scaleSV);

  // The expensive half — one path string per hold — keyed on the holds alone,
  // so a selection on a 1500-hold wall only re-joins strings.
  const holdPaths = useMemo(
    () => holds.map((hold) => ({ id: hold.id, role: holdRole(hold), path: holdPathData(hold) })),
    [holds],
  );

  const buckets = useMemo(() => {
    const on: string[] = [];
    const maybe: string[] = [];
    const off: string[] = [];
    for (const { id, role, path } of holdPaths) {
      // The selected hold is a ghost whatever its role: its real ring is the
      // overlay's, and drawing both would show two rings mid-drag.
      if (id === selectedId || role === 'off') off.push(path);
      else if (role === 'on') on.push(path);
      else maybe.push(path);
    }
    return { on: on.join(''), maybe: maybe.join(''), off: off.join('') };
  }, [holdPaths, selectedId]);

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
    };
  }, [zoomStep]);

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

  const maybePath = showMaybes ? buckets.maybe : '';

  return (
    <Svg
      pointerEvents="none"
      style={StyleSheet.absoluteFill}
      width={renderWidth}
      height={renderHeight}
      viewBox={`0 0 ${boardWidth} ${boardHeight}`}
    >
      <Path
        d={buckets.off}
        fill="none"
        stroke={overlays.onScrim}
        strokeOpacity={RING.offOpacity}
        strokeWidth={stroke.off}
        strokeDasharray={stroke.offDash}
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
      <Path
        d={maybePath}
        fill="none"
        stroke={overlays.scrim}
        strokeWidth={stroke.maybeHalo}
        strokeDasharray={stroke.maybeDash}
        vectorEffect="non-scaling-stroke"
      />
      <Path
        d={maybePath}
        fill="none"
        stroke={brandColors.accent}
        strokeWidth={stroke.maybe}
        strokeDasharray={stroke.maybeDash}
        vectorEffect="non-scaling-stroke"
      />
      <Path
        d={buckets.on}
        fill="none"
        stroke={overlays.scrim}
        strokeWidth={stroke.onHalo}
        vectorEffect="non-scaling-stroke"
      />
      <Path
        d={buckets.on}
        fill="none"
        stroke={overlays.onScrim}
        strokeWidth={stroke.on}
        vectorEffect="non-scaling-stroke"
      />
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
    </Svg>
  );
});

/**
 * The live zoom, snapped to {@link ZOOM_STROKE_STEPS}, as React state.
 *
 * `runOnJS` fires only when the snapped step changes — at most four times per
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
