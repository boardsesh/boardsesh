/**
 * The wall button's label fade while its frost follows the board's swap: the
 * higher of the two climbs' fades whenever the board shows a pair (a drag, a
 * swap running, a cancel easing back), and the climb on show's own fade at
 * rest. The frames name the pair by page, as the frost reads them.
 *
 * Pure and worklet-safe; `WallGlow` runs it on the UI thread per frame.
 */
import type { BoardSwapFrame } from './swap-look';

/** Each page's label fade: the climb on show, and its neighbours (null: no climb there to draw). */
export type SwapLabelFades = {
  centerPage: number;
  previous: number | null;
  current: number;
  next: number | null;
};

function fadeOnPage(page: number, fades: SwapLabelFades): number {
  'worklet';
  if (page === fades.centerPage) return fades.current;
  if (page === fades.centerPage - 1) return fades.previous ?? 0;
  if (page === fades.centerPage + 1) return fades.next ?? 0;
  // A page the app has not caught up with: the strongest it knows.
  return Math.max(fades.current, fades.previous ?? 0, fades.next ?? 0);
}

/** The fade a frame needs: no frame, the climb on show's. */
export function swapLabelFade(frame: BoardSwapFrame | null, fades: SwapLabelFades): number {
  'worklet';
  if (frame === null) return fades.current;
  const from = Math.round(frame[0]);
  const lean = frame[0] - from;
  const direction = lean > 0.01 ? 1 : lean < -0.01 ? -1 : 0;
  const own = fadeOnPage(from, fades);
  const resting = direction === 0 || (frame[1] >= 1 && frame[2] <= 0);
  return resting ? own : Math.max(own, fadeOnPage(from + direction, fades));
}
