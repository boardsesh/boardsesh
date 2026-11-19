/**
 * The wall swap on the PNG board: how the player changes climbs when it has no
 * GPU board (an older binary, no GPU, playback, the GPU switched off in
 * Settings › Board).
 *
 * Each PNG board is a whole picture: the photo, then one overlay with the veil
 * (the wash over the unlit wall, lit holes cut out of it), the LED covers and
 * the lit holds. The holds cannot be faded on their own: the veil is in the
 * same image, so the unlit wall would brighten. Instead the boards fade whole
 * over a bare wall (the same photo and veil with no climb on it). Wherever a
 * board is see-through, the bare wall shows the same unlit wall underneath, so
 * the wall stays the same pixels and only the lit holds change.
 *
 * The weights come from the GPU board's state machine (`wall-swap.ts`), so a
 * drag, a cancel, a catch, a reversal and a re-flick behave as they do there.
 * The difference is shared holds, lit the same way in both climbs: on a PNG
 * board they are in both pictures, so they show at the two boards' weights
 * added together. Where that sum falls below the frame's shared weight (never
 * below 40%, 100% under Reduce Motion), both boards are raised by the same
 * factor to meet it, which keeps shared holds from dipping and turns the swap
 * into a hand-over at the 40% level: the old climb leaves as the new one comes
 * up to 40%, then the new one rises to 100% on the swap's ease-out.
 *
 * Pure and worklet-safe; `SwipeBoardCarousel` reads it once per UI frame.
 */
import { shippedSwapFrame, type BoardSwapFrame } from './swap-look';

export type PngSwapLayers = {
  /** The page whose board is being left; at rest, the climb on show. */
  leavingPage: number;
  leavingOpacity: number;
  /** The page whose board is arriving: `leavingPage` plus 1 or minus 1, or `leavingPage` itself when nothing arrives. */
  arrivingPage: number;
  arrivingOpacity: number;
  /** 1 while any board above the bare wall is see-through, else 0, so a board at rest composites nothing extra. */
  bareWallOpacity: number;
};

/** An opacity this close to 1 is whole: rounding must not put the bare wall under a whole board. */
const WHOLE_SLACK = 1e-6;

function unit(value: number, fallback: number): number {
  'worklet';
  if (!Number.isFinite(value)) return fallback;
  return value > 0 ? (value < 1 ? value : 1) : 0;
}

/**
 * The opacities of the boards for one swap frame.
 *
 * `wholeWall` keeps the boards adding up to a whole board: no drag dim, and the
 * swap is a dissolve. It is on under Reduce Motion (as the GPU board's own
 * frames already ask) and while the bare wall has not painted, when a
 * see-through board would show the drawer behind it.
 *
 * `restPage` is the page to show when the frame's page position is not a
 * number (the pager's middle page).
 *
 * The pair is read back from the page position (`wallSwapPagePosition`): the
 * nearest page is the climb being left, and the side it leans to holds the
 * arriving one. That holds while the lean is under half a page.
 *
 * Boards are drawn in page order, the higher page on top. The top board shows
 * its holds at its own opacity; the board under it shows through what the top
 * one leaves, so its opacity is divided by that share to land on its weight.
 */
export function pngSwapLayers(frame: BoardSwapFrame, wholeWall: boolean, restPage: number): PngSwapLayers {
  'worklet';
  const shipped = shippedSwapFrame(frame);
  const position = shipped[0];
  // `+ 0` turns the -0 that rounds -0.25 into a plain 0.
  const leavingPage = Number.isFinite(position) ? Math.round(position) + 0 : restPage;
  const direction = !Number.isFinite(position) ? 0 : position > leavingPage ? 1 : position < leavingPage ? -1 : 0;
  const arrivingPage = leavingPage + direction;
  const outgoing = unit(shipped[1], 1);
  const incoming = direction === 0 ? 0 : unit(shipped[2], 0);
  const shared = wholeWall ? 1 : unit(shipped[3], 1);

  // Both boards together never show shared holds dimmer than the frame asks.
  const total = outgoing + incoming;
  let leavingWeight = outgoing;
  let arrivingWeight = incoming;
  if (total < shared) {
    if (total > 0) {
      leavingWeight = (outgoing * shared) / total;
      arrivingWeight = (incoming * shared) / total;
    } else {
      leavingWeight = shared;
      arrivingWeight = 0;
    }
  }

  if (direction === 0) {
    const opacity = leavingWeight >= 1 - WHOLE_SLACK ? 1 : leavingWeight;
    return {
      leavingPage,
      leavingOpacity: opacity,
      arrivingPage,
      arrivingOpacity: opacity,
      bareWallOpacity: opacity < 1 ? 1 : 0,
    };
  }
  const topWeight = direction > 0 ? arrivingWeight : leavingWeight;
  const bottomWeight = direction > 0 ? leavingWeight : arrivingWeight;
  const topOpacity = topWeight >= 1 - WHOLE_SLACK ? 1 : topWeight;
  const uncovered = 1 - topOpacity;
  // Hidden under a whole top board; whole once it fills what the top one leaves.
  const bottomOpacity =
    topOpacity >= 1 || bottomWeight <= 0 ? 0 : bottomWeight >= uncovered - WHOLE_SLACK ? 1 : bottomWeight / uncovered;
  return {
    leavingPage,
    leavingOpacity: direction > 0 ? bottomOpacity : topOpacity,
    arrivingPage,
    arrivingOpacity: direction > 0 ? topOpacity : bottomOpacity,
    bareWallOpacity: topOpacity >= 1 || bottomOpacity >= 1 ? 0 : 1,
  };
}

/** One board's opacity in `layers`; 0 for a page that is not in the pair. */
export function pngSwapPageOpacity(layers: PngSwapLayers, page: number): number {
  'worklet';
  if (page === layers.leavingPage) return layers.leavingOpacity;
  return page === layers.arrivingPage ? layers.arrivingOpacity : 0;
}

/**
 * Whether the boards may go see-through over the bare wall this frame. Only
 * while it has painted (`ready`), and taken up only from rest, where a board is
 * whole whichever way it is drawn: picked up mid-drag, the board would jump
 * from whole to its dim. Dropped at once when it stops being ready.
 */
export function pngBareWallUsable(ready: boolean, wasUsable: boolean, frame: BoardSwapFrame): boolean {
  'worklet';
  if (!ready) return false;
  if (wasUsable) return true;
  const position = frame[0];
  return position === Math.round(position) && frame[1] >= 1;
}
