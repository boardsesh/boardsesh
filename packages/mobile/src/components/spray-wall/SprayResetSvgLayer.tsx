import React, { useMemo } from 'react';
import { StyleSheet } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { placementRingPathData, radiusRingToBoardPx, ringToPathData } from '../outline-editor/stroke';
import type { SprayPhotoHold } from '../../lib/spray/spray-hold-geometry';
import {
  detectionPassesFilter,
  holdPassesFilter,
  holdRingRole,
  type ResetDetection,
  type ResetReviewState,
} from './reset-review-machine';

/**
 * Role colours for the compare view.
 *
 * Fixed rather than theme-derived, for the same reason `SPRAY_EDITOR_COLORS` is:
 * these strokes sit over an arbitrary photograph of somebody's garage, so they
 * are chosen against wood and plastic rather than against the app's surfaces.
 * Velvet Send dresses every pixel of the chrome around the board — this is the
 * board.
 *
 * The four verdicts are also distinguished by DASH PATTERN, not colour alone:
 * kept is solid, removed is a long dash, new is a short dash, unsure is dotted.
 * A reset is a decision made from these rings, and a colour-blind owner has to
 * be able to make it.
 */
export const SPRAY_RESET_COLORS = {
  /** Still on the wall. */
  kept: '#34D399',
  /** Coming off the wall when this commits. */
  removed: '#F87171',
  /** Going on the wall when this commits. */
  added: '#60A5FA',
  /** Kept, but a second detection was nearly as good a match — worth a look. */
  lowConfidence: '#F59E0B',
  /** A detection the owner has said no to. Drawn faint so "no" is visible, not invisible. */
  rejected: '#9CA3AF',
  /** Under the finger right now. */
  selected: '#FFFFFF',
  /** Links a new hold to the one it replaced. */
  move: '#C084FC',
} as const;

const STROKE_WIDTH = {
  kept: 1.4,
  removed: 2,
  added: 1.8,
  lowConfidence: 1.8,
  rejected: 1,
  selected: 2.8,
  move: 1.4,
} as const;

type SprayResetSvgLayerProps = {
  /** The holds on the wall today, already in the NEW photo's pixels. */
  holds: readonly SprayPhotoHold[];
  detections: readonly ResetDetection[];
  review: ResetReviewState;
  /** The ring under the tools: a hold id, or a negative `-(index + 1)` detection. */
  selectedKey: number | null;
  boardWidth: number;
  boardHeight: number;
  renderWidth: number;
  renderHeight: number;
};

type Circle = { id: number; cx: number; cy: number; r: number };

function ringPath(hold: Circle, outline?: readonly number[] | null): string {
  return outline ? ringToPathData(radiusRingToBoardPx([...outline], hold)) : placementRingPathData(hold);
}

/**
 * Every ring in the compare view, in one SVG.
 *
 * Concatenated by ROLE rather than per ring, exactly as `SprayHoldSvgLayer` does
 * and for the same reason: a wall may carry 1500 holds and a photo as many
 * detections, and one `<Path>` each would be three thousand native views to
 * mount and diff on a phone. Six buckets plus the selection plus the move
 * leaders is eight nodes however big the wall is, and each bucket rebuilds only
 * when its own contents change.
 *
 * Coordinates are the NEW photograph's own pixels, mapped to the rendered box by
 * the `viewBox`, so nothing here knows the zoom.
 */
