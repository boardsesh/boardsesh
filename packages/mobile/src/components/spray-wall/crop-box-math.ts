// How a crop box moves under a finger, as one pure function (the photo step's
// "Crop or rotate", `SprayCropMarker`).
//
// It runs on the UI thread, once per frame of a drag, which is why it is a
// worklet and why it allocates nothing but its answer. It is unit-agnostic: the
// marker feeds it fractions of the photo (bounds 1 x 1), and a test can feed it
// pixels — the rules are the same either way.
//
// The rules:
//  - an edge handle moves its own edge, a corner moves its two, `move` moves the
//    whole box without changing its size;
//  - no edge leaves the photo;
//  - no edge comes closer to its opposite than the minimum, so the box can never
//    turn inside out or shrink to a sliver — it stops, rather than pushing the
//    other edge along.

export type CropEdges = { left: number; top: number; right: number; bottom: number };

export type CropHandle =
  | 'topLeft'
  | 'top'
  | 'topRight'
  | 'right'
  | 'bottomRight'
  | 'bottom'
  | 'bottomLeft'
  | 'left'
  | 'move';

/**
 * The eight resize handles in the order the marker draws them: edges first, so
 * on a small box, where a corner's touch target overlaps an edge's, the corner
 * is on top and wins.
 */
export const CROP_RESIZE_HANDLES = [
  'top',
  'right',
  'bottom',
  'left',
  'topLeft',
  'topRight',
  'bottomRight',
  'bottomLeft',
] as const satisfies readonly CropHandle[];

/**
 * The box after dragging `handle` by (dx, dy) from where it was when the finger
 * landed.
 *
 * Always from the START of the drag, never from the previous frame: a frame-by-
 * frame accumulation drifts when a clamp eats part of a step, and the box would
 * creep away from the finger.
 */
export function dragCropEdges(
  start: CropEdges,
  handle: CropHandle,
  dx: number,
  dy: number,
  bounds: { width: number; height: number },
  min: { width: number; height: number },
): CropEdges {
  'worklet';
  // A minimum larger than the photo is the whole photo.
  const minWidth = Math.min(min.width, bounds.width);
  const minHeight = Math.min(min.height, bounds.height);

  if (handle === 'move') {
    const width = start.right - start.left;
    const height = start.bottom - start.top;
    const left = Math.min(bounds.width - width, Math.max(0, start.left + dx));
    const top = Math.min(bounds.height - height, Math.max(0, start.top + dy));
    return { left, top, right: left + width, bottom: top + height };
  }

  let { left, top, right, bottom } = start;
  const movesLeft = handle === 'left' || handle === 'topLeft' || handle === 'bottomLeft';
  const movesRight = handle === 'right' || handle === 'topRight' || handle === 'bottomRight';
  const movesTop = handle === 'top' || handle === 'topLeft' || handle === 'topRight';
  const movesBottom = handle === 'bottom' || handle === 'bottomLeft' || handle === 'bottomRight';

  if (movesLeft) left = Math.min(start.right - minWidth, Math.max(0, start.left + dx));
  if (movesRight) right = Math.max(start.left + minWidth, Math.min(bounds.width, start.right + dx));
  if (movesTop) top = Math.min(start.bottom - minHeight, Math.max(0, start.top + dy));
  if (movesBottom) bottom = Math.max(start.top + minHeight, Math.min(bounds.height, start.bottom + dy));

  return { left, top, right, bottom };
}
