import type { Detection, HoldCandidate } from './types';

/**
 * Turn merged detections into what the hold editor and the wall API store.
 *
 * `r` is the EQUIVALENT-CIRCLE radius: the radius of the circle whose area
 * matches the box, `sqrt(w * h / pi)`. Half the diagonal would grow with the
 * box's aspect and half the shorter side would shrink with it; the equal-area
 * radius is the one that says the same thing about a 40x40 jug and a 60x27 rail.
 *
 * ## Why there is no `outline`
 *
 * The model returns boxes, not masks. `ml/holds/eval.py` does have a classical
 * in-box segmentation (`segment_in_box`: median border colour, distance
 * threshold at the 60th percentile, largest connected component) — but it stops
 * at a boolean mask. There is no contour tracer and no simplifier on the Python
 * side to port, no corpus with mask ground truth to score one against
 * (`ml/holds/README.md`: "Mask IoU is not reported"), and the config the
 * committed expectations came from sets `produces_masks: false`. Inventing the
 * missing half here would ship ~250 lines of computer vision that no test could
 * ever contradict.
 *
 * So `outline` stays undefined and the renderer falls back to a ring, which is
 * what `docs/board-art-geometry.md` already does for a hold with no traced art.
 * The field is on {@link HoldCandidate} because SW-08's editor writes exactly
 * that shape when a climber re-traces a hold by hand.
 */
export function toHoldCandidates(detections: readonly Detection[]): HoldCandidate[] {
  return detections.map((detection) => {
    const [x0, y0, x1, y1] = detection.box;
    const width = Math.max(0, x1 - x0);
    const height = Math.max(0, y1 - y0);
    return {
      cx: (x0 + x1) / 2,
      cy: (y0 + y1) / 2,
      r: Math.sqrt((width * height) / Math.PI),
      score: detection.score,
    };
  });
}