export const SprayResetSvgLayer = React.memo(function SprayResetSvgLayer({
  holds,
  detections,
  review,
  selectedKey,
  boardWidth,
  boardHeight,
  renderWidth,
  renderHeight,
}: SprayResetSvgLayerProps) {
  /**
   * Holds by id, built once and shared.
   *
   * Two consumers — the move leader lines and the selection ring — and both used
   * to scan. A wall may carry 1500 holds, and the selection ring is rebuilt on
   * every tap, so `holds.find()` there was a linear scan per tap on the largest
   * thing on screen. Memoised on `holds` alone, which only changes when the wall
   * does, so a tap and a filter change both reuse it.
   */
  const holdById = useMemo(() => {
    const byId = new Map<number, SprayPhotoHold>();
    for (const hold of holds) byId.set(hold.id, hold);
    return byId;
  }, [holds]);

  const buckets = useMemo(() => {
    const kept: string[] = [];
    const removed: string[] = [];
    const lowConfidence: string[] = [];
    const added: string[] = [];
    const rejected: string[] = [];

    for (const hold of holds) {
      if (!holdPassesFilter(review, hold.id)) continue;
      const role = holdRingRole(review, hold.id);
      if (!role) continue;
      const path = ringPath(hold, hold.outline);
      if (role === 'removed') removed.push(path);
      else if (role === 'lowConfidence') lowConfidence.push(path);
      else kept.push(path);
    }

    const leaders: string[] = [];
    detections.forEach((detection, index) => {
      if (!detectionPassesFilter(review, index)) return;
      const circle: Circle = { id: index, cx: detection.photo.cx, cy: detection.photo.cy, r: detection.photo.r };
      const path = ringPath(circle, detection.photo.outline);
      if (review.detectionVerdicts[index] === 'added') added.push(path);
      else rejected.push(path);

      // A confirmed pairing gets a line from the hold that came off to the hold
      // that replaced it. It is the only thing on screen that says the two are
      // one story rather than a coincidence of position.
      const movedFromHoldId = review.moves[index];
      if (movedFromHoldId == null) return;
      const predecessor = holdById.get(movedFromHoldId);
      if (!predecessor) return;
      leaders.push(`M${predecessor.cx} ${predecessor.cy}L${circle.cx} ${circle.cy}`);
    });

    return {
      kept: kept.join(''),
      removed: removed.join(''),
      lowConfidence: lowConfidence.join(''),
      added: added.join(''),
      rejected: rejected.join(''),
      leaders: leaders.join(''),
    };
  }, [holds, holdById, detections, review]);

  // Drawn again on top in white so the selection reads over whichever role colour
  // it already carries. A detection is keyed `-(index + 1)` so one number can
  // name either side without a tagged union in a hot path.
  const selectedPath = useMemo(() => {
    if (selectedKey == null) return '';
    if (selectedKey >= 0) {
      const hold = holdById.get(selectedKey);
      return hold ? ringPath(hold, hold.outline) : '';
    }
    const detection = detections[-selectedKey - 1];
    if (!detection) return '';
    return ringPath(
      { id: 0, cx: detection.photo.cx, cy: detection.photo.cy, r: detection.photo.r },
      detection.photo.outline,
    );
  }, [selectedKey, holdById, detections]);

  const dash = Math.max(2, boardWidth / 300);

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
        d={buckets.rejected}
        fill="none"
        stroke={SPRAY_RESET_COLORS.rejected}
        strokeWidth={STROKE_WIDTH.rejected}
        strokeOpacity={0.5}
        strokeDasharray={[dash, dash]}
        vectorEffect="non-scaling-stroke"
      />
      <Path
        d={buckets.kept}
        fill="none"
        stroke={SPRAY_RESET_COLORS.kept}
        strokeWidth={STROKE_WIDTH.kept}
        vectorEffect="non-scaling-stroke"
      />
      <Path
        d={buckets.lowConfidence}
        fill="none"
        stroke={SPRAY_RESET_COLORS.lowConfidence}
        strokeWidth={STROKE_WIDTH.lowConfidence}
        strokeDasharray={[dash * 0.5, dash * 1.5]}
        vectorEffect="non-scaling-stroke"
      />
      <Path
        d={buckets.removed}
        fill="none"
        stroke={SPRAY_RESET_COLORS.removed}
        strokeWidth={STROKE_WIDTH.removed}
        strokeDasharray={[dash * 3, dash * 1.5]}
        vectorEffect="non-scaling-stroke"
      />
      <Path
        d={buckets.added}
        fill="none"
        stroke={SPRAY_RESET_COLORS.added}
        strokeWidth={STROKE_WIDTH.added}
        strokeDasharray={[dash * 1.5, dash]}
        vectorEffect="non-scaling-stroke"
      />
      <Path
        d={buckets.leaders}
        fill="none"
        stroke={SPRAY_RESET_COLORS.move}
        strokeWidth={STROKE_WIDTH.move}
        strokeDasharray={[dash, dash]}
        vectorEffect="non-scaling-stroke"
      />
      <Path
        d={selectedPath}
        fill="none"
        stroke={SPRAY_RESET_COLORS.selected}
        strokeWidth={STROKE_WIDTH.selected}
        vectorEffect="non-scaling-stroke"
      />
    </Svg>
  );
});
