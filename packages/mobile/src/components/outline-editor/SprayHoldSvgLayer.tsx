import React, { useMemo } from 'react';
import { StyleSheet } from 'react-native';
import Animated, { useAnimatedProps, type SharedValue } from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';
import { placementRingPathData, radiusRingToBoardPx, ringToPathData } from './stroke';
import { isHiddenByThreshold, type SprayEditorHold } from './spray-hold-editor-reducer';

const AnimatedPath = Animated.createAnimatedComponent(Path);

/**
 * Below this confidence a candidate is drawn as "the detector was guessing".
 *
 * Separate from the slider's threshold, and it has to be: the slider is the
 * owner's own cut-off and moves, while this is a fixed reading of the detector's
 * scale. Without it, every candidate the slider currently shows would look
 * equally certain the moment the slider moved below it.
 */
export const LOW_CONFIDENCE_CEILING = 0.75;

/**
 * Role colours for the wall editor.
 *
 * Fixed rather than theme-derived, for the reason the catalogue editor's are
 * (`OUTLINE_EDITOR_COLORS`): these strokes sit over an arbitrary photograph of
 * somebody's garage, so they are chosen against wood and plastic rather than
 * against the app's surfaces. Velvet Send tokens still dress every pixel of the
 * chrome around the board — this is the board.
 */
export const SPRAY_EDITOR_COLORS = {
  /** A hold on the wall, drawn or corrected by a human. */
  manual: '#34D399',
  /** A hold on the wall that came from the detector and has been accepted. */
  accepted: '#5EEAD4',
  /** A candidate awaiting a verdict, and the detector was confident. */
  candidate: '#60A5FA',
  /** A candidate awaiting a verdict, and the detector was not. */
  lowConfidence: '#F59E0B',
  /** Under the tools right now. */
  selected: '#FFFFFF',
  /** The stroke under the finger. */
  draft: '#FDE047',
} as const;

const STROKE_WIDTH = {
  manual: 1.6,
  accepted: 1.4,
  candidate: 1.2,
  lowConfidence: 1.2,
  selected: 2.6,
  draft: 2.4,
} as const;

type SprayHoldSvgLayerProps = {
  /** Every hold in the editor, in id order. Hidden candidates are filtered here. */
  holds: readonly SprayEditorHold[];
  /** The slider's current cut-off. */
  threshold: number;
  selectedIds: readonly number[];
  /** The live stroke in board px, written by `DrawStrokeOverlay`. */
  draftPointsSV: SharedValue<number[]>;
  boardWidth: number;
  boardHeight: number;
  renderWidth: number;
  renderHeight: number;
};

/** A hold's boundary as an SVG subpath: its traced ring, or the circle at `r`. */
function holdPathData(hold: SprayEditorHold): string {
  const placement = { id: hold.id, cx: hold.cx, cy: hold.cy, r: hold.r };
  return hold.outline ? ringToPathData(radiusRingToBoardPx(hold.outline, placement)) : placementRingPathData(placement);
}

/**
 * Every hold on the wall, in one SVG.
 *
 * Concatenated by ROLE rather than per hold, exactly as `OutlineSvgLayer` does
 * and for the same reason: a wall may carry 1500 holds, and one `<Path>` each
 * would be 1500 native views to mount and diff on a phone. Five buckets plus the
 * selection plus the live stroke is seven nodes however big the wall is, and each
 * bucket rebuilds only when its own contents change.
 *
 * Coordinates are BOARD px — which on a wall are the photograph's own pixels —
 * mapped to the rendered box by the `viewBox`, so nothing here knows the zoom.
 */
export const SprayHoldSvgLayer = React.memo(function SprayHoldSvgLayer({
  holds,
  threshold,
  selectedIds,
  draftPointsSV,
  boardWidth,
  boardHeight,
  renderWidth,
  renderHeight,
}: SprayHoldSvgLayerProps) {
  const buckets = useMemo(() => {
    const manual: string[] = [];
    const accepted: string[] = [];
    const candidate: string[] = [];
    const lowConfidence: string[] = [];

    for (const hold of holds) {
      if (isHiddenByThreshold(hold, threshold)) continue;
      const path = holdPathData(hold);
      if (hold.review === 'pending') {
        ((hold.confidence ?? 0) < LOW_CONFIDENCE_CEILING ? lowConfidence : candidate).push(path);
      } else if (hold.source === 'AUTO') {
        accepted.push(path);
      } else {
        manual.push(path);
      }
    }

    return {
      manual: manual.join(''),
      accepted: accepted.join(''),
      candidate: candidate.join(''),
      lowConfidence: lowConfidence.join(''),
    };
  }, [holds, threshold]);

  // Drawn again on top in white so the selection reads over whichever role colour
  // it already carries. An O(1) Set rather than `includes` per hold: merge puts
  // two ids in here and a wall puts 1500 holds through the loop.
  const selectedPath = useMemo(() => {
    if (selectedIds.length === 0) return '';
    const wanted = new Set(selectedIds);
    return holds
      .filter((hold) => wanted.has(hold.id))
      .map(holdPathData)
      .join('');
  }, [holds, selectedIds]);

  const dashLength = Math.max(2, boardWidth / 300);

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
      <Path
        d={buckets.lowConfidence}
        fill="none"
        stroke={SPRAY_EDITOR_COLORS.lowConfidence}
        strokeWidth={STROKE_WIDTH.lowConfidence}
        strokeOpacity={0.9}
        strokeDasharray={[dashLength, dashLength * 2]}
        vectorEffect="non-scaling-stroke"
      />
      <Path
        d={buckets.candidate}
        fill="none"
        stroke={SPRAY_EDITOR_COLORS.candidate}
        strokeWidth={STROKE_WIDTH.candidate}
        strokeOpacity={0.9}
        strokeDasharray={[dashLength * 2, dashLength]}
        vectorEffect="non-scaling-stroke"
      />
      <Path
        d={buckets.accepted}
        fill="none"
        stroke={SPRAY_EDITOR_COLORS.accepted}
        strokeWidth={STROKE_WIDTH.accepted}
        vectorEffect="non-scaling-stroke"
      />
      <Path
        d={buckets.manual}
        fill="none"
        stroke={SPRAY_EDITOR_COLORS.manual}
        strokeWidth={STROKE_WIDTH.manual}
        vectorEffect="non-scaling-stroke"
      />
      <Path
        d={selectedPath}
        fill="none"
        stroke={SPRAY_EDITOR_COLORS.selected}
        strokeWidth={STROKE_WIDTH.selected}
        vectorEffect="non-scaling-stroke"
      />
      <AnimatedPath
        animatedProps={draftProps}
        fill="none"
        stroke={SPRAY_EDITOR_COLORS.draft}
        strokeWidth={STROKE_WIDTH.draft}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </Svg>
  );
});
