import type { Detection, HoldCandidate } from './types';

/**
 * Turn merged detections into what the hold editor and the wall API store.
 *
 * `r` is the EQUIVALENT-CIRCLE radius: the radius of the circle whose area
 * matches the box, `sqrt(w * h / pi)`. Half the diagonal would grow with the
 * box's aspect and half the shorter side would shrink with it; the equal-area
 * radius is the one that says the same thing about a 40x40 jug and a 60x27 rail.
 *
 * ## Where `outline` comes from
 *
 * A detection-only model has none, and this used to be the whole story: boxes in,
 * circles out, and the renderer falling back to a ring exactly as
 * `docs/board-art-geometry.md` already does for a catalogue hold with no traced
 * art. A segmentation config (`mask_source: "model"`) predicts a silhouette per
 * query, `decodeRfDetr` traces it in the tile's frame, and it arrives here
 * already in units of `r` — so this function only has to pass it on.
 *
 * `outline` therefore stays undefined for the detection configs and for any
 * detection whose mask was empty, and every consumer must still handle its
 * absence. SW-08's editor writes the same shape when a climber re-traces a hold
 * by hand.
 */
export function toHoldCandidates(detections: readonly Detection[]): HoldCandidate[] {
  return detections.map((detection) => {
    const [x0, y0, x1, y1] = detection.box;
    const width = Math.max(0, x1 - x0);
    const height = Math.max(0, y1 - y0);
    const candidate: HoldCandidate = {
      cx: (x0 + x1) / 2,
      cy: (y0 + y1) / 2,
      r: Math.sqrt((width * height) / Math.PI),
      score: detection.score,
    };
    if (detection.outline) candidate.outline = detection.outline;
    return candidate;
  });
}
